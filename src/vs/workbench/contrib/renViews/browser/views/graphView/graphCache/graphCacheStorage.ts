/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import type { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import type { ILogService } from '../../../../../../../platform/log/common/log.js';
import type {
	CachedGraph,
	GraphCacheKey,
	CacheStatistics,
	SerializedCachedGraph,
} from './graphCacheTypes.js';
import { STORAGE_KEYS } from './graphCacheConfig.js';
import { cacheKeyToString } from './graphCacheKey.js';

/**
 * LRU Cache implementation for in-memory storage
 */
class LRUCache<K, V> {
	private cache = new Map<K, { value: V; timestamp: number }>();
	private readonly maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (entry) {
			// Update timestamp (move to end)
			this.cache.delete(key);
			this.cache.set(key, { ...entry, timestamp: Date.now() });
			return entry.value;
		}
		return undefined;
	}

	set(key: K, value: V): void {
		// Remove if exists
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}

		// Add new entry
		this.cache.set(key, { value, timestamp: Date.now() });

		// Evict oldest if over limit
		if (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
	}

	has(key: K): boolean {
		return this.cache.has(key);
	}

	delete(key: K): void {
		this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}

	entries(): IterableIterator<[K, V]> {
		const entries: Array<[K, V]> = [];
		for (const [key, entry] of Array.from(this.cache.entries())) {
			entries.push([key, entry.value]);
		}
		return entries[Symbol.iterator]();
	}
}

/**
 * In-memory and persistent storage for graph cache
 */
export class GraphCacheStorage extends Disposable {
	private readonly cache: LRUCache<string, CachedGraph>;
	private readonly uriIndex: Map<string, Set<string>>; // uri -> Set<cacheKeys>
	private readonly merkleIndex: Map<string, Set<string>>; // merkleHash -> Set<cacheKeys>
	private readonly stats: CacheStatistics;

	constructor(
		private readonly storageService: IStorageService,
		private readonly logService: ILogService,
		maxCacheSize: number
	) {
		super();
		this.cache = new LRUCache(maxCacheSize);
		this.uriIndex = new Map();
		this.merkleIndex = new Map();
		this.stats = {
			totalRequests: 0,
			cacheHits: 0,
			cacheMisses: 0,
			hitRate: 0,
			averageHitLatency: 0,
			averageMissLatency: 0,
			speedupFactor: 0,
			incrementalUpdates: 0,
			fullRebuilds: 0,
			incrementalUpdateRate: 0,
			cacheSize: 0,
			memoryUsageMB: 0,
			diskUsageMB: 0,
			invalidations: 0,
			affectedGraphs: 0,
		};

		// Load from persistent storage
		this.load();
	}

	/**
	 * Get cached graph by key
	 */
	async get(key: GraphCacheKey): Promise<CachedGraph | undefined> {
		const startTime = Date.now();
		const keyString = await cacheKeyToString(key);

		const cached = this.cache.get(keyString);
		if (cached) {
			const latency = Date.now() - startTime;
			this.stats.cacheHits++;
			this.stats.totalRequests++;
			this.updateHitRate();
			this.updateAverageLatency(latency, true);
			return cached;
		}

		// Try loading from persistent storage
		const persisted = await this.loadFromPersistent(keyString);
		if (persisted) {
			const latency = Date.now() - startTime;
			this.cache.set(keyString, persisted);
			this.indexGraph(keyString, persisted);
			this.stats.cacheHits++;
			this.stats.totalRequests++;
			this.updateHitRate();
			this.updateAverageLatency(latency, true);
			return persisted;
		}

		const latency = Date.now() - startTime;
		this.stats.cacheMisses++;
		this.stats.totalRequests++;
		this.updateHitRate();
		this.updateAverageLatency(latency, false);
		return undefined;
	}

	/**
	 * Store graph in cache
	 */
	async set(key: GraphCacheKey, graph: CachedGraph): Promise<void> {
		const keyString = await cacheKeyToString(key);
		this.cache.set(keyString, graph);
		this.indexGraph(keyString, graph);

		// Persist to storage
		if (this.storageService) {
			await this.saveToPersistent(keyString, graph);
		}
	}

	/**
	 * Delete cached graph
	 */
	async delete(key: GraphCacheKey): Promise<void> {
		const keyString = await cacheKeyToString(key);
		this.cache.delete(keyString);
		this.unindexGraph(keyString);
		await this.deleteFromPersistent(keyString);
	}

	/**
	 * Find cache keys affected by URI change
	 */
	getAffectedKeys(uri: string): Set<string> {
		return this.uriIndex.get(uri) || new Set();
	}

	/**
	 * Find cache keys by Merkle hash
	 */
	getKeysByMerkleHash(hash: string): Set<string> {
		return this.merkleIndex.get(hash) || new Set();
	}

	/**
	 * Clear all cache entries
	 */
	clear(): void {
		this.cache.clear();
		this.uriIndex.clear();
		this.merkleIndex.clear();
		this.stats.cacheSize = 0;
	}

	/**
	 * Get cache statistics
	 */
	getStats(): CacheStatistics {
		return {
			...this.stats,
			cacheSize: this.cache.size,
		};
	}

