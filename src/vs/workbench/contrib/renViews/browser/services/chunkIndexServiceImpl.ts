/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import { IChunkIndexService, ChunkRecord } from "./chunkIndexService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../platform/storage/common/storage.js";
import { URI } from "../../../../../base/common/uri.js";

const STORAGE_KEY_INDEX = "ren.docs.chunkIndex";
const STORAGE_KEY_FILE_MAP = "ren.docs.fileToChunks";

function getChunkId(uri: URI, hash: string): string {
	return `${uri.toString()}#${hash}`;
}

export class ChunkIndexService
	extends Disposable
	implements IChunkIndexService
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private index: Map<string, ChunkRecord> = new Map();
	private fileToChunks: Map<string, Set<string>> = new Map();

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();
		this.loadFromStorage();
	}

	private loadFromStorage(): void {
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

		try {
			const indexData = JSON.parse(indexJson);
			const fileMapData = JSON.parse(fileMapJson);

			// Restore index
			for (const [chunkId, record] of Object.entries(indexData)) {
				if (record && typeof record === "object") {
					const rec = record as any;
					this.index.set(chunkId, {
						uri: URI.parse(rec.uri),
						hash: rec.hash,
						parentHash: rec.parentHash,
						children: rec.children || undefined,
						description: rec.description,
						refs: {
							symbols: (rec.refs?.symbols || []).map((s: any) => ({
								name: s.name,
								kind: s.kind,
								uri: URI.parse(s.uri),
								range: s.range,
							})),
							files: (rec.refs?.files || []).map((f: string) => URI.parse(f)),
							functions: (rec.refs?.functions || []).map((f: any) => ({
								name: f.name,
								uri: URI.parse(f.uri),
								range: f.range,
								signature: f.signature,
							})),
						},
						range: rec.range,
						updatedAt: rec.updatedAt || Date.now(),
					});
				}
			}

			// Restore file mapping
			for (const [fileUri, chunkIds] of Object.entries(fileMapData)) {
				if (Array.isArray(chunkIds)) {
					this.fileToChunks.set(fileUri, new Set(chunkIds));
				}
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
				fileMapData[fileUri] = Array.from(chunkIds);
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
		return chunks.sort(
			(a, b) =>
				(a.range?.startLineNumber || 0) - (b.range?.startLineNumber || 0)
		);
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
		const chunkId = getChunkId(record.uri, record.hash);
		const fileUri = record.uri.toString();

		this.index.set(chunkId, { ...record, updatedAt: Date.now() });

		if (!this.fileToChunks.has(fileUri)) {
			this.fileToChunks.set(fileUri, new Set());
		}
		this.fileToChunks.get(fileUri)!.add(chunkId);

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
		return chunks.sort(
			(a, b) =>
				(a.range?.startLineNumber || 0) - (b.range?.startLineNumber || 0)
		);
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
}

registerSingleton(
	IChunkIndexService,
	ChunkIndexService,
	InstantiationType.Delayed
);
