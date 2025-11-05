/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import type { GraphCacheKey } from './graphCacheTypes.js';
import { GRAPH_CACHE_VERSION } from './graphCacheConfig.js';

/**
 * Generate a cache key for a graph based on scope and options
 * Note: merkleRootHash is stored in the cache key metadata but not used for key matching
 * This allows us to find old cache entries and do incremental updates when the root hash changes
 */
export function generateCacheKey(
	scopeId: string,
	scopeMode: 'folder' | 'workspace' | 'architecture',
	scopeRoots: URI[],
	options: Record<string, unknown> = {},
	merkleRootHash?: string
): GraphCacheKey {
	// Normalize scope roots to strings
	const rootStrings = scopeRoots.map((uri) => uri.toString()).sort();

	return {
		scopeId,
		scopeMode,
		scopeRoots: rootStrings,
		options: normalizeOptions(options),
		merkleRootHash, // Stored for reference, but not used in key matching
		version: GRAPH_CACHE_VERSION,
	};
}

/**
 * Normalize options for consistent cache key generation
 */
function normalizeOptions(options: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};

	// Sort keys for consistent ordering
	const sortedKeys = Object.keys(options).sort();

	for (const key of sortedKeys) {
		const value = options[key];
		if (value !== undefined && value !== null) {
			// Normalize arrays by sorting
			if (Array.isArray(value)) {
				normalized[key] = [...value].sort();
			} else {
				normalized[key] = value;
			}
		}
	}

	return normalized;
}

/**
 * Generate a string key from a GraphCacheKey for use in Maps/Sets
 * Note: We exclude merkleRootHash from the key string so that cache entries
 * can be found even when the root hash changes (for incremental updates)
 */
export async function cacheKeyToString(key: GraphCacheKey): Promise<string> {
	const parts = [
		key.scopeId,
		key.scopeMode,
		...key.scopeRoots,
		// Note: merkleRootHash is NOT included in the key string
		// This allows finding old cache entries when root hash changes
		JSON.stringify(key.options),
		key.version.toString(),
	];

	const keyString = parts.join('|');
	// Use hash for shorter keys
	return hashString(keyString);
}

/**
 * Hash a string using SHA256
 */
async function hashString(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);

	// Try Node.js crypto first (for server-side)
	if (typeof process !== 'undefined' && process.versions && process.versions.node) {
		try {
			const nodeCrypto = await import('crypto');
			return nodeCrypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
		} catch {
			// Fall through to web crypto
		}
	}

	// Use Web Crypto API (for browser)
	if (typeof crypto !== 'undefined' && crypto.subtle) {
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
	}

	// Fallback: simple hash
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36).substring(0, 32);
}

/**
 * Compare two cache keys for equality
 */
export function cacheKeysEqual(key1: GraphCacheKey, key2: GraphCacheKey): boolean {
	return (
		key1.scopeId === key2.scopeId &&
		key1.scopeMode === key2.scopeMode &&
		key1.version === key2.version &&
		key1.merkleRootHash === key2.merkleRootHash &&
		JSON.stringify(key1.options) === JSON.stringify(key2.options) &&
		JSON.stringify(key1.scopeRoots.sort()) === JSON.stringify(key2.scopeRoots.sort())
	);
}

