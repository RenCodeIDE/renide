/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { IChecksumService } from '../../checksum/common/checksumService.js';
import { ILogService } from '../../log/common/log.js';
import { MerkleTreeNode, FileChunk } from './merkleTreeTypes.js';
import { isExcludedStaticDir, REPO_SIZE_THRESHOLDS, DEFAULT_CONFIG } from './merkleTreeConstants.js';
import { join } from '../../../base/common/path.js';
import { GitIgnoreFilter } from './gitIgnoreFilter.js';

export interface MerkleTreeBuilderOptions {
	lazyTracking?: boolean;
	excludeStaticDirs?: boolean;
	strategy?: 'auto' | 'full' | 'sparse' | 'ultra-sparse';
	workspaceRoot: URI;
	chunkSizeLines?: number;
	enableChunkedHashing?: boolean;
}

export class MerkleTreeBuilder {
	private readonly trackedFiles = new Set<string>(); // Tracked file paths (for lazy tracking)
	private readonly fileHashes = new Map<string, string>(); // Cache of file hashes
	private readonly fileChunks = new Map<string, FileChunk[]>(); // Cache of file chunks
	private fileCount = 0;
	private readonly chunkSizeLines: number;
	private readonly enableChunkedHashing: boolean;
	private gitIgnoreFilter: { initialize(): Promise<void>; shouldIgnore(path: string, isDir: boolean): boolean } | undefined;
	private gitIgnoreInitPromise: Promise<void> | undefined;

	constructor(
		private readonly fileService: IFileService,
		private readonly checksumService: IChecksumService,
		private readonly logService: ILogService,
		private readonly options: MerkleTreeBuilderOptions
	) {
		this.chunkSizeLines = options.chunkSizeLines ?? DEFAULT_CONFIG.chunkSizeLines;
		this.enableChunkedHashing = options.enableChunkedHashing ?? DEFAULT_CONFIG.enableChunkedHashing;
	}

	private resetState(): void {
		this.trackedFiles.clear();
		this.fileHashes.clear();
		this.fileChunks.clear();
		this.fileCount = 0;
	}

	private async ensureGitIgnoreReady(): Promise<void> {
		if (!this.gitIgnoreFilter) {
			const workspacePath = this.options.workspaceRoot.fsPath;
			this.gitIgnoreFilter = new GitIgnoreFilter(workspacePath, this.logService);
			this.gitIgnoreInitPromise = this.gitIgnoreFilter
				.initialize()
				.catch((error) => {
					this.logService.warn(
							`[MerkleTree] Failed to load gitignore patterns for ${workspacePath}: ${String(error)}`
					);
					this.gitIgnoreFilter = undefined;
				});
		}

		if (this.gitIgnoreInitPromise) {
			try {
				await this.gitIgnoreInitPromise;
			} finally {
				this.gitIgnoreInitPromise = undefined;
			}
		}
	}

