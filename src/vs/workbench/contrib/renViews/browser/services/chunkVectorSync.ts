/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { env } from "../../../../../base/common/process.js";
import { URI } from "../../../../../base/common/uri.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { ITextModelService } from "../../../../../editor/common/services/resolverService.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IProductService } from "../../../../../platform/product/common/productService.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { IRenAuthService } from "../../../../services/renAuth/common/renAuth.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../platform/storage/common/storage.js";
import { IDialogService } from "../../../../../platform/dialogs/common/dialogs.js";
import { localize } from "../../../../../nls.js";
import { ChunkRecord } from "./chunkIndexService.js";
import {
	ChunkVectorDependencyGraph,
	ChunkVectorDependencyRange,
	ChunkVectorUpsertPayload,
	upsertChunkVector,
} from "./chunkVectorClient.js";

const ACCESS_TOKEN_KEY = "ren.auth.accessToken";
const DEFAULT_DEBOUNCE_MS = 400;
const WORKSPACE_CONSENT_KEY = "ren.vectorization.consent";

interface PendingChunk {
	record: ChunkRecord;
	relativePath: string;
	workspaceId?: string;
}

interface PendingFlush {
	timer: ReturnType<typeof setTimeout> | null;
	chunks: Map<string, PendingChunk>;
}

export function computeChunkLineBounds(
	range: ChunkRecord["range"] | undefined
): { startLine: number; endLine: number } {
	const startLine = Math.max(0, (range?.startLineNumber ?? 1) - 1);
	const endSource = range?.endLineNumber
		? Math.max(0, range.endLineNumber - 1)
		: range?.startLineNumber
		? Math.max(0, range.startLineNumber - 1)
		: startLine;
	const endLine = Math.max(startLine, endSource);
	return { startLine, endLine };
}

export function buildChunkDependencyGraph(
	record: ChunkRecord
): ChunkVectorDependencyGraph {
	const toSerializableRange = (
		range: unknown
	): ChunkVectorDependencyRange | undefined => {
		if (!range || typeof range !== "object") {
			return undefined;
		}
		const serialize = (value: unknown): number | undefined => {
			return typeof value === "number" && Number.isFinite(value)
				? Math.max(0, Math.floor(value))
				: undefined;
		};
		const candidate = range as Partial<ChunkVectorDependencyRange>;
		return {
			startLineNumber: serialize(candidate.startLineNumber),
			startColumn: serialize(candidate.startColumn),
			endLineNumber: serialize(candidate.endLineNumber),
			endColumn: serialize(candidate.endColumn),
		};
	};

	const symbolEntries =
		record.refs?.symbols?.map((symbol) => ({
			name: symbol.name,
			kind: symbol.kind,
			uri: symbol.uri.toString(),
			range: toSerializableRange(symbol.range as any),
		})) ?? [];

	const functionEntries =
		record.refs?.functions?.map((fn) => ({
			name: fn.name,
			uri: fn.uri.toString(),
			signature: fn.signature,
			range: toSerializableRange(fn.range as any),
		})) ?? [];

	const fileSet = new Set<string>(
		record.refs?.files?.map((fileUri) => fileUri.toString()) ?? []
	);
	for (const symbol of symbolEntries) {
		if (symbol.uri) {
			fileSet.add(symbol.uri);
		}
	}
	for (const fn of functionEntries) {
		if (fn.uri) {
			fileSet.add(fn.uri);
		}
	}

	return {
		files: Array.from(fileSet),
		symbols: symbolEntries,
		functions: functionEntries,
	};
}

