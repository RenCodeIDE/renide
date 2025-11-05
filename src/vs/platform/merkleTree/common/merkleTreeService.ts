/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import { createDecorator } from "../../instantiation/common/instantiation.js";
import {
	MerkleTreeNode,
	MerkleTreeSnapshot,
	MerkleTreeChange,
} from "./merkleTreeTypes.js";

// Re-export types for convenience
export type {
	MerkleTreeNode,
	MerkleTreeSnapshot,
	MerkleTreeChange,
} from "./merkleTreeTypes.js";

export const IMerkleTreeService =
	createDecorator<IMerkleTreeService>("merkleTreeService");

export interface IMerkleTreeService {
	readonly _serviceBrand: undefined;

	readonly rootHash: string;
	readonly onDidChangeTree: Event<{ oldHash: string; newHash: string }>;

	/**
	 * Get the full tree structure
	 */
	getTree(): Promise<MerkleTreeNode>;

	/**
	 * Get the hash of a subtree (directory and all its contents)
	 */
	getSubtreeHash(uri: URI): Promise<string | undefined>;

	/**
	 * Get the hash of a specific file path
	 */
	getPathHash(relativePath: string): Promise<string | undefined>;

	/**
	 * Get change log since a specific timestamp
	 */
	getChangeLog(since?: number): MerkleTreeChange[];

	/**
	 * Get a snapshot of the tree at a specific version
	 */
	getSnapshot(version?: number): Promise<MerkleTreeSnapshot>;

	/**
	 * Force a full rebuild of the tree
	 */
	forceRebuild(): Promise<void>;

	/**
	 * Invalidate a specific path (mark as dirty for recalculation)
	 */
	invalidatePath(uri: URI): Promise<void>;

	/**
	 * Ensure a file is tracked (for lazy tracking)
	 */
	ensureTracked(uri: URI): Promise<void>;

	/**
	 * Get repository size category
	 */
	getRepoSizeCategory(): "small" | "medium" | "large" | "massive";

	/**
	 * Get chunk hashes for a specific file
	 */
	getFileChunks(
		relativePath: string
	): Promise<import("./merkleTreeTypes.js").FileChunk[] | undefined>;

	/**
	 * Compare chunks between two versions of a file and return which chunks changed
	 */
	getChangedChunks(
		relativePath: string,
		oldChunks?: import("./merkleTreeTypes.js").FileChunk[]
	): Promise<{
		changed: number[]; // Array of chunk indices that changed
		unchanged: number[]; // Array of chunk indices that didn't change
	}>;
}
