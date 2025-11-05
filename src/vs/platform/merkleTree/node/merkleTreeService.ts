/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import { IntervalTimer } from "../../../base/common/async.js";
import { IFileService } from "../../files/common/files.js";
import { IChecksumService } from "../../checksum/common/checksumService.js";
import { IStorageService } from "../../storage/common/storage.js";
import { IWorkspaceContextService } from "../../workspace/common/workspace.js";
import { IConfigurationService } from "../../configuration/common/configuration.js";
import { ILogService } from "../../log/common/log.js";
import { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import { IMerkleTreeService } from "../common/merkleTreeService.js";
import {
	MerkleTreeNode,
	MerkleTreeSnapshot,
	MerkleTreeChange,
} from "../common/merkleTreeTypes.js";
import { MerkleTreeBuilder } from "../common/merkleTreeBuilder.js";
import { MerkleTreeCache } from "../common/merkleTreeCache.js";
import { MerkleTreeChangeTracker } from "../common/merkleTreeChangeTracker.js";
import { DEFAULT_CONFIG } from "../common/merkleTreeConstants.js";

export class MerkleTreeService
	extends Disposable
	implements IMerkleTreeService
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTree = this._register(
		new Emitter<{ oldHash: string; newHash: string }>()
	);
	readonly onDidChangeTree: Event<{ oldHash: string; newHash: string }> =
		this._onDidChangeTree.event;

	private _rootHash = "";
	private builder: MerkleTreeBuilder | undefined;
	private cache: MerkleTreeCache | undefined;
	private changeTracker: MerkleTreeChangeTracker | undefined;
	private isInitialized = false;
	private initializationPromise: Promise<void> | undefined;
	private isBuildingInitialTree = false; // Flag to suppress change events during initial build
	private syncTimer: IntervalTimer | undefined; // Periodic sync timer (every 5 minutes)

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IChecksumService private readonly checksumService: IChecksumService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService
	) {
		super();

		// Initialize on workspace change
		this._register(
			this.workspaceService.onDidChangeWorkspaceFolders(() => {
				this.initialize();
			})
		);

		// Initialize if workspace is available
		if (this.workspaceService.getWorkspace().folders.length > 0) {
			this.initialize();
		}
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		this.initializationPromise = this.doInitialize();
		return this.initializationPromise;
	}

	private async doInitialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		const config = this.configurationService.getValue<{
			enabled?: boolean;
			lazyTracking?: boolean;
			excludeStaticDirs?: boolean;
			cacheSize?: number;
			memoryLimitMB?: number;
			strategy?: string;
			chunkSizeLines?: number;
			enableChunkedHashing?: boolean;
		}>("merkleTree");

		if (config?.enabled === false) {
			this.logService.info("[MerkleTree] Service disabled by configuration");
			return;
		}

		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return;
		}

		const workspaceRoot = workspaceFolders[0].uri;
		const workspaceId = workspaceRoot.toString();

		// Determine cache size based on repo size (will be updated during build)
		const cacheSize = config?.cacheSize ?? DEFAULT_CONFIG.cacheSize;

		// Create cache
		this.cache = new MerkleTreeCache(
			this.storageService,
			this.logService,
			workspaceId,
			cacheSize
		);

		// Create builder
		this.builder = new MerkleTreeBuilder(
			this.fileService,
			this.checksumService,
			this.logService,
			{
				lazyTracking: config?.lazyTracking ?? DEFAULT_CONFIG.lazyTracking,
				excludeStaticDirs:
					config?.excludeStaticDirs ?? DEFAULT_CONFIG.excludeStaticDirs,
				strategy:
					(config?.strategy as "auto" | "full" | "sparse" | "ultra-sparse") ??
					DEFAULT_CONFIG.strategy,
				workspaceRoot,
				chunkSizeLines: config?.chunkSizeLines ?? DEFAULT_CONFIG.chunkSizeLines,
				enableChunkedHashing: config?.enableChunkedHashing ?? DEFAULT_CONFIG.enableChunkedHashing,
			}
		);

		// Create change tracker
		this.changeTracker = new MerkleTreeChangeTracker(
			this.fileService,
			this.editorService,
			this.logService,
			async (uri, type) => {
				await this.handleFileChange(uri, type);
			}
		);

		// Listen to tree changes
		this._register(
			this.changeTracker.onDidChangeTree((e) => {
				this._onDidChangeTree.fire({ oldHash: e.oldHash, newHash: e.newHash });
			})
		);

		// Build initial tree
		try {
			this.isBuildingInitialTree = true; // Suppress change events during initial build
			
			const initialHash = this._rootHash;
			await this.buildTree();

			// Track files that are currently open in editors (for lazy tracking)
			// Batch updates to avoid multiple change events
			// Note: In lazy mode, we only track files when they're actually needed (queried)
			// Don't auto-track all open files during initialization to avoid tracking
			// files outside the active directory
			// if (config?.lazyTracking !== false) {
			// 	await this.trackOpenFiles(true); // Pass suppressEvents=true
			// }

			// Emit a single change event after initial build completes
			if (this._rootHash && this._rootHash !== initialHash) {
				this.logService.info(
					`[MerkleTree] Initial tree built. Root hash: ${this._rootHash.substring(0, 16)}...`
				);
				// Emit initial tree build event (from empty to final hash)
				const changes = this.changeTracker?.getChangeLog(0) || [];
				this.changeTracker?.emitTreeChange(initialHash, this._rootHash, changes);
			}

			this.isInitialized = true;
			this.isBuildingInitialTree = false;
			
			// Start periodic sync timer (every 5 minutes)
			this.startPeriodicSync();
			
			this.logService.info("[MerkleTree] Service initialized successfully");
		} catch (error) {
			this.isBuildingInitialTree = false;
			this.logService.error(
				`[MerkleTree] Error initializing service: ${error}`
			);
		}
	}

	/**
	 * Start periodic sync timer (runs every 5 minutes)
	 */
	private startPeriodicSync(): void {
		if (this.syncTimer) {
			this.syncTimer.dispose();
		}

		this.syncTimer = this._register(new IntervalTimer());
		const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
		
		this.syncTimer.cancelAndSet(async () => {
			await this.syncTree();
		}, SYNC_INTERVAL_MS);

		this.logService.info("[MerkleTree] Periodic sync started (every 5 minutes)");
	}

	/**
	 * Sync the entire tree - ensures all tracked files are up to date
	 * This runs periodically (every 5 minutes) to catch any changes that might have been missed
	 */
	private async syncTree(): Promise<void> {
		if (!this.builder || !this.cache || !this.changeTracker) {
			return;
		}

		try {
			this.logService.debug("[MerkleTree] Starting periodic sync...");
			
			const oldHash = this._rootHash;
			let tree = this.cache.getTree();
			
			if (!tree) {
				// Rebuild if no tree available
				await this.buildTree();
				tree = this.cache.getTree();
			}

			if (!tree) {
				return;
			}

			// Rebuild the tree to ensure everything is in sync
			// This catches any changes that might have been missed by file watchers
			// (e.g., external file changes, symlinks, etc.)
			await this.buildTree();
			
			// Check if hash changed
			if (this._rootHash !== oldHash) {
				this.logService.info(
					`[MerkleTree] Periodic sync completed. Hash changed: ${oldHash.substring(0, 8)}... → ${this._rootHash.substring(0, 8)}...`
				);
				const changes = this.changeTracker.getChangeLog(Date.now() - 5 * 60 * 1000); // Last 5 minutes
				this.changeTracker.emitTreeChange(oldHash, this._rootHash, changes);
			} else {
				this.logService.debug("[MerkleTree] Periodic sync completed. No changes detected.");
			}
		} catch (error) {
			this.logService.error(`[MerkleTree] Error during periodic sync: ${error}`);
		}
	}


	/**
	 * Build the tree
	 */
	private async buildTree(): Promise<void> {
		if (!this.builder || !this.cache) {
			return;
		}

		const tree = await this.builder.buildInitialTree();
		const rootHash = tree.hash;

		this.cache.setTree(tree, rootHash);
		this._rootHash = rootHash;

		this.logService.info(
			`[MerkleTree] Tree built with root hash: ${rootHash.substring(0, 16)}...`
		);
	}

	/**
	 * Handle file change - syncs immediately after every file change
	 */
	private async handleFileChange(
		uri: URI,
		type: "added" | "deleted" | "modified"
	): Promise<void> {
		if (!this.builder || !this.cache || !this.changeTracker) {
			return;
		}

		// Suppress change events during initial build
		if (this.isBuildingInitialTree) {
			return;
		}

		const oldHash = this._rootHash;

		// Track the file if not already tracked
		await this.builder.trackFile(uri);

		// Update the tree
		let tree = this.cache.getTree();
		if (!tree) {
			// Rebuild if no tree available
			await this.buildTree();
			tree = this.cache.getTree();
		}

		if (tree) {
			const result = await this.builder.updateFile(uri, tree);
			if (result.updated) {
				this.cache.setTree(tree, tree.hash);
				this._rootHash = tree.hash;
			}
		}

		// Emit change event (only if not during initial build)
		// This ensures sync happens after every file change
		if (!this.isBuildingInitialTree && this._rootHash !== oldHash) {
			this.logService.debug(
				`[MerkleTree] File ${type}: ${uri.fsPath}. Hash changed: ${oldHash.substring(0, 8)}... → ${this._rootHash.substring(0, 8)}...`
			);
			const changes = this.changeTracker.getChangeLog(Date.now() - 1000);
			this.changeTracker.emitTreeChange(oldHash, this._rootHash, changes);
		}
	}

	get rootHash(): string {
		return this._rootHash;
	}

	async getTree(): Promise<MerkleTreeNode> {
		await this.initialize();

		if (!this.cache) {
			throw new Error("MerkleTree service not initialized");
		}

		const tree = this.cache.getTree();
		if (!tree) {
			throw new Error("Tree not available");
		}

		return tree;
	}

	async getSubtreeHash(uri: URI): Promise<string | undefined> {
		await this.initialize();

		if (!this.cache || !this.builder) {
			return undefined;
		}

		const relativePath = this.getRelativePath(uri);

		// Check cache first
		const cached = this.cache.getSubtreeHash(relativePath);
		if (cached) {
			return cached;
		}

		// Find the subtree in the tree
		const tree = this.cache.getTree();
		if (!tree) {
			return undefined;
		}

		const subtree = this.findSubtree(tree, relativePath);
		if (subtree) {
			const hash = subtree.hash;
			this.cache.setSubtreeHash(relativePath, hash);
			return hash;
		}

		return undefined;
	}

	async getPathHash(relativePath: string): Promise<string | undefined> {
		await this.initialize();

		if (!this.cache) {
			return undefined;
		}

		const node = this.cache.getNode(relativePath);
		if (node && node.type === "file") {
			return node.fileHash;
		}

		return undefined;
	}

	getChangeLog(since?: number): MerkleTreeChange[] {
		if (!this.changeTracker) {
			return [];
		}

		return this.changeTracker.getChangeLog(since);
	}

	async getSnapshot(version?: number): Promise<MerkleTreeSnapshot> {
		await this.initialize();

		if (!this.cache) {
			throw new Error("MerkleTree service not initialized");
		}

		const snapshot = this.cache.getSnapshot(version);
		if (!snapshot) {
			throw new Error(`Snapshot not found for version ${version}`);
		}

		return snapshot;
	}

	async forceRebuild(): Promise<void> {
		if (this.cache) {
			this.cache.clear();
		}

		this.isInitialized = false;
		this.initializationPromise = undefined;

		await this.initialize();
	}

	async invalidatePath(uri: URI): Promise<void> {
		await this.handleFileChange(uri, "modified");
	}

	async ensureTracked(uri: URI): Promise<void> {
		await this.initialize();

		if (!this.builder || !this.cache || !this.changeTracker) {
			return;
		}

		await this.builder.trackFile(uri);
		this.changeTracker.trackFile(uri);

		// Add file to tree if not already there
		const tree = this.cache.getTree();
		if (tree) {
			const result = await this.builder.updateFile(uri, tree);
			if (result.updated) {
				this.cache.setTree(tree, tree.hash);
				this._rootHash = tree.hash;
			}
		}
	}

	getRepoSizeCategory(): "small" | "medium" | "large" | "massive" {
		if (!this.builder) {
			return "small";
		}

		return this.builder.getRepoSizeCategory();
	}

	async getFileChunks(relativePath: string): Promise<import("../common/merkleTreeTypes.js").FileChunk[] | undefined> {
		await this.initialize();

		if (!this.cache) {
			return undefined;
		}

		const node = this.cache.getNode(relativePath);
		if (node && node.type === "file") {
			return node.chunks;
		}

		return undefined;
	}

	async getChangedChunks(
		relativePath: string,
		oldChunks?: import("../common/merkleTreeTypes.js").FileChunk[]
	): Promise<{ changed: number[]; unchanged: number[] }> {
		await this.initialize();

		const currentChunks = await this.getFileChunks(relativePath);
		if (!currentChunks) {
			return { changed: [], unchanged: [] };
		}

		if (!oldChunks || oldChunks.length === 0) {
			// All chunks are "changed" (new file)
			return {
				changed: currentChunks.map((_, i) => i),
				unchanged: [],
			};
		}

		const changed: number[] = [];
		const unchanged: number[] = [];

		// Compare chunks by index
		for (let i = 0; i < Math.max(currentChunks.length, oldChunks.length); i++) {
			const currentChunk = currentChunks[i];
			const oldChunk = oldChunks[i];

			if (!currentChunk || !oldChunk) {
				// Chunk was added or removed
				changed.push(i);
			} else if (currentChunk.hash !== oldChunk.hash) {
				// Chunk content changed
				changed.push(i);
			} else {
				// Chunk unchanged
				unchanged.push(i);
			}
		}

		return { changed, unchanged };
	}

	/**
	 * Find a subtree in the tree
	 */
	private findSubtree(
		node: MerkleTreeNode,
		path: string
	): MerkleTreeNode | undefined {
		if (node.path === path) {
			return node;
		}

		if (node.children) {
			for (const child of node.children) {
				const found = this.findSubtree(child, path);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	/**
	 * Get relative path from workspace root
	 */
	private getRelativePath(uri: URI): string {
		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return uri.fsPath;
		}

		const rootPath = workspaceFolders[0].uri.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, "");
		}

		return absolutePath;
	}
}
