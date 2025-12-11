/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { env } from "../../../../../base/common/process.js";
import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { IProductService } from "../../../../../platform/product/common/productService.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import {
	ChunkVectorSearchResult,
	searchChunkVectors,
} from "./chunkVectorClient.js";
import { computeWorkspaceHashSync } from "./workspaceHash.js";

const ACCESS_TOKEN_KEY = "ren.auth.accessToken";

export interface ChunkSearchResult extends ChunkVectorSearchResult {}

export const IChunkSearchService = createDecorator<IChunkSearchService>(
	"renChunkSearchService"
);

export interface IChunkSearchService {
	readonly _serviceBrand: undefined;
	search(query: string, limit?: number): Promise<ChunkSearchResult[]>;
}

class ChunkSearchService extends Disposable implements IChunkSearchService {
	declare readonly _serviceBrand: undefined;

	private cachedServerAddress: string | undefined;
	private cachedProjectHash: string | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService
		private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	private getProjectHash(): string | undefined {
		if (this.cachedProjectHash) {
			return this.cachedProjectHash;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.logService.warn(
				"[ChunkSearchService] No workspace folders available for project hash"
			);
			return undefined;
		}

		const workspaceRoot = folders[0].uri;
		this.cachedProjectHash = computeWorkspaceHashSync(workspaceRoot);
		this.logService.debug(
			`[ChunkSearchService] Computed project hash: ${this.cachedProjectHash}`
		);

		return this.cachedProjectHash;
	}

	async search(query: string, limit = 5): Promise<ChunkSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) {
			throw new Error("Search query cannot be empty.");
		}

		const accessToken = await this.secretStorageService.get(ACCESS_TOKEN_KEY);
		if (!accessToken) {
			throw new Error(
				"Authentication token is missing. Please sign in to Ren."
			);
		}

		const serverAddress = await this.resolveServerAddress();
		if (!serverAddress) {
			throw new Error(
				"Ren server address is not configured. Set SERVER_ADDRESS or update Ren settings."
			);
		}

		const projectHash = this.getProjectHash();
		if (!projectHash) {
			throw new Error(
				"No workspace folder available. Please open a workspace to search."
			);
		}

		const cappedLimit = Math.max(1, Math.min(25, Math.floor(limit)));

		this.logService.trace(
			`[ChunkSearchService] Searching chunks (query="${trimmed}", limit=${cappedLimit}, projectHash=${projectHash})`
		);

		return searchChunkVectors(
			{
				requestService: this.requestService,
				serverAddress,
				accessToken,
				logService: this.logService,
			},
			{
				query: trimmed,
				projectHash,
				limit: cappedLimit,
			}
		);
	}

	private async resolveServerAddress(): Promise<string | undefined> {
		if (this.cachedServerAddress) {
			return this.cachedServerAddress;
		}

		const envAddress = env["SERVER_ADDRESS"];
		if (envAddress && typeof envAddress === "string") {
			const trimmed = envAddress.trim();
			if (!trimmed) {
				this.logService.trace(
					"[ChunkSearchService] SERVER_ADDRESS is empty; trying product service."
				);
			} else {
				let normalized = trimmed;
				if (
					!normalized.startsWith("http://") &&
					!normalized.startsWith("https://")
				) {
					normalized = `https://${normalized}`;
				}
				this.cachedServerAddress = normalized.replace(/\/+$/, "");
				return this.cachedServerAddress;
			}
		}

		const apiBaseUrl = this.productService.renAccount?.apiBaseUrl;
		if (apiBaseUrl && typeof apiBaseUrl === "string") {
			const trimmed = apiBaseUrl.trim();
			if (trimmed) {
				this.cachedServerAddress = trimmed.replace(/\/+$/, "");
				return this.cachedServerAddress;
			}
		}

		this.logService.trace(
			"[ChunkSearchService] Server address not resolved; vector search disabled."
		);
		return undefined;
	}
}

registerSingleton(
	IChunkSearchService,
	ChunkSearchService,
	InstantiationType.Delayed
);
