/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import type { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import type { ILogService } from '../../../../../../../platform/log/common/log.js';
import type { IMerkleTreeService } from '../../../../../../../platform/merkleTree/common/merkleTreeService.js';
import type { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import type {
	GraphCacheKey,
	CachedGraph,
	GraphChange,
	CacheStatistics,
	CacheScope,
	GraphCacheConfig,
	EdgeCacheMetadata,
} from './graphCacheTypes.js';
import type { GraphWebviewPayload, GraphNodePayload } from '../graphTypes.js';
import { GraphCacheStorage } from './graphCacheStorage.js';
import { GraphChangeTracker } from './graphChangeTracker.js';
import { DEFAULT_GRAPH_CACHE_CONFIG, GRAPH_CACHE_VERSION } from './graphCacheConfig.js';

/**
 * Main manager for graph caching operations
 */
export class GraphCacheManager extends Disposable {
	private readonly storage: GraphCacheStorage;
	private readonly changeTracker: GraphChangeTracker;
	private readonly config: GraphCacheConfig;
	private readonly logService: ILogService;

	constructor(
		private readonly merkleTreeService: IMerkleTreeService,
		storageService: IStorageService,
		logService: ILogService,
		private readonly workspaceService: IWorkspaceContextService | undefined,
		config: Partial<GraphCacheConfig> = {}
	) {
		super();
		this.logService = logService;
		this.config = { ...DEFAULT_GRAPH_CACHE_CONFIG, ...config };
		this.storage = new GraphCacheStorage(
			storageService,
			logService,
			this.config.maxCacheSize
		);
		this.changeTracker = new GraphChangeTracker();

		// Log Merkle tree status
		const rootHash = this.merkleTreeService.rootHash;
		this.logService.info(
			`[GraphCache] Initialized. Merkle root hash: ${rootHash || '(empty - tree not yet built)'}`
		);

		// Listen to Merkle tree changes for invalidation
		// Note: We use lazy invalidation by default - graphs are validated on access
		// This allows incremental updates when possible
		this._register(
			this.merkleTreeService.onDidChangeTree(({ oldHash, newHash }: { oldHash: string; newHash: string }) => {
				this.logService.info(
					`[GraphCache] Merkle tree changed: ${oldHash.substring(0, 8)}... → ${newHash.substring(0, 8)}...`
				);
				if (this.config.invalidationStrategy === 'immediate') {
					this.invalidateByMerkleHash(oldHash).catch((error) => {
						this.logService.error(`[GraphCache] Error invalidating cache: ${error}`);
					});
				}
				// For lazy/on-demand strategy, we validate on access (in getCachedGraph)
			})
		);
	}

	/**
	 * Get cached graph by key, with automatic incremental updates if needed
	 */
	async getCachedGraph(cacheKey: GraphCacheKey): Promise<CachedGraph | undefined> {
		const currentRootHash = this.merkleTreeService.rootHash;
		this.logService.debug(
			`[GraphCache] Getting cached graph. Current Merkle root: ${currentRootHash || '(empty)'}`
		);

		const cached = await this.storage.get(cacheKey);

		if (!cached) {
			return undefined;
		}

		// Check if graph needs updates (node-level hash changes)
		const needsUpdate = await this.checkNeedsUpdate(cached);
		
		if (needsUpdate.needsFullRebuild) {
			// Root hash changed or too many changes - invalidate
			await this.storage.delete(cacheKey);
			return undefined;
		}

		if (needsUpdate.changes.length > 0 && this.config.enableIncrementalUpdates) {
			// Try incremental update
			try {
				const updated = await this.updateGraphIncremental(cacheKey, needsUpdate.changes);
				// Return updated graph wrapped in CachedGraph
				return {
					...cached,
					payload: updated,
					merkleRootHash: this.merkleTreeService.rootHash,
					lastValidated: Date.now(),
				};
			} catch (error) {
				this.logService.warn(`[GraphCache] Incremental update failed, invalidating: ${error}`);
				await this.storage.delete(cacheKey);
				return undefined;
			}
		}

		// Graph is still valid
		return cached;
	}

	/**
	 * Store graph in cache
	 */
	async storeGraph(cacheKey: GraphCacheKey, graph: GraphWebviewPayload): Promise<void> {
		const buildStartTime = Date.now();
		const buildDuration = Date.now() - buildStartTime;

		// Get current Merkle root hash
		const merkleRootHash = this.merkleTreeService.rootHash;

		// Build node hashes map
		const nodeHashes: Record<string, string> = {};
		for (const node of graph.nodes) {
			const hash = await this.getNodeHash(node);
			if (hash) {
				nodeHashes[node.id] = hash;
			}
		}

		// Build edge metadata map
		const edgeMetadata: Record<string, EdgeCacheMetadata> = {};
		for (const edge of graph.edges) {
			const sourceHash = nodeHashes[edge.source];
			const targetHash = nodeHashes[edge.target];
			if (sourceHash && targetHash) {
				const edgeHash = this.changeTracker.computeEdgeHash({
					sourceHash,
					targetHash,
					specifier: edge.specifier,
					symbols: edge.symbols || [],
					kind: edge.kind,
				});
				edgeMetadata[edge.id] = {
					sourceHash,
					targetHash,
					edgeHash,
					lastModified: Date.now(),
				};
			}
		}

		const cachedGraph: CachedGraph = {
			payload: graph,
			cacheKey,
			timestamp: Date.now(),
			merkleRootHash,
			nodeHashes,
			edgeMetadata,
			buildDuration,
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			isValid: true,
			lastValidated: Date.now(),
		};

		await this.storage.set(cacheKey, cachedGraph);
	}

	/**
	 * Invalidate cache for a specific URI
	 */
	async invalidateGraph(uri: URI): Promise<void> {
		const uriString = uri.toString();
		const affectedKeys = this.storage.getAffectedKeys(uriString);

		this.storage.getStats().invalidations++;
		this.storage.getStats().affectedGraphs += affectedKeys.size;

		// Invalidate affected cache entries
		// For now, we'll delete the entries
		// In the future, we could try incremental updates
		// This would require loading the key from storage, which we'd need to store
		// For simplicity, we'll just delete for now
		// Note: We could iterate and delete here, but the cache will be invalidated on next access
	}

	/**
	 * Invalidate cache entries by Merkle hash
	 */
	private async invalidateByMerkleHash(hash: string): Promise<void> {
		const affectedKeys = this.storage.getKeysByMerkleHash(hash);
		// Similar to invalidateGraph, delete affected entries
		this.storage.getStats().invalidations++;
		this.storage.getStats().affectedGraphs += Array.from(affectedKeys).length;
	}

	/**
	 * Update graph incrementally with changes
	 * This rebuilds only the changed nodes and updates their connections
	 */
	async updateGraphIncremental(
		cacheKey: GraphCacheKey,
		changes: GraphChange[]
	): Promise<GraphWebviewPayload> {
		// Get the cached graph (bypassing validation to get the old one)
		const cached = await this.storage.get(cacheKey);
		if (!cached) {
			throw new Error('Cannot update: graph not found in cache');
		}

		// Check if incremental update is possible
		if (!this.changeTracker.canUpdateIncrementally(changes)) {
			// Need full rebuild
			await this.storage.delete(cacheKey);
			throw new Error('Incremental update not possible, requires full rebuild');
		}

		// For now, apply changes to the graph structure
		// In a full implementation, we'd re-parse only the changed files
		let updatedPayload = this.changeTracker.applyChanges(cached, changes);

		// Update node hashes for changed nodes
		const updatedNodeHashes = { ...cached.nodeHashes };
		for (const change of changes) {
			if (change.type === 'node-updated') {
				const node = updatedPayload.nodes.find(n => n.id === change.nodeId);
				if (node) {
					const hash = await this.getNodeHash(node);
					if (hash) {
						updatedNodeHashes[node.id] = hash;
					}
				}
			} else if (change.type === 'node-added') {
				const node = change.node;
				if (node) {
					const hash = await this.getNodeHash(node);
					if (hash) {
						updatedNodeHashes[node.id] = hash;
					}
				}
			} else if (change.type === 'node-removed') {
				delete updatedNodeHashes[change.nodeId];
			}
		}

		// Update edge metadata for affected edges
		const updatedEdgeMetadata = { ...cached.edgeMetadata };
		for (const edge of updatedPayload.edges) {
			const sourceHash = updatedNodeHashes[edge.source];
			const targetHash = updatedNodeHashes[edge.target];
			if (sourceHash && targetHash) {
				const edgeHash = this.changeTracker.computeEdgeHash({
					sourceHash,
					targetHash,
					specifier: edge.specifier,
					symbols: edge.symbols || [],
					kind: edge.kind,
				});
				updatedEdgeMetadata[edge.id] = {
					sourceHash,
					targetHash,
					edgeHash,
					lastModified: Date.now(),
				};
			}
		}

		// Create updated cached graph
		const updatedCached: CachedGraph = {
			...cached,
			payload: updatedPayload,
			merkleRootHash: this.merkleTreeService.rootHash,
			nodeHashes: updatedNodeHashes,
			edgeMetadata: updatedEdgeMetadata,
			nodeCount: updatedPayload.nodes.length,
			edgeCount: updatedPayload.edges.length,
			lastValidated: Date.now(),
		};

		// Store updated graph
		await this.storage.set(cacheKey, updatedCached);

		this.storage.getStats().incrementalUpdates++;

		return updatedPayload;
	}

	/**
	 * Clear cache entries
	 */
	async clearCache(scope?: CacheScope): Promise<void> {
		if (scope) {
			// Clear specific scope (would need to iterate and check keys)
			// For now, clear all
			this.storage.clear();
		} else {
			this.storage.clear();
		}
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): CacheStatistics {
		return this.storage.getStats();
	}

	/**
	 * Check if cached graph needs updates and what changes are needed
	 */
	private async checkNeedsUpdate(cached: CachedGraph): Promise<{
		needsFullRebuild: boolean;
		changes: GraphChange[];
	}> {
		// Check cache version
		if (cached.cacheKey.version !== GRAPH_CACHE_VERSION) {
			return { needsFullRebuild: true, changes: [] };
		}

		// Check Merkle root hash
		const currentRootHash = this.merkleTreeService.rootHash;
		if (cached.merkleRootHash !== currentRootHash) {
			// Root hash changed - check if we can do incremental update
			// Get current node hashes
			const currentNodeHashes = new Map<string, string>();
			for (const node of cached.payload.nodes) {
				const hash = await this.getNodeHash(node);
				if (hash) {
					currentNodeHashes.set(node.id, hash);
				}
			}

			// Compare with cached hashes
			const oldHashes = new Map<string, string>(Object.entries(cached.nodeHashes));
			const changes = this.changeTracker.detectChanges(oldHashes, currentNodeHashes);

			// If too many changes or structural changes, need full rebuild
			if (changes.length > 10 || changes.some(c => c.type === 'node-added' || c.type === 'node-removed')) {
				return { needsFullRebuild: true, changes: [] };
			}

			// Can do incremental update
			return { needsFullRebuild: false, changes };
		}

		// Root hash unchanged - graph is still valid
		return { needsFullRebuild: false, changes: [] };
	}

	/**
	 * Get Merkle hash for a graph node
	 */
	private async getNodeHash(node: GraphNodePayload): Promise<string | undefined> {
		if (node.kind === 'external') {
			// External nodes: hash the specifier consistently
			return this.hashString(node.path || node.label);
		}

		// File/directory nodes: use Merkle tree hash
		if (node.path) {
			try {
				const uri = URI.parse(node.path);
				if (this.config.merkleHashGranularity === 'chunk') {
					// For chunk-level granularity, we'd need to check chunks
					// For now, use file hash
					const relativePath = this.getRelativePath(uri);
					return await this.merkleTreeService.getPathHash(relativePath);
				} else {
					// File-level granularity
					const relativePath = this.getRelativePath(uri);
					return await this.merkleTreeService.getPathHash(relativePath);
				}
			} catch (error) {
				// Invalid URI, use simple hash
				return this.hashString(node.path);
			}
		}

		return undefined;
	}

	/**
	 * Get relative path from URI to workspace root
	 */
	private getRelativePath(uri: URI): string {
		if (!this.workspaceService) {
			// Fallback if workspace service not available
			return uri.fsPath;
		}

		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return uri.fsPath;
		}

		const rootPath = workspace.folders[0].uri.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, '');
		}

		return absolutePath;
	}

	/**
	 * Simple string hash
	 */
	private hashString(input: string): string {
		let hash = 0;
		for (let i = 0; i < input.length; i++) {
			const char = input.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}
}

