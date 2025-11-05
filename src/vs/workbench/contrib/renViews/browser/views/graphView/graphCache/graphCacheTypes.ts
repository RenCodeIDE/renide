/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GraphWebviewPayload, GraphNodePayload, GraphEdgePayload, GraphEdgeKind } from '../graphTypes.js';

/**
 * Cache key for identifying cached graphs
 */
export interface GraphCacheKey {
	// Scope identifier
	scopeId: string; // Workspace/folder identifier
	scopeMode: 'folder' | 'workspace' | 'architecture';
	scopeRoots: string[]; // Root URIs for scope (serialized)

	// Graph generation options
	options: {
		includeExternal?: boolean;
		maxDepth?: number;
		filters?: string[];
		[key: string]: unknown;
	};

	// Merkle tree root hash (for validation)
	merkleRootHash?: string;

	// Cache version
	version: number; // Increments on cache schema changes
}

/**
 * Edge cache metadata
 */
export interface EdgeCacheMetadata {
	sourceHash: string; // Source node's Merkle hash
	targetHash: string; // Target node's Merkle hash
	edgeHash: string; // Hash of edge properties
	lastModified: number;
}

/**
 * Cached graph with metadata
 */
export interface CachedGraph {
	// Graph data
	payload: GraphWebviewPayload;

	// Cache metadata
	cacheKey: GraphCacheKey;
	timestamp: number; // When cached
	merkleRootHash: string; // Merkle root hash at cache time

	// Node-level Merkle hashes
	nodeHashes: Record<string, string>; // nodeId -> file/subtree hash

	// Edge-level metadata
	edgeMetadata: Record<string, EdgeCacheMetadata>;

	// Statistics
	buildDuration: number; // Time to build (ms)
	nodeCount: number;
	edgeCount: number;

	// Validation data
	isValid: boolean;
	lastValidated: number;
}

/**
 * Graph change types
 */
export type GraphChange =
	| { type: 'node-added'; node: GraphNodePayload }
	| { type: 'node-removed'; nodeId: string }
	| { type: 'node-updated'; nodeId: string; updates: Partial<GraphNodePayload> }
	| { type: 'edge-added'; edge: GraphEdgePayload }
	| { type: 'edge-removed'; edgeId: string }
	| { type: 'edge-updated'; edgeId: string; updates: Partial<GraphEdgePayload> }
	| {
			type: 'node-metadata-updated';
			nodeId: string;
			metadata: Record<string, unknown>;
	  };

/**
 * Cache statistics
 */
export interface CacheStatistics {
	// Hit/miss rates
	totalRequests: number;
	cacheHits: number;
	cacheMisses: number;
	hitRate: number; // hits / totalRequests

	// Performance
	averageHitLatency: number; // ms
	averageMissLatency: number; // ms
	speedupFactor: number; // missLatency / hitLatency

	// Incremental updates
	incrementalUpdates: number;
	fullRebuilds: number;
	incrementalUpdateRate: number; // incremental / total updates

	// Storage
	cacheSize: number; // Number of entries
	memoryUsageMB: number;
	diskUsageMB: number;

	// Invalidation
	invalidations: number;
	affectedGraphs: number;
}

/**
 * Cache scope for invalidation
 */
export interface CacheScope {
	scopeId?: string;
	scopeMode?: 'folder' | 'workspace' | 'architecture';
}

/**
 * Graph cache configuration
 */
export interface GraphCacheConfig {
	// Cache size limits
	maxCacheSize: number; // Maximum cache entries
	maxMemoryMB: number; // Maximum memory usage (MB)

	// Cache behavior
	enableIncrementalUpdates: boolean; // Enable incremental updates
	enablePersistence: boolean; // Enable disk persistence
	persistencePath?: string; // Custom persistence path

	// Invalidation
	invalidationStrategy: 'immediate' | 'lazy' | 'on-demand';
	maxInvalidationBatchSize: number; // Batch invalidation limit

	// Performance
	enableBackgroundWarming: boolean; // Pre-warm frequently used graphs
	enableParallelBuilding: boolean; // Parallel graph building

	// Advanced
	merkleHashGranularity: 'file' | 'chunk'; // Hash granularity
	enableSubgraphCaching: boolean; // Cache subgraphs independently
}

/**
 * Edge hash components for computing edge hashes
 */
export interface EdgeHashComponents {
	sourceHash: string; // Source node's Merkle hash
	targetHash: string; // Target node's Merkle hash
	specifier: string; // Import specifier
	symbols: string[]; // Sorted imported symbols
	kind: GraphEdgeKind; // Edge type
}

/**
 * Serialized cached graph for persistence
 */
export interface SerializedCachedGraph {
	payload: GraphWebviewPayload;
	cacheKey: GraphCacheKey;
	timestamp: number;
	merkleRootHash: string;
	nodeHashes: Record<string, string>;
	edgeMetadata: Record<string, EdgeCacheMetadata>;
	buildDuration: number;
	nodeCount: number;
	edgeCount: number;
	isValid: boolean;
	lastValidated: number;
}

/**
 * Persistent graph cache structure
 */
export interface PersistentGraphCache {
	// Cache entries
	entries: Record<string, SerializedCachedGraph>;

	// Metadata
	metadata: {
		version: number;
		lastCleanup: number;
		totalSize: number;
	};

	// Indexes (for fast lookup)
	indexes: {
		byScope: Record<string, string[]>; // scopeId -> cacheKeys
		byMerkleHash: Record<string, string[]>; // merkleHash -> cacheKeys
		byTimestamp: Array<{ key: string; timestamp: number }>;
	};
}