	private shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
		if (!relativePath) {
			return false;
		}
		if (relativePath.endsWith('.gitignore')) {
			return true;
		}
		if (this.options.excludeStaticDirs && isExcludedStaticDir(relativePath)) {
			return true;
		}
		return this.gitIgnoreFilter?.shouldIgnore(relativePath, isDirectory) ?? false;
	}

	private logHashEvent(
		type: 'file' | 'directory',
		relativePath: string,
		oldHash: string | undefined,
		newHash: string,
		wasExisting: boolean
	): void {
		const truncatedOld = oldHash ? `${oldHash.substring(0, 12)}...` : 'none';
		const truncatedNew = newHash ? `${newHash.substring(0, 12)}...` : 'none';

		if (!wasExisting) {
			this.logService.info(
				`[MerkleTree] Created ${type} hash for ${relativePath}: ${truncatedNew}`
			);
		} else if (oldHash !== newHash) {
			this.logService.info(
				`[MerkleTree] Updated ${type} hash for ${relativePath}: ${truncatedOld} → ${truncatedNew}`
			);
		} else {
			this.logService.debug(
				`[MerkleTree] ${type} hash unchanged for ${relativePath}: ${truncatedNew}`
			);
		}
	}

	/**
	 * Hash a string using SHA256
	 */
	private async hashString(input: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(input);
		
		// Try Node.js crypto first (for server-side)
		if (typeof process !== 'undefined' && process.versions && process.versions.node) {
			try {
				const nodeCrypto = await import('crypto');
				return nodeCrypto.createHash('sha256').update(data).digest('hex');
			} catch {
				// Fall through to web crypto
			}
		}
		
		// Use Web Crypto API (for browser)
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Build the initial tree structure
	 */
	async buildInitialTree(): Promise<MerkleTreeNode> {
		this.logService.info('[MerkleTree] Starting initial tree build...');
		return this.buildFullTree();
	}

	/**
	 * Build full tree (scan all files)
	 */
	private async buildFullTree(): Promise<MerkleTreeNode> {
		this.logService.info('[MerkleTree] Building full tree (scanning all files)');
		this.resetState();
		await this.ensureGitIgnoreReady();
		
		const rootNode: MerkleTreeNode = {
			hash: '',
			path: '',
			type: 'directory',
			children: [],
			workspaceId: this.options.workspaceRoot.toString(),
		};

		await this.buildTreeRecursive(this.options.workspaceRoot, rootNode, '');

		rootNode.hash = await this.hashDirectory(rootNode);
		this.logHashEvent('directory', '/', undefined, rootNode.hash, false);

		this.logService.info(`[MerkleTree] Full tree built with ${this.fileCount} files`);
		return rootNode;
	}

	async refreshExistingTree(tree: MerkleTreeNode): Promise<MerkleTreeNode> {
		this.logService.info('[MerkleTree] Refreshing existing Merkle tree with full rescan');
		this.resetState();
		await this.ensureGitIgnoreReady();

		const previousRootHash = tree.hash;
		tree.path = '';
		tree.type = 'directory';
		tree.workspaceId = this.options.workspaceRoot.toString();
		tree.children = tree.children ?? [];

		await this.refreshDirectory(this.options.workspaceRoot, tree, '');

		tree.hash = await this.hashDirectory(tree);
		this.logHashEvent(
			'directory',
			'/',
			previousRootHash,
			tree.hash,
			Boolean(previousRootHash)
		);

		this.logService.info(`[MerkleTree] Refresh complete with ${this.fileCount} files processed`);
		return tree;
	}

	private async refreshDirectory(uri: URI, node: MerkleTreeNode, relativePath: string): Promise<void> {
		try {
			const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
			const existingChildren = new Map<string, MerkleTreeNode>();
			if (node.children) {
				for (const existing of node.children) {
					existingChildren.set(existing.path, existing);
				}
			}

			const nextChildren: MerkleTreeNode[] = [];
			const workspaceId = this.options.workspaceRoot.toString();

			if (stat.isDirectory && stat.children) {
				for (const child of stat.children) {
					const childRelativePath = relativePath ? join(relativePath, child.name) : child.name;

					if (this.shouldIgnore(childRelativePath, !!child.isDirectory)) {
						this.logService.debug(
							`[MerkleTree] Skipping ignored ${child.isDirectory ? 'directory' : 'file'} ${childRelativePath}`
						);
						continue;
					}

					const existingNode = existingChildren.get(childRelativePath);

					if (child.isDirectory) {
						let dirNode: MerkleTreeNode;
						if (existingNode && existingNode.type !== 'directory') {
							this.logService.info(
								`[MerkleTree] Path ${childRelativePath} changed from ${existingNode.type} to directory`
							);
						}
						if (existingNode && existingNode.type === 'directory') {
							dirNode = existingNode;
							dirNode.children = dirNode.children ?? [];
							dirNode.workspaceId = workspaceId;
						} else {
							dirNode = {
								hash: '',
								path: childRelativePath,
								type: 'directory',
								children: [],
								workspaceId,
							};
						}

						nextChildren.push(dirNode);
						existingChildren.delete(childRelativePath);
						await this.refreshDirectory(child.resource, dirNode, childRelativePath);
					} else {
						let fileNode: MerkleTreeNode;
						let wasExisting = false;
						if (existingNode && existingNode.type === 'file') {
							fileNode = existingNode;
							wasExisting = true;
						} else {
							if (existingNode && existingNode.type === 'directory') {
								this.logService.info(
									`[MerkleTree] Path ${childRelativePath} changed from directory to file`
								);
							}
							fileNode = {
								hash: '',
								path: childRelativePath,
								type: 'file',
							};
						}

						existingChildren.delete(childRelativePath);

						const previousHash = wasExisting ? fileNode.hash : undefined;
						let fileHash: string;
						let chunks: FileChunk[] | undefined;

						if (this.enableChunkedHashing) {
							const result = await this.hashFileChunked(child.resource);
							fileHash = result.fileHash;
							chunks = result.chunks;
						} else {
							fileHash = await this.hashFile(child.resource);
						}

						fileNode.hash = fileHash;
						fileNode.fileHash = fileHash;
						fileNode.chunks = chunks;
						fileNode.size = child.size;
						fileNode.mtime = child.mtime;
						fileNode.isTracked = true;

						nextChildren.push(fileNode);
						this.fileCount++;
						this.trackedFiles.add(childRelativePath);
						this.fileHashes.set(childRelativePath, fileHash);
						if (chunks) {
							this.fileChunks.set(childRelativePath, chunks);
						}

						this.logHashEvent(
							'file',
							childRelativePath,
							previousHash,
							fileHash,
							wasExisting && previousHash !== undefined
						);
					}
				}
			}

			for (const [stalePath, staleNode] of existingChildren.entries()) {
				if (staleNode.type === 'file') {
					this.logService.info(`[MerkleTree] Removed file from Merkle tree: ${stalePath}`);
					this.trackedFiles.delete(stalePath);
					this.fileHashes.delete(stalePath);
					this.fileChunks.delete(stalePath);
				} else {
					this.logService.info(`[MerkleTree] Removed directory from Merkle tree: ${stalePath}`);
				}
			}

			nextChildren.sort((a, b) => a.path.localeCompare(b.path));
			node.children = nextChildren;

			const previousHash = node.hash;
			node.hash = await this.hashDirectory(node);
			if (relativePath) {
				this.logHashEvent(
					'directory',
					relativePath,
					previousHash,
					node.hash,
					Boolean(previousHash)
				);
			}
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error refreshing directory ${uri.fsPath}: ${error}`);
		}
	}

	/**
	 * Build tree recursively
	 */
	private async buildTreeRecursive(uri: URI, parentNode: MerkleTreeNode, relativePath: string): Promise<void> {
		try {
			const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
			
			if (stat.isDirectory && stat.children) {
				const parentPreviousHash = parentNode.hash;
				const workspaceId = this.options.workspaceRoot.toString();

				for (const child of stat.children) {
					const childRelativePath = relativePath ? join(relativePath, child.name) : child.name;

					// Skip ignored entries
					if (this.shouldIgnore(childRelativePath, !!child.isDirectory)) {
						this.logService.debug(
							`[MerkleTree] Skipping ignored ${child.isDirectory ? 'directory' : 'file'} ${childRelativePath}`
						);
						continue;
					}

					if (child.isDirectory) {
						const dirNode: MerkleTreeNode = {
							hash: '',
							path: childRelativePath,
							type: 'directory',
							children: [],
							workspaceId,
						};

						parentNode.children!.push(dirNode);
						await this.buildTreeRecursive(child.resource, dirNode, childRelativePath);
					} else {
						// File node
						const previousHash = this.fileHashes.get(childRelativePath);
						let fileHash: string;
						let chunks: FileChunk[] | undefined;

						if (this.enableChunkedHashing) {
							const result = await this.hashFileChunked(child.resource);
							fileHash = result.fileHash;
							chunks = result.chunks;
						} else {
							fileHash = await this.hashFile(child.resource);
						}

						const fileNode: MerkleTreeNode = {
							hash: fileHash,
							path: childRelativePath,
							type: 'file',
							fileHash: fileHash,
							chunks: chunks,
							size: child.size,
							mtime: child.mtime,
							isTracked: true,
						};

						parentNode.children!.push(fileNode);
						this.fileCount++;
						this.trackedFiles.add(childRelativePath);
						this.fileHashes.set(childRelativePath, fileHash);
						if (chunks) {
							this.fileChunks.set(childRelativePath, chunks);
						}
						this.logHashEvent(
							'file',
							childRelativePath,
							previousHash,
							fileHash,
							previousHash !== undefined
						);
					}
				}

				parentNode.children!.sort((a, b) => a.path.localeCompare(b.path));
				parentNode.hash = await this.hashDirectory(parentNode);
				if (relativePath) {
					this.logHashEvent(
						'directory',
						relativePath,
						parentPreviousHash,
						parentNode.hash,
						Boolean(parentPreviousHash)
					);
				}
			}
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error building tree for ${uri.fsPath}: ${error}`);
		}
	}

	/**
	 * Hash a file using ChecksumService (whole file hash)
	 */
	private async hashFile(uri: URI): Promise<string> {
		const relativePath = this.getRelativePath(uri.fsPath);
		
		// Check cache first
		if (this.fileHashes.has(relativePath)) {
			return this.fileHashes.get(relativePath)!;
		}

		try {
			const hash = await this.checksumService.checksum(uri);
			if (hash) {
				this.fileHashes.set(relativePath, hash);
				return hash;
			}
			// If checksum service returns empty, throw error
			throw new Error('Checksum service returned empty hash');
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error hashing file ${uri.fsPath}: ${error}`);
			// Re-throw to allow caller to handle the error appropriately
			throw error;
		}
	}

	/**
	 * Hash a file in chunks (200-line chunks by default)
	 * Returns array of chunk hashes and the combined file hash
	 */
	private async hashFileChunked(uri: URI): Promise<{ chunks: FileChunk[]; fileHash: string }> {
		const relativePath = this.getRelativePath(uri.fsPath);
		
		// Check cache first
		if (this.fileChunks.has(relativePath)) {
			const cachedChunks = this.fileChunks.get(relativePath)!;
			// Recompute file hash from chunks
			const fileHash = await this.hashStringFromChunks(cachedChunks);
			return { chunks: cachedChunks, fileHash };
		}

		try {
			// Read file content
			const fileContent = await this.fileService.readFile(uri);
			const content = fileContent.value.toString();
			const lines = content.split(/\r?\n/);
			
			const chunks: FileChunk[] = [];
			const totalLines = lines.length;
			
			// Create chunks of chunkSizeLines each
			let previousHash: string | undefined;
			for (let startLine = 0; startLine < totalLines; startLine += this.chunkSizeLines) {
				const endLine = Math.min(startLine + this.chunkSizeLines, totalLines);
				const chunkLines = lines.slice(startLine, endLine);
				const chunkContent = chunkLines.join('\n');
				
				// Hash this chunk
				const chunkHash = await this.hashString(chunkContent);
				
				chunks.push({
					startLine,
					endLine,
					hash: chunkHash,
					parentHash: previousHash, // Link to previous chunk
					content: chunkContent.length < 10000 ? chunkContent : undefined, // Cache small chunks
				});
				
				previousHash = chunkHash; // Set for next iteration
			}
			
			// Compute overall file hash from chunk hashes
			const fileHash = await this.hashStringFromChunks(chunks);
			
			// Cache the chunks
			this.fileChunks.set(relativePath, chunks);
			this.fileHashes.set(relativePath, fileHash);
			
			this.logService.debug(`[MerkleTree] Hashed file ${relativePath} into ${chunks.length} chunks`);
			
			return { chunks, fileHash };
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error hashing file chunks ${uri.fsPath}: ${error}`);
			// Fallback to whole-file hash
			const fileHash = await this.hashFile(uri);
			return { chunks: [], fileHash };
		}
	}

	/**
	 * Hash a string from chunk hashes (combines all chunk hashes)
	 */
	private async hashStringFromChunks(chunks: FileChunk[]): Promise<string> {
		if (chunks.length === 0) {
			return await this.hashString('empty');
		}
		
		// Combine all chunk hashes into a single hash
		const chunkHashes = chunks.map(chunk => `${chunk.startLine}-${chunk.endLine}:${chunk.hash}`).join('|');
		return await this.hashString(`chunks:${chunkHashes}`);
	}

	/**
	 * Hash a directory based on its children
	 */
	private async hashDirectory(node: MerkleTreeNode): Promise<string> {
		if (!node.children || node.children.length === 0) {
			return await this.hashString(`dir:${node.path}:empty`);
		}

		// Sort children by path for consistent hashing
		const sortedChildren = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
		
		// Build hash string: path + sorted child hashes
		const childHashes = sortedChildren.map(child => `${child.path}:${child.hash}`).join('|');
		const hashInput = `dir:${node.path}:${childHashes}`;
		
		return await this.hashString(hashInput);
	}

	/**
	 * Get relative path from workspace root
	 */
	private getRelativePath(absolutePath: string): string {
		const rootPath = this.options.workspaceRoot.fsPath;
		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, '');
		}
		return absolutePath;
	}

	/**
	 * Add a file to tracking (for lazy tracking)
	 */
	async trackFile(uri: URI): Promise<void> {
		const relativePath = this.getRelativePath(uri.fsPath);
		
		if (this.trackedFiles.has(relativePath)) {
			return; // Already tracked
		}

		// Check if excluded
		if (this.options.excludeStaticDirs && isExcludedStaticDir(relativePath)) {
			return;
		}

		try {
			if (this.enableChunkedHashing) {
				await this.hashFileChunked(uri);
			} else {
				await this.hashFile(uri);
			}
			this.trackedFiles.add(relativePath);
			this.fileCount++;
		} catch (error) {
			this.logService.warn(`[MerkleTree] Error tracking file ${uri.fsPath}: ${error}`);
		}
	}

	/**
	 * Update a file in the tree (incremental update)
	 */
	async updateFile(uri: URI, tree: MerkleTreeNode): Promise<{ updated: boolean; newHash: string }> {
		const relativePath = this.getRelativePath(uri.fsPath);
		
		// Check if file exists
		try {
			const stat = await this.fileService.stat(uri);
			if (!stat.isFile) {
				return { updated: false, newHash: tree.hash };
			}
		} catch {
			// File doesn't exist (might be deleted)
			// Remove from tree if it exists
			const fileNode = this.findNodeByPath(tree, relativePath);
			if (fileNode && fileNode.type === 'file') {
				// Remove from parent's children
				const parent = this.findParentNode(tree, relativePath);
				if (parent && parent.children) {
					const index = parent.children.indexOf(fileNode);
					if (index !== -1) {
						parent.children.splice(index, 1);
						// Decrement file count
						this.fileCount = Math.max(0, this.fileCount - 1);
						this.trackedFiles.delete(relativePath);
						this.fileHashes.delete(relativePath);
						await this.updateParentHashes(tree, relativePath);
						return { updated: true, newHash: tree.hash };
					}
				}
			}
			return { updated: false, newHash: tree.hash };
		}
		
		// Get file hash (chunked or whole-file)
		let newHash: string;
		let chunks: FileChunk[] | undefined;
		
		try {
			if (this.enableChunkedHashing) {
				const result = await this.hashFileChunked(uri);
				newHash = result.fileHash;
				chunks = result.chunks;
			} else {
				newHash = await this.hashFile(uri);
			}
		} catch (error) {
			// If hashing fails, we can't update the tree
			this.logService.warn(`[MerkleTree] Failed to hash file ${uri.fsPath}, skipping update`);
			return { updated: false, newHash: tree.hash };
		}
		
		// Update or add the file node
		const fileNode = this.findNodeByPath(tree, relativePath);
		
		if (fileNode && fileNode.type === 'file') {
			const oldHash = fileNode.hash;
			if (oldHash === newHash) {
				// No change
				return { updated: false, newHash: tree.hash };
			}
			
			fileNode.hash = newHash;
			fileNode.fileHash = newHash;
			fileNode.chunks = chunks;
			
			// Update parent directory hashes
			await this.updateParentHashes(tree, relativePath);
			
			return { updated: true, newHash: tree.hash };
		} else {
			// File not in tree yet, add it
			let parent = this.findParentNode(tree, relativePath);
			if (!parent) {
				// Create missing parent directories
				parent = await this.ensureParentDirectories(tree, relativePath);
			}
			
			if (parent) {
				if (!parent.children) {
					parent.children = [];
				}
				
				const newNode: MerkleTreeNode = {
					hash: newHash,
					path: relativePath,
					type: 'file',
					fileHash: newHash,
					chunks: chunks,
					isTracked: true,
				};
				
				parent.children.push(newNode);
				this.trackedFiles.add(relativePath);
				this.fileHashes.set(relativePath, newHash);
				this.fileCount++;
				
				await this.updateParentHashes(tree, relativePath);
				return { updated: true, newHash: tree.hash };
			}
		}

		return { updated: false, newHash: tree.hash };
	}

	/**
	 * Find parent node of a path
	 */
	private findParentNode(node: MerkleTreeNode, path: string): MerkleTreeNode | undefined {
		const pathParts = path.split(/[\\/]+/).filter(p => p);
		if (pathParts.length === 0) {
			return node; // Root
		}

		const parentPath = pathParts.slice(0, -1).join('/');
		if (parentPath === '') {
			return node; // Direct child of root
		}

		return this.findNodeByPath(node, parentPath);
	}

	/**
	 * Find a node by path in the tree
	 */
	private findNodeByPath(node: MerkleTreeNode, path: string): MerkleTreeNode | undefined {
		if (node.path === path) {
			return node;
		}

		if (node.children) {
			for (const child of node.children) {
				const found = this.findNodeByPath(child, path);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	/**
	 * Ensure parent directories exist in the tree
	 */
	private async ensureParentDirectories(tree: MerkleTreeNode, filePath: string): Promise<MerkleTreeNode | undefined> {
		const pathParts = filePath.split(/[\\/]+/).filter(p => p);
		if (pathParts.length === 0) {
			return tree; // Root
		}

		// Remove the filename, keep only directory parts
		const dirParts = pathParts.slice(0, -1);
		if (dirParts.length === 0) {
			return tree; // File is directly in root
		}

		let currentNode = tree;
		let currentPath = '';

		for (const part of dirParts) {
			currentPath = currentPath ? join(currentPath, part) : part;
			
			if (!currentNode.children) {
				currentNode.children = [];
			}

			let child = currentNode.children.find(c => c.path === currentPath);
			if (!child) {
				// Create missing directory node
				child = {
					hash: '',
					path: currentPath,
					type: 'directory',
					children: [],
				};
				currentNode.children.push(child);
			}

			if (child.type === 'directory') {
				currentNode = child;
			} else {
				// Path conflict - a file exists with this path
				this.logService.warn(`[MerkleTree] Path conflict: ${currentPath} exists as file but expected directory`);
				return undefined;
			}
		}

		return currentNode;
	}

	/**
	 * Update parent directory hashes after a file change
	 */
	private async updateParentHashes(tree: MerkleTreeNode, changedPath: string): Promise<void> {
		const pathParts = changedPath.split(/[\\/]+/).filter(p => p);
		
		// Update hashes from the file's parent up to root
		const dirParts = pathParts.slice(0, -1); // Remove filename
		let currentPath = '';
		let currentNode = tree;

		// Update all parent directories
		for (const part of dirParts) {
			currentPath = currentPath ? join(currentPath, part) : part;
			
			if (!currentNode.children) {
				// Directory structure missing, skip hash update
				this.logService.debug(`[MerkleTree] Directory structure missing at ${currentPath}, skipping hash update`);
				break;
			}

			const child = currentNode.children.find(c => c.path === currentPath);
			if (child && child.type === 'directory') {
				child.hash = await this.hashDirectory(child);
				currentNode = child;
			} else {
				// Directory not found, skip further updates
				this.logService.debug(`[MerkleTree] Directory not found at ${currentPath}, skipping hash update`);
				break;
			}
		}

		// Update root hash
		tree.hash = await this.hashDirectory(tree);
	}

	/**
	 * Get repository size category
	 */
	getRepoSizeCategory(): 'small' | 'medium' | 'large' | 'massive' {
		if (this.fileCount < REPO_SIZE_THRESHOLDS.SMALL) {
			return 'small';
		} else if (this.fileCount < REPO_SIZE_THRESHOLDS.MEDIUM) {
			return 'medium';
		} else if (this.fileCount < REPO_SIZE_THRESHOLDS.LARGE) {
			return 'large';
		} else {
			return 'massive';
		}
	}
}

