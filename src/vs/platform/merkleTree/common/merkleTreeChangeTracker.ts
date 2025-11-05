/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService, FileChangesEvent } from '../../files/common/files.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { ILogService } from '../../log/common/log.js';
import { MerkleTreeChange } from './merkleTreeTypes.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { DEFAULT_CONFIG } from './merkleTreeConstants.js';

export interface TreeChangeEvent {
	oldHash: string;
	newHash: string;
	changes: MerkleTreeChange[];
}

export class MerkleTreeChangeTracker extends Disposable {
	private readonly _onDidChangeTree = this._register(new Emitter<TreeChangeEvent>());
	readonly onDidChangeTree: Event<TreeChangeEvent> = this._onDidChangeTree.event;

	private readonly changeLog: MerkleTreeChange[] = [];
	private readonly pendingChanges = new Set<string>(); // URIs pending update
	private readonly updateScheduler: RunOnceScheduler;
	private readonly trackedFiles = new Set<string>(); // Files being tracked

	constructor(
		private readonly fileService: IFileService,
		private readonly editorService: IEditorService,
		private readonly logService: ILogService,
		private readonly onFileChange: (uri: URI, type: 'added' | 'deleted' | 'modified') => Promise<void>
	) {
		super();

		// Debounced update scheduler
		this.updateScheduler = this._register(new RunOnceScheduler(() => {
			this.processPendingChanges();
		}, DEFAULT_CONFIG.debounceMs));

		// Listen to file system changes
		this._register(
			this.fileService.onDidFilesChange(e => this.handleFileChanges(e))
		);

		// Listen to editor changes (for undo/redo detection)
		this._register(
			this.editorService.onDidEditorsChange(() => {
				// Track open files
				this.trackOpenFiles();
			})
		);

		// Initial tracking of open files
		this.trackOpenFiles();
	}

	/**
	 * Handle file system changes
	 */
	private handleFileChanges(event: FileChangesEvent): void {
		let hasChanges = false;

		for (const change of event.rawAdded) {
			// Track new files immediately
			this.trackFile(change);
			this.pendingChanges.add(change.toString());
			this.logChange(change, 'added');
			hasChanges = true;
		}

		for (const change of event.rawDeleted) {
			this.pendingChanges.add(change.toString());
			this.logChange(change, 'deleted');
			hasChanges = true;
		}

		for (const change of event.rawUpdated) {
			// Ensure file is tracked
			this.trackFile(change);
			this.pendingChanges.add(change.toString());
			this.logChange(change, 'modified');
			hasChanges = true;
		}

		// Schedule update
		if (hasChanges) {
			this.updateScheduler.schedule();
		}
	}

	/**
	 * Process pending changes
	 */
	private async processPendingChanges(): Promise<void> {
		const changes = Array.from(this.pendingChanges);
		this.pendingChanges.clear();

		for (const uriString of changes) {
			const uri = URI.parse(uriString);
			
			try {
				// Determine change type
				const exists = await this.fileService.exists(uri);
				let type: 'added' | 'deleted' | 'modified' = exists ? 'modified' : 'deleted';
				
				// If file doesn't exist in tracked files, it's likely an addition
				if (exists && !this.isTracked(uri)) {
					type = 'added';
					this.trackFile(uri);
				}

				// Call the update handler
				await this.onFileChange(uri, type);
			} catch (error) {
				this.logService.warn(`[MerkleTree] Error processing change for ${uriString}: ${error}`);
			}
		}
	}

	/**
	 * Track files that are currently open in editors
	 */
	private trackOpenFiles(): void {
		const editors = this.editorService.editors;
		
		for (const editor of editors) {
			const resource = editor.resource;
			if (resource && resource.scheme === 'file') {
				this.trackedFiles.add(resource.toString());
			}
		}
	}

	/**
	 * Log a change event
	 */
	private logChange(uri: URI, type: 'added' | 'deleted' | 'modified'): void {
		const change: MerkleTreeChange = {
			type,
			path: uri.fsPath,
			timestamp: Date.now(),
		};

		this.changeLog.push(change);

		// Keep only last N changes
		if (this.changeLog.length > DEFAULT_CONFIG.changeLogSize) {
			this.changeLog.shift();
		}
	}

	/**
	 * Get change log since a specific timestamp
	 */
	getChangeLog(since?: number): MerkleTreeChange[] {
		if (since === undefined) {
			return [...this.changeLog];
		}

		return this.changeLog.filter(change => change.timestamp >= since);
	}

	/**
	 * Emit tree change event
	 */
	emitTreeChange(oldHash: string, newHash: string, changes: MerkleTreeChange[]): void {
		this._onDidChangeTree.fire({ oldHash, newHash, changes });
	}

	/**
	 * Check if a file is being tracked
	 */
	isTracked(uri: URI): boolean {
		return this.trackedFiles.has(uri.toString());
	}

	/**
	 * Mark a file as tracked
	 */
	trackFile(uri: URI): void {
		this.trackedFiles.add(uri.toString());
	}
}

