/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GraphCacheConfig } from './graphCacheTypes.js';

/**
 * Default configuration for graph cache
 */
export const DEFAULT_GRAPH_CACHE_CONFIG: GraphCacheConfig = {
	// Cache size limits
	maxCacheSize: 100, // Maximum cache entries
	maxMemoryMB: 100, // Maximum memory usage (MB)

	// Cache behavior
	enableIncrementalUpdates: true, // Enable incremental updates
	enablePersistence: true, // Enable disk persistence
	persistencePath: undefined, // Use default persistence path

	// Invalidation
	invalidationStrategy: 'lazy', // Lazy invalidation (on access)
	maxInvalidationBatchSize: 50, // Batch invalidation limit

	// Performance
	enableBackgroundWarming: false, // Pre-warm frequently used graphs (disabled by default)
	enableParallelBuilding: true, // Parallel graph building

	// Advanced
	merkleHashGranularity: 'file', // File-level granularity (can be 'chunk' for finer control)
	enableSubgraphCaching: false, // Cache subgraphs independently (disabled by default)
};

/**
 * Cache version - increment when cache schema changes
 */
export const GRAPH_CACHE_VERSION = 1;

/**
 * Storage keys for persistent cache
 */
export const STORAGE_KEYS = {
	GRAPH_CACHE: 'graphCache',
	GRAPH_CACHE_METADATA: 'graphCacheMetadata',
	GRAPH_CACHE_STATS: 'graphCacheStats',
} as const;

