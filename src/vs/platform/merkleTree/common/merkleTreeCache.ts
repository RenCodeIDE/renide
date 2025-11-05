/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { ILogService } from '../../log/common/log.js';
import { MerkleTreeNode, MerkleTreeSnapshot } from './merkleTreeTypes.js';
import { STORAGE_KEYS, DEFAULT_CONFIG } from './merkleTreeConstants.js';
import { RunOnceScheduler } from '../../../base/common/async.js';

/**
 * LRU Cache for Merkle tree nodes
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
			// Update timestamp (mark as recently used)
			entry.timestamp = Date.now();
			// Move to end (most recently used)
			this.cache.delete(key);
			this.cache.set(key, entry);
			return entry.value;
		}
		return undefined;
	}

	set(key: K, value: V): void {
		// Remove oldest entry if at capacity
		if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		this.cache.set(key, { value, timestamp: Date.now() });
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

	size(): number {
		return this.cache.size;
	}

	/**
	 * Evict entries older than the given timestamp
	 */
	evictOlderThan(timestamp: number): number {
		let evicted = 0;
		for (const [key, entry] of this.cache.entries()) {
			if (entry.timestamp < timestamp) {
				this.cache.delete(key);
				evicted++;
			}
		}
		return evicted;
	}
}

export class MerkleTreeCache extends Disposable {
	private readonly nodeCache: LRUCache<string, MerkleTreeNode>;
	private readonly subtreeCache: LRUCache<string, string>; // path -> hash
	private currentTree: MerkleTreeNode | undefined;
	private currentRootHash = '';
	private version = 0;
	private readonly snapshots: MerkleTreeSnapshot[] = [];
	private readonly maxSnapshots = 10;
	private readonly gcScheduler: RunOnceScheduler;
	private readonly persistScheduler: RunOnceScheduler;

	constructor(
		private readonly storageService: IStorageService,
		private readonly logService: ILogService,
		private readonly workspaceId: string,
		cacheSize: number = DEFAULT_CONFIG.cacheSize
	) {
		super();
		this.nodeCache = new LRUCache(cacheSize);
		this.subtreeCache = new LRUCache(cacheSize);

		// Garbage collection scheduler (evict unused nodes)
		this.gcScheduler = this._register(new RunOnceScheduler(() => this.garbageCollect(), DEFAULT_CONFIG.gcIntervalMs));

		// Persistence scheduler
		this.persistScheduler = this._register(new RunOnceScheduler(() => this.persist(), DEFAULT_CONFIG.persistIntervalMs));

		// Load from storage on startup
		this.load();
	}

	/**
	 * Get cached tree node by path
	 */
	getNode(path: string): MerkleTreeNode | undefined {
		return this.nodeCache.get(path);
	}

	/**
	 * Cache a tree node
	 */
	setNode(path: string, node: MerkleTreeNode): void {
		this.nodeCache.set(path, node);
	}

	/**
	 * Get cached subtree hash
	 */
	getSubtreeHash(path: string): string | undefined {
		return this.subtreeCache.get(path);
	}

	/**
	 * Cache subtree hash
	 */
	setSubtreeHash(path: string, hash: string): void {
		this.subtreeCache.set(path, hash);
	}

	/**
	 * Get or set the current tree
	 */
	getTree(): MerkleTreeNode | undefined {
		return this.currentTree;
	}

	setTree(tree: MerkleTreeNode, rootHash: string): void {
		this.currentTree = tree;
		this.currentRootHash = rootHash;
		this.version++;
		
		// Cache the tree
		this.cacheTreeRecursive(tree);

		// Schedule persistence
		this.persistScheduler.schedule();

		// Schedule GC
		if (!this.gcScheduler.isScheduled()) {
			this.gcScheduler.schedule();
		}
	}

	/**
	 * Cache tree nodes recursively
	 */
	private cacheTreeRecursive(node: MerkleTreeNode): void {
		this.nodeCache.set(node.path || 'root', node);
		
		if (node.children) {
			for (const child of node.children) {
				this.cacheTreeRecursive(child);
			}
		}
	}

	/**
	 * Get current root hash
	 */
	getRootHash(): string {
		return this.currentRootHash;
	}

	/**
	 * Get current version
	 */
	getVersion(): number {
		return this.version;
	}

	/**
	 * Create a snapshot
	 */
	createSnapshot(changeLog: any[]): MerkleTreeSnapshot {
		if (!this.currentTree) {
			throw new Error('No tree available to snapshot');
		}

		const snapshot: MerkleTreeSnapshot = {
			rootHash: this.currentRootHash,
			timestamp: Date.now(),
			version: this.version,
			tree: JSON.parse(JSON.stringify(this.currentTree)), // Deep copy
			changeLog: changeLog.slice(-DEFAULT_CONFIG.changeLogSize),
		};

		// Keep only last N snapshots
		this.snapshots.push(snapshot);
		if (this.snapshots.length > this.maxSnapshots) {
			this.snapshots.shift();
		}

		return snapshot;
	}

	/**
	 * Get snapshot by version
	 */
	getSnapshot(version?: number): MerkleTreeSnapshot | undefined {
		if (version === undefined) {
			return this.snapshots[this.snapshots.length - 1];
		}

		return this.snapshots.find(s => s.version === version);
	}

	/**
	 * Persist cache to storage
	 */
	private persist(): void {
		if (!this.currentTree) {
			return;
		}

		try {
			const snapshot = this.createSnapshot([]);
			const data = JSON.stringify({
				tree: snapshot.tree,
				rootHash: snapshot.rootHash,
				version: snapshot.version,
				timestamp: snapshot.timestamp,
			});

			this.storageService.store(
				`${STORAGE_KEYS.TREE}:${this.workspaceId}`,
				data,
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);

			this.storageService.store(
				`${STORAGE_KEYS.VERSION}:${this.workspaceId}`,
				this.version.toString(),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);

			this.logService.debug(`[MerkleTree] Persisted tree to storage (version ${this.version})`);
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error persisting tree: ${error}`);
		}
	}

	/**
	 * Load cache from storage
	 */
	private load(): void {
		try {
			const treeData = this.storageService.get(
				`${STORAGE_KEYS.TREE}:${this.workspaceId}`,
				StorageScope.WORKSPACE
			);

			if (treeData) {
				const data = JSON.parse(treeData);
				this.currentTree = data.tree as MerkleTreeNode;
				this.currentRootHash = data.rootHash as string;
				this.version = data.version || 0;

				// Cache the loaded tree
				if (this.currentTree) {
					this.cacheTreeRecursive(this.currentTree);
				}

				this.logService.info(`[MerkleTree] Loaded tree from storage (version ${this.version})`);
			}
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error loading tree from storage: ${error}`);
		}
	}

	/**
	 * Garbage collect unused nodes
	 */
	private garbageCollect(): void {
		const cutoffTime = Date.now() - DEFAULT_CONFIG.gcIntervalMs;
		const evicted = this.nodeCache.evictOlderThan(cutoffTime);
		
		if (evicted > 0) {
			this.logService.debug(`[MerkleTree] Garbage collected ${evicted} unused nodes`);
		}
	}

	/**
	 * Clear all caches
	 */
	clear(): void {
		this.nodeCache.clear();
		this.subtreeCache.clear();
		this.currentTree = undefined;
		this.currentRootHash = '';
		this.snapshots.length = 0;
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { nodeCount: number; subtreeCount: number; version: number } {
		return {
			nodeCount: this.nodeCache.size(),
			subtreeCount: this.subtreeCache.size(),
			version: this.version,
		};
	}
}