	/**
	 * Index graph for fast lookup
	 */
	private indexGraph(keyString: string, graph: CachedGraph): void {
		// Index by node paths (URIs)
		for (const node of graph.payload.nodes) {
			if (node.path) {
				if (!this.uriIndex.has(node.path)) {
					this.uriIndex.set(node.path, new Set());
				}
				this.uriIndex.get(node.path)!.add(keyString);
			}
		}

		// Index by Merkle root hash
		if (graph.merkleRootHash) {
			if (!this.merkleIndex.has(graph.merkleRootHash)) {
				this.merkleIndex.set(graph.merkleRootHash, new Set());
			}
			this.merkleIndex.get(graph.merkleRootHash)!.add(keyString);
		}
	}

	/**
	 * Remove graph from indexes
	 */
	private unindexGraph(keyString: string): void {
		// Remove from URI index
		for (const [uri, keys] of Array.from(this.uriIndex.entries())) {
			keys.delete(keyString);
			if (keys.size === 0) {
				this.uriIndex.delete(uri);
			}
		}

		// Remove from Merkle index
		for (const [hash, keys] of Array.from(this.merkleIndex.entries())) {
			keys.delete(keyString);
			if (keys.size === 0) {
				this.merkleIndex.delete(hash);
			}
		}
	}

	/**
	 * Load from persistent storage
	 */
	private async loadFromPersistent(keyString: string): Promise<CachedGraph | undefined> {
		try {
			const data = this.storageService.get(
				`${STORAGE_KEYS.GRAPH_CACHE}:${keyString}`,
				StorageScope.WORKSPACE
			);
			if (!data) {
				return undefined;
			}

			const serialized: SerializedCachedGraph = JSON.parse(data);
			return this.deserializeGraph(serialized);
		} catch (error) {
			this.logService.warn(`[GraphCache] Failed to load from persistent storage: ${error}`);
			return undefined;
		}
	}

	/**
	 * Save to persistent storage
	 */
	private async saveToPersistent(keyString: string, graph: CachedGraph): Promise<void> {
		try {
			const serialized = this.serializeGraph(graph);
			this.storageService.store(
				`${STORAGE_KEYS.GRAPH_CACHE}:${keyString}`,
				JSON.stringify(serialized),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (error) {
			this.logService.warn(`[GraphCache] Failed to save to persistent storage: ${error}`);
		}
	}

	/**
	 * Delete from persistent storage
	 */
	private async deleteFromPersistent(keyString: string): Promise<void> {
		try {
			this.storageService.remove(
				`${STORAGE_KEYS.GRAPH_CACHE}:${keyString}`,
				StorageScope.WORKSPACE
			);
		} catch (error) {
			this.logService.warn(`[GraphCache] Failed to delete from persistent storage: ${error}`);
		}
	}

	/**
	 * Load all from persistent storage on startup
	 */
	private load(): void {
		// Load metadata
		try {
			const metadata = this.storageService.get(
				STORAGE_KEYS.GRAPH_CACHE_METADATA,
				StorageScope.WORKSPACE
			);
			if (metadata) {
				// Restore metadata if needed
			}
		} catch (error) {
			this.logService.warn(`[GraphCache] Failed to load metadata: ${error}`);
		}
	}

	/**
	 * Serialize graph for storage
	 */
	private serializeGraph(graph: CachedGraph): SerializedCachedGraph {
		return {
			payload: graph.payload,
			cacheKey: graph.cacheKey,
			timestamp: graph.timestamp,
			merkleRootHash: graph.merkleRootHash,
			nodeHashes: graph.nodeHashes,
			edgeMetadata: graph.edgeMetadata,
			buildDuration: graph.buildDuration,
			nodeCount: graph.nodeCount,
			edgeCount: graph.edgeCount,
			isValid: graph.isValid,
			lastValidated: graph.lastValidated,
		};
	}

	/**
	 * Deserialize graph from storage
	 */
	private deserializeGraph(serialized: SerializedCachedGraph): CachedGraph {
		return {
			payload: serialized.payload,
			cacheKey: serialized.cacheKey,
			timestamp: serialized.timestamp,
			merkleRootHash: serialized.merkleRootHash,
			nodeHashes: serialized.nodeHashes,
			edgeMetadata: serialized.edgeMetadata,
			buildDuration: serialized.buildDuration,
			nodeCount: serialized.nodeCount,
			edgeCount: serialized.edgeCount,
			isValid: serialized.isValid,
			lastValidated: serialized.lastValidated,
		};
	}

	/**
	 * Update hit rate statistic
	 */
	private updateHitRate(): void {
		if (this.stats.totalRequests > 0) {
			this.stats.hitRate = this.stats.cacheHits / this.stats.totalRequests;
		}
	}

	/**
	 * Update average latency statistic
	 */
	private updateAverageLatency(latency: number, isHit: boolean): void {
		if (isHit) {
			const totalHits = this.stats.cacheHits;
			this.stats.averageHitLatency =
				(this.stats.averageHitLatency * (totalHits - 1) + latency) / totalHits;
		} else {
			const totalMisses = this.stats.cacheMisses;
			this.stats.averageMissLatency =
				(this.stats.averageMissLatency * (totalMisses - 1) + latency) / totalMisses;
		}

		if (this.stats.averageMissLatency > 0) {
			this.stats.speedupFactor = this.stats.averageMissLatency / Math.max(this.stats.averageHitLatency, 1);
		}
	}
}

