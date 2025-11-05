/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GRAPH_DEFAULT_EXCLUDE_GLOBS } from '../../../workbench/contrib/renViews/browser/views/graphView/graphConstants.js';

/**
 * Default exclude patterns for static directories that rarely change
 */
export const MERKLE_TREE_STATIC_DIRS = new Set([
	'node_modules',
	'.git',
	'.hg',
	'dist',
	'build',
	'out',
	'.next',
	'.turbo',
	'.vercel',
	'coverage',
	'tmp',
	'.cache',
	'.venv',
	'venv',
	'target',
	'.pytest_cache',
	'__pycache__',
	'.mypy_cache',
	'.ruff_cache',
	'.tox',
	'.eggs',
	'*.egg-info',
	'.idea',
	'.vscode',
	'.vs',
]);

/**
 * Repository size thresholds for strategy selection
 */
export const REPO_SIZE_THRESHOLDS = {
	SMALL: 10_000,      // < 10k files: full tree
	MEDIUM: 50_000,     // 10k-50k: sparse tree
	LARGE: 500_000,     // 50k-500k: directory-level hashing
	MASSIVE: 500_000,   // > 500k: ultra-sparse
} as const;

/**
 * Cache size limits based on repo size
 */
export const CACHE_SIZE_LIMITS = {
	SMALL: 10_000,
	MEDIUM: 50_000,
	LARGE: 100_000,
} as const;

/**
 * Memory limits in MB
 */
export const MEMORY_LIMITS = {
	DEFAULT: 100,        // Small repos
	MEDIUM: 500,        // Medium repos
	LARGE: 1000,        // Large repos (configurable)
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
	enabled: true,
	lazyTracking: true,
	excludeStaticDirs: true,
	cacheSize: CACHE_SIZE_LIMITS.SMALL,
	memoryLimitMB: MEMORY_LIMITS.DEFAULT,
	autoRebuild: true,
	changeLogSize: 1000,
	strategy: 'auto' as const,
	workerThreads: Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 1),
	backgroundExpansion: true,
	debounceMs: 100,
	gcIntervalMs: 5 * 60 * 1000, // 5 minutes
	persistIntervalMs: 30 * 1000, // 30 seconds
	chunkSizeLines: 200, // Number of lines per chunk for chunked hashing
	enableChunkedHashing: true, // Whether to use chunked hashing instead of whole-file hashing
} as const;

/**
 * Storage keys
 */
export const STORAGE_KEYS = {
	TREE: 'merkleTree:tree',
	VERSION: 'merkleTree:version',
	CHANGELOG: 'merkleTree:changelog',
} as const;

/**
 * Check if a path should be excluded based on static directory patterns
 */
export function isExcludedStaticDir(path: string): boolean {
	const segments = path.split(/[\\/]+/);
	return segments.some(segment => MERKLE_TREE_STATIC_DIRS.has(segment));
}

/**
 * Get exclude globs (combines graph defaults with static dirs)
 */
export function getExcludeGlobs(): Record<string, boolean> {
	return {
		...GRAPH_DEFAULT_EXCLUDE_GLOBS,
	};
}

