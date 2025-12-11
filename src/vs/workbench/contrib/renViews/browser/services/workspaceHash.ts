/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../../../../base/common/uri.js";

/**
 * Generates a consistent hash for a workspace root path.
 * Used to uniquely identify projects for semantic search namespace isolation.
 *
 * The hash is:
 * - Deterministic: Same path always produces same hash
 * - Compact: First 16 characters of SHA-256 for readability
 * - Normalized: Uses fsPath for consistent cross-platform behavior
 */
export async function computeWorkspaceHash(workspaceUri: URI): Promise<string> {
	const path = workspaceUri.fsPath;

	// Use Web Crypto API for SHA-256 hashing
	const encoder = new TextEncoder();
	const data = encoder.encode(path);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);

	// Convert to hex string and take first 16 characters
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return hashHex.substring(0, 16);
}

/**
 * Synchronous version using a simple hash algorithm for cases where async is not suitable.
 * Uses djb2 hash algorithm - fast and produces good distribution.
 */
export function computeWorkspaceHashSync(workspaceUri: URI): string {
	const path = workspaceUri.fsPath;

	// djb2 hash algorithm
	let hash = 5381;
	for (let i = 0; i < path.length; i++) {
		hash = (hash << 5) + hash + path.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit integer
	}

	// Convert to positive hex string and pad to 16 chars
	const hashHex = Math.abs(hash).toString(16).padStart(8, "0");

	// Double the hash for more entropy (hash twice with offset)
	let hash2 = 5381;
	for (let i = 0; i < path.length; i++) {
		hash2 = (hash2 << 5) + hash2 + path.charCodeAt(path.length - 1 - i);
		hash2 = hash2 & hash2;
	}
	const hashHex2 = Math.abs(hash2).toString(16).padStart(8, "0");

	return hashHex + hashHex2;
}