export class ChunkVectorSyncCoordinator extends Disposable {
	private readonly pendingByFile = new Map<string, PendingFlush>();
	private cachedServerAddress: string | undefined;
	private consentState: "accepted" | "declined" | undefined;
	private consentDeclineNotified = false;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService
		private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFileService private readonly fileService: IFileService,
		@IRenAuthService private readonly renAuthService: IRenAuthService,
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();
	}

	enqueue(
		record: ChunkRecord,
		chunkId: string,
		relativePath: string,
		workspaceId?: string
	): void {
		if (!this.isVectorizationEnabled()) {
			return;
		}

		const fileKey = record.uri.toString();
		let pending = this.pendingByFile.get(fileKey);
		if (!pending) {
			pending = { timer: null, chunks: new Map() };
			this.pendingByFile.set(fileKey, pending);
		}

		pending.chunks.set(chunkId, { record, relativePath, workspaceId });

		if (pending.timer) {
			clearTimeout(pending.timer);
		}

		pending.timer = setTimeout(() => {
			this.pendingByFile.delete(fileKey);
			const entries = Array.from(pending!.chunks.entries());
			void this.flushChunks(entries);
		}, this.getDebounceMs());
	}

	private async flushChunks(
		entries: Array<[string, PendingChunk]>
	): Promise<void> {
		for (const [chunkId, pending] of entries) {
			try {
				await this.syncChunk(
					chunkId,
					pending.record,
					pending.relativePath,
					pending.workspaceId
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "Unknown error");
				this.logService.error(
					`[ChunkVectorSync] Failed to sync chunk ${chunkId}: ${message}`
				);
			}
		}
	}

	private async syncChunk(
		chunkId: string,
		record: ChunkRecord,
		relativePath: string,
		workspaceId?: string
	): Promise<void> {
		if (!(await this.ensureWorkspaceConsent(relativePath))) {
			if (!this.consentDeclineNotified && this.consentState === "declined") {
				this.logService.info(
					"[ChunkVectorSync] Workspace consent declined; vector indexing remains disabled."
				);
				this.consentDeclineNotified = true;
			}
			return;
		}

		const accessToken = await this.secretStorageService.get(ACCESS_TOKEN_KEY);
		if (!accessToken) {
			this.logService.trace(
				`[ChunkVectorSync] Skipping chunk ${chunkId}: no access token.`
			);
			return;
		}

		const serverAddress = await this.resolveServerAddress();
		if (!serverAddress) {
			return;
		}

		const userName = this.renAuthService.currentUser?.username?.trim();
		if (!userName) {
			this.logService.trace(
				`[ChunkVectorSync] Skipping chunk ${chunkId}: user not authenticated.`
			);
			return;
		}

		const chunkText = await this.extractChunkText(record);
		if (!chunkText || !chunkText.trim()) {
			this.logService.trace(
				`[ChunkVectorSync] Skipping chunk ${chunkId}: empty chunk content.`
			);
			return;
		}

		const { startLine, endLine } = computeChunkLineBounds(record.range);

		const dependencyGraph = buildChunkDependencyGraph(record);

		const payload: ChunkVectorUpsertPayload = {
			code: chunkText,
			metadata: {
				chunkId,
				userName,
				filePath: relativePath,
				startLine,
				endLine,
				ordinal: Math.max(0, Math.floor(record.ordinal ?? 0)),
				merkleHash: record.hash,
				parentHash: record.parentHash,
			},
			dependencyGraph,
		};

		try {
			await upsertChunkVector(
				{
					requestService: this.requestService,
					serverAddress,
					accessToken,
					logService: this.logService,
				},
				payload
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "Unknown error");
			this.logService.error(
				`[ChunkVectorSync] Vector upsert failed for ${chunkId}: ${message}`
			);
			throw error;
		}
	}


	private async extractChunkText(record: ChunkRecord): Promise<string | undefined> {
		if (record.range) {
			try {
				const reference = await this.textModelService.createModelReference(
					record.uri
				);
				try {
					const model = reference.object.textEditorModel;
					const startLineNumber = record.range.startLineNumber ?? 1;
					const endLineNumber = Math.max(
						startLineNumber,
						record.range.endLineNumber ?? startLineNumber
					);
					const endColumn = model.getLineMaxColumn(endLineNumber);
					const range = new Range(
						startLineNumber,
						record.range.startColumn ?? 1,
						endLineNumber,
						endColumn
					);
					const value = model.getValueInRange(range);
					if (value && value.length > 0) {
						return value;
					}
				} finally {
					reference.dispose();
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "Unknown error");
				this.logService.debug(
					`[ChunkVectorSync] Failed to read model for ${record.uri.toString()}: ${message}`
				);
			}
		}

		return this.readFileRange(record.uri, record.range);
	}

	private async readFileRange(
		uri: URI,
		range?: ChunkRecord["range"]
	): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			if (!range) {
				return text;
			}
			const lines = text.split(/\r?\n/);
			const startIndex = Math.max(0, (range.startLineNumber ?? 1) - 1);
			const endIndex = Math.max(
				startIndex,
				(range.endLineNumber ?? range.startLineNumber ?? startIndex + 1) - 1
			);
			return lines.slice(startIndex, endIndex + 1).join("\n");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "Unknown error");
			this.logService.debug(
				`[ChunkVectorSync] Failed to read file fallback for ${uri.toString()}: ${message}`
			);
			return undefined;
		}
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
					"[ChunkVectorSync] SERVER_ADDRESS is empty; trying product service."
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
			"[ChunkVectorSync] Server address not configured; skipping vector sync."
		);
		return undefined;
	}

	private isVectorizationEnabled(): boolean {
		const enabled =
			this.configurationService.getValue<boolean>("ren.vectorization.enabled");
		return enabled === true;
	}

	private getDebounceMs(): number {
		const value =
			this.configurationService.getValue<number>("ren.vectorization.debounceMs");
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value;
		}
		return DEFAULT_DEBOUNCE_MS;
	}

	private async ensureWorkspaceConsent(samplePath: string): Promise<boolean> {
		if (this.consentState === "accepted") {
			return true;
		}
		if (this.consentState === "declined") {
			return false;
		}

		const stored = this.storageService.get(
			WORKSPACE_CONSENT_KEY,
			StorageScope.WORKSPACE
		);
		if (stored === "accepted" || stored === "declined") {
			this.consentState = stored;
			return stored === "accepted";
		}

		const detail = localize(
			"ren.vectorization.consent.detail",
			"Enabling chunk vector indexing sends code snippets from this workspace (for example, `{0}`) to Ren cloud services so that features like code search work. You can disable this later in settings.",
			samplePath
		);

		const result = await this.dialogService.confirm({
			type: "info",
			message: localize(
				"ren.vectorization.consent.title",
				"Enable chunk vector indexing?"
			),
			detail,
			primaryButton: localize(
				"ren.vectorization.consent.enable",
				"Enable"
			),
			cancelButton: localize(
				"ren.vectorization.consent.notNow",
				"Not now"
			),
		});

		this.consentState = result.confirmed ? "accepted" : "declined";
		this.storageService.store(
			WORKSPACE_CONSENT_KEY,
			this.consentState,
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
		return this.consentState === "accepted";
	}

	override dispose(): void {
		for (const pending of this.pendingByFile.values()) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
		}
		this.pendingByFile.clear();
		super.dispose();
	}
}

