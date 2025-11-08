/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { relativePath } from "../../../../../base/common/resources.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import { IInstantiationService } from "../../../../../platform/instantiation/common/instantiation.js";
import { IChunkIndexService, ChunkRecord } from "./chunkIndexService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../platform/storage/common/storage.js";
import { URI } from "../../../../../base/common/uri.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { DEFAULT_CONFIG } from "../../../../../platform/merkleTree/common/merkleTreeConstants.js";
import { ChunkVectorSyncCoordinator } from "./chunkVectorSync.js";

export function formatChunkIdentifier(
	workspaceId: string,
	relativePath: string,
	ordinal: number
): string {
	const safeEncode = (value: string): string => encodeURIComponent(value);
	const safeOrdinal = Math.max(0, Math.floor(ordinal));
	return `${safeEncode(workspaceId)}:${safeEncode(
		relativePath
	)}:${safeOrdinal}`;
}

const STORAGE_KEY_INDEX = "ren.docs.chunkIndex";
const STORAGE_KEY_FILE_MAP = "ren.docs.fileToChunks";

export class ChunkIndexService
	extends Disposable
	implements IChunkIndexService
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private index: Map<string, ChunkRecord> = new Map();
	private fileToChunks: Map<string, Set<string>> = new Map();
	private readonly vectorSync: ChunkVectorSyncCoordinator | null;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();
		this.vectorSync = this._register(
			instantiationService.createInstance(ChunkVectorSyncCoordinator)
		);
		this.loadFromStorage();
	}

	private loadFromStorage(): void {
		try {
			this.index.clear();
			this.fileToChunks.clear();

			const indexJson = this.storageService.get(
				STORAGE_KEY_INDEX,
				StorageScope.WORKSPACE,
				"{}"
			);
			const fileMapJson = this.storageService.get(
				STORAGE_KEY_FILE_MAP,
				StorageScope.WORKSPACE,
				"{}"
			);

			const indexData: Record<string, unknown> =
				typeof indexJson === "string" ? JSON.parse(indexJson) : {};
			const fileMapData: Record<string, unknown> =
				typeof fileMapJson === "string" ? JSON.parse(fileMapJson) : {};

			for (const [legacyChunkId, rawRecord] of Object.entries(indexData)) {
				if (!rawRecord || typeof rawRecord !== "object") {
					continue;
				}

				const hydrated = this.normalizeRecord(
					this.hydrateRecord(
						rawRecord as Record<string, unknown>,
						legacyChunkId,
						fileMapData
					)
				);
				const chunkId = this.buildChunkId(hydrated);

				this.index.set(chunkId, hydrated);
				this.ensureFileChunkSet(hydrated.uri.toString()).add(chunkId);
			}
		} catch (e) {
			console.error("[ChunkIndexService] Failed to load from storage:", e);
		}
	}

	private saveToStorage(): void {
		try {
			const indexData: Record<string, any> = {};
			for (const [chunkId, record] of this.index.entries()) {
				indexData[chunkId] = {
					uri: record.uri.toString(),
					hash: record.hash,
					parentHash: record.parentHash,
					children: record.children,
					description: record.description,
					ordinal: record.ordinal,
					refs: {
						symbols: record.refs.symbols.map((s) => ({
							name: s.name,
							kind: s.kind,
							uri: s.uri.toString(),
							range: s.range,
						})),
						files: record.refs.files.map((f) => f.toString()),
						functions: record.refs.functions.map((f) => ({
							name: f.name,
							uri: f.uri.toString(),
							range: f.range,
							signature: f.signature,
						})),
					},
					range: record.range,
					updatedAt: record.updatedAt,
				};
			}

			const fileMapData: Record<string, string[]> = {};
			for (const [fileUri, chunkIds] of this.fileToChunks.entries()) {
				const sortedChunkIds = Array.from(chunkIds).sort((a, b) => {
					const aOrdinal = this.index.get(a)?.ordinal ?? 0;
					const bOrdinal = this.index.get(b)?.ordinal ?? 0;
					return aOrdinal - bOrdinal;
				});
				fileMapData[fileUri] = sortedChunkIds;
			}

			this.storageService.store(
				STORAGE_KEY_INDEX,
				JSON.stringify(indexData),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			this.storageService.store(
				STORAGE_KEY_FILE_MAP,
				JSON.stringify(fileMapData),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error("[ChunkIndexService] Failed to save to storage:", e);
		}
	}

	async getChunksForFile(uri: URI): Promise<ChunkRecord[]> {
		const fileUri = uri.toString();
		const chunkIds = this.fileToChunks.get(fileUri);
		if (!chunkIds) {
			return [];
		}

		const chunks: ChunkRecord[] = [];
		for (const chunkId of chunkIds) {
			const chunk = this.index.get(chunkId);
			if (chunk) {
				chunks.push(chunk);
			}
		}
		return chunks.sort((a, b) => {
			if (a.ordinal !== b.ordinal) {
				return a.ordinal - b.ordinal;
			}
			const aStart = a.range?.startLineNumber ?? 0;
			const bStart = b.range?.startLineNumber ?? 0;
			return aStart - bStart;
		});
	}

	getChunk(chunkId: string): ChunkRecord | undefined {
		return this.index.get(chunkId);
	}

	getChildren(chunkId: string): ChunkRecord[] {
		const chunk = this.index.get(chunkId);
		if (!chunk || !chunk.children || chunk.children.length === 0) {
			return [];
		}

		const children: ChunkRecord[] = [];
		for (const childHash of chunk.children) {
			// Find chunk by hash (need to search through all chunks)
			for (const [, record] of this.index.entries()) {
				if (record.hash === childHash) {
					children.push(record);
					break;
				}
			}
		}
		return children;
	}

	getParent(chunkId: string): ChunkRecord | undefined {
		const chunk = this.index.get(chunkId);
		if (!chunk || !chunk.parentHash) {
			return undefined;
		}

		// Find parent by hash
		for (const [, record] of this.index.entries()) {
			if (record.hash === chunk.parentHash) {
				return record;
			}
		}
		return undefined;
	}

	async upsertChunk(record: ChunkRecord): Promise<void> {
		const normalized = this.normalizeRecord(record);
		const workspaceMeta = this.getWorkspaceMetadata(normalized.uri);
		const chunkId = this.buildChunkId(normalized, workspaceMeta);
		const fileUri = normalized.uri.toString();

		this.index.set(chunkId, { ...normalized, updatedAt: Date.now() });
		this.ensureFileChunkSet(fileUri).add(chunkId);

		this.vectorSync?.enqueue(
			normalized,
			chunkId,
			workspaceMeta.relativePath,
			workspaceMeta.workspaceId
		);

		this.saveToStorage();
		this._onDidChange.fire();
	}

	async addChild(parentChunkId: string, childChunkId: string): Promise<void> {
		const parent = this.index.get(parentChunkId);
		const child = this.index.get(childChunkId);

		if (!parent || !child) {
			throw new Error("Parent or child chunk not found");
		}

		if (!parent.children) {
			parent.children = [];
		}

		if (!parent.children.includes(child.hash)) {
			parent.children.push(child.hash);
			this.saveToStorage();
			this._onDidChange.fire();
		}
	}

	listFileChunks(uri: URI): ChunkRecord[] {
		const fileUri = uri.toString();
		const chunkIds = this.fileToChunks.get(fileUri);
		if (!chunkIds) {
			return [];
		}

		const chunks: ChunkRecord[] = [];
		for (const chunkId of chunkIds) {
			const chunk = this.index.get(chunkId);
			if (chunk) {
				chunks.push(chunk);
			}
		}
		return chunks.sort((a, b) => {
			if (a.ordinal !== b.ordinal) {
				return a.ordinal - b.ordinal;
			}
			const aStart = a.range?.startLineNumber ?? 0;
			const bStart = b.range?.startLineNumber ?? 0;
			return aStart - bStart;
		});
	}

	async removeChunksForFile(uri: URI): Promise<void> {
		const fileUri = uri.toString();
		const chunkIds = this.fileToChunks.get(fileUri);
		if (!chunkIds) {
			return;
		}

		for (const chunkId of chunkIds) {
			this.index.delete(chunkId);
		}
		this.fileToChunks.delete(fileUri);

		this.saveToStorage();
		this._onDidChange.fire();
	}

	private hydrateRecord(
		raw: Record<string, unknown>,
		legacyChunkId: string,
		legacyFileMap: Record<string, unknown>
	): ChunkRecord {
		const rawAny = raw as any;

		const uriString =
			typeof rawAny?.uri === "string" ? rawAny.uri : String(rawAny?.uri ?? "");
		const uri = URI.parse(uriString);
		const fileUri = uri.toString();

		const rawRefs = rawAny?.refs;
		const refsSymbols = Array.isArray(rawRefs?.symbols)
			? (rawRefs.symbols as unknown[])
					.map((s) => this.mapSymbolRef(s))
					.filter(Boolean)
			: [];
		const refsFiles = Array.isArray(rawRefs?.files)
			? (rawRefs.files as unknown[])
					.map((f) => this.safeParseUri(f))
					.filter((uri): uri is URI => Boolean(uri))
			: [];
		const refsFunctions = Array.isArray(rawRefs?.functions)
			? (rawRefs.functions as unknown[])
					.map((f) => this.mapFunctionPointer(f))
					.filter(Boolean)
			: [];

		const children =
			Array.isArray(rawAny?.children) && rawAny.children.length > 0
				? [...(rawAny.children as string[])]
				: undefined;
		const description =
			typeof rawAny?.description === "string" ? rawAny.description : undefined;
		const parentHash =
			typeof rawAny?.parentHash === "string" ? rawAny.parentHash : undefined;
		const updatedAt =
			typeof rawAny?.updatedAt === "number" && Number.isFinite(rawAny.updatedAt)
				? rawAny.updatedAt
				: Date.now();
		const existingOrdinal =
			typeof rawAny?.ordinal === "number" && Number.isFinite(rawAny.ordinal)
				? rawAny.ordinal
				: undefined;

		const ordinal = this.resolveOrdinal(
			existingOrdinal,
			rawAny?.range,
			fileUri,
			legacyChunkId,
			legacyFileMap
		);

		return {
			uri,
			hash:
				typeof rawAny?.hash === "string"
					? rawAny.hash
					: String(rawAny?.hash ?? ""),
			parentHash,
			children,
			description,
			ordinal,
			refs: {
				symbols: refsSymbols as ChunkRecord["refs"]["symbols"],
				files: refsFiles as ChunkRecord["refs"]["files"],
				functions: refsFunctions as ChunkRecord["refs"]["functions"],
			},
			range: rawAny?.range as ChunkRecord["range"],
			updatedAt,
		};
	}

	private mapSymbolRef(
		entry: unknown
	): ChunkRecord["refs"]["symbols"][number] | undefined {
		if (!entry || typeof entry !== "object") {
			return undefined;
		}
		const symbol = entry as Record<string, unknown>;
		const uri = this.safeParseUri(symbol.uri);
		if (!uri) {
			return undefined;
		}
		return {
			name: typeof symbol.name === "string" ? symbol.name : "",
			kind: typeof symbol.kind === "string" ? symbol.kind : "",
			uri,
			range: symbol.range as any,
		};
	}

	private mapFunctionPointer(
		entry: unknown
	): ChunkRecord["refs"]["functions"][number] | undefined {
		if (!entry || typeof entry !== "object") {
			return undefined;
		}
		const fn = entry as Record<string, unknown>;
		const uri = this.safeParseUri(fn.uri);
		if (!uri) {
			return undefined;
		}
		return {
			name: typeof fn.name === "string" ? fn.name : "",
			uri,
			range: fn.range as any,
			signature: typeof fn.signature === "string" ? fn.signature : undefined,
		};
	}

	private safeParseUri(value: unknown): URI | undefined {
		if (typeof value !== "string" || value.length === 0) {
			return undefined;
		}
		try {
			return URI.parse(value);
		} catch {
			return undefined;
		}
	}

	private resolveOrdinal(
		existing: number | undefined,
		range: unknown,
		fileUri: string,
		legacyChunkId: string,
		fileMapData: Record<string, unknown>
	): number {
		if (
			typeof existing === "number" &&
			Number.isFinite(existing) &&
			existing >= 0
		) {
			return Math.floor(existing);
		}

		const legacyEntry = fileMapData[fileUri];
		if (Array.isArray(legacyEntry)) {
			const idx = legacyEntry.indexOf(legacyChunkId);
			if (idx >= 0) {
				return idx;
			}
		}

		return this.computeOrdinalFromRange(range);
	}

	private computeOrdinalFromRange(range: unknown): number {
		const chunkSize = this.getChunkSizeLines();
		if (!range || typeof (range as any).startLineNumber !== "number") {
			return 0;
		}
		const startLineNumber = Math.max(
			0,
			Math.floor((range as any).startLineNumber) - 1
		);
		if (chunkSize <= 0) {
			return 0;
		}
		return Math.floor(startLineNumber / chunkSize);
	}

	private getChunkSizeLines(): number {
		const config = this.configurationService.getValue<{
			chunkSizeLines?: number;
		}>("merkleTree");
		const chunkSize =
			typeof config?.chunkSizeLines === "number"
				? config.chunkSizeLines
				: DEFAULT_CONFIG.chunkSizeLines;
		return chunkSize > 0
			? Math.floor(chunkSize)
			: DEFAULT_CONFIG.chunkSizeLines;
	}

	private normalizeRecord(record: ChunkRecord): ChunkRecord {
		const ordinal = this.ensureOrdinal(record);
		const updatedAt =
			typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
				? record.updatedAt
				: Date.now();
		return {
			...record,
			ordinal,
			updatedAt,
		};
	}

	private ensureOrdinal(
		record: Pick<ChunkRecord, "ordinal" | "range">
	): number {
		if (
			typeof record.ordinal === "number" &&
			Number.isFinite(record.ordinal) &&
			record.ordinal >= 0
		) {
			return Math.floor(record.ordinal);
		}
		return this.computeOrdinalFromRange(record.range);
	}

	private buildChunkId(
		record: ChunkRecord,
		workspaceMeta?: { workspaceId: string; relativePath: string }
	): string {
		const { workspaceId, relativePath } =
			workspaceMeta ?? this.getWorkspaceMetadata(record.uri);
		const ordinal = Math.max(0, Math.floor(record.ordinal));
		return formatChunkIdentifier(workspaceId, relativePath, ordinal);
	}

	private getWorkspaceMetadata(uri: URI): {
		workspaceId: string;
		relativePath: string;
	} {
		const workspace = this.workspaceService.getWorkspace();
		const workspaceId = workspace?.id ?? "workspace-default";
		const folder = this.workspaceService.getWorkspaceFolder(uri);

		let relative = "";

		if (folder) {
			const rel = relativePath(folder.uri, uri) ?? "";
			if (rel) {
				const sanitized = rel.replace(/\\/g, "/");
				if (workspace.folders.length > 1) {
					const prefix = folder.name || folder.uri.toString();
					relative = `${prefix}/${sanitized}`;
				} else {
					relative = sanitized;
				}
			}
		}

		if (!relative) {
			relative =
				uri.scheme === "file" ? uri.fsPath.replace(/\\/g, "/") : uri.toString();
		}

		if (!relative) {
			relative = "__root__";
		}

		return {
			workspaceId,
			relativePath: relative,
		};
	}
	private ensureFileChunkSet(fileUri: string): Set<string> {
		let set = this.fileToChunks.get(fileUri);
		if (!set) {
			set = new Set();
			this.fileToChunks.set(fileUri, set);
		}
		return set;
	}
}

registerSingleton(
	IChunkIndexService,
	ChunkIndexService,
	InstantiationType.Delayed
);
