/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface FileChunk {
	startLine: number;              // Starting line number (0-based)
	endLine: number;                // Ending line number (exclusive)
	hash: string;                    // SHA256 hash of this chunk
	parentHash?: string;             // Hash of previous chunk (sequential ordering)
	content?: string;                // Optional: cached content (for small chunks)
}

export interface MerkleTreeNode {
	hash: string;                    // SHA256 hash
	path: string;                    // Relative path from workspace root
	type: 'file' | 'directory';       // Node type
	children?: MerkleTreeNode[];     // For directories
	fileHash?: string;               // Content hash for files (full file hash)
	chunks?: FileChunk[];            // Chunk hashes for files (200-line chunks)
	size?: number;                    // File size in bytes
	mtime?: number;                   // Modification time
	isTracked?: boolean;             // Whether this file is actively tracked (lazy tracking)
}

export interface MerkleTreeSnapshot {
	rootHash: string;
	timestamp: number;
	version: number;
	tree: MerkleTreeNode;
	changeLog: MerkleTreeChange[];  // For cache logging
}

export interface MerkleTreeChange {
	type: 'added' | 'deleted' | 'modified';
	path: string;
	oldHash?: string;
	newHash?: string;
	timestamp: number;
}

export interface MerkleTreeOptions {
	lazyTracking?: boolean;
	excludeStaticDirs?: boolean;
	strategy?: 'auto' | 'full' | 'sparse' | 'ultra-sparse';
	memoryLimitMB?: number;
	workerThreads?: number;
}

export type MerkleTreeStrategy = 'auto' | 'full' | 'sparse' | 'ultra-sparse';

