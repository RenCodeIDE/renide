/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { Location } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IUndoRedoElement, IUndoRedoService } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { IEditorPane } from '../../../../common/editor.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IAiEditTelemetryService } from '../../../editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { ICellEditOperation } from '../../../notebook/common/notebookCommon.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { ChatEditKind, IModifiedEntryTelemetryInfo, IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ISnapshotEntry, ModifiedFileEntryState } from '../../common/chatEditingService.js';
import { IChatResponseModel } from '../../common/chatModel.js';
import { IChatService } from '../../common/chatService.js';
import { IRenMonitorXChangelogBuffer } from '../../../renViews/common/renChangelogBuffer.js';
import { IRenWorkspaceStore } from '../../../renViews/common/renWorkspaceStore.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { AbstractChatEditingModifiedFileEntry } from './chatEditingModifiedFileEntry.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

// FileOperationType is already defined in chatEditingOperations.ts, but we need a separate enum for entry metadata
export enum FileOperationEntryType {
	Create = 'create',
	Delete = 'delete'
}

interface IFileOperationMetadata {
	type: FileOperationEntryType;
	originalContent?: string; // For delete operations, store the original content
}

/**
 * Entry for file operations (create/delete) that don't involve text edits.
 * This entry type handles file system operations and their undo/redo.
 */
export class ChatEditingFileOperationEntry extends AbstractChatEditingModifiedFileEntry implements IModifiedFileEntry {

	readonly initialContent: string = '';
	readonly originalURI: URI;
	private readonly _fileOperation: IFileOperationMetadata;

	override get changesCount() {
		return observableValue(this, 1); // File operations always have 1 change
	}

	constructor(
		fileURI: URI,
		fileOperation: IFileOperationMetadata,
		telemetryInfo: IModifiedEntryTelemetryInfo,
		kind: ChatEditKind,
		@IConfigurationService configService: IConfigurationService,
		@IFilesConfigurationService fileConfigService: IFilesConfigurationService,
		@IChatService chatService: IChatService,
		@IFileService fileService: IFileService,
		@IUndoRedoService undoRedoService: IUndoRedoService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAiEditTelemetryService aiEditTelemetryService: IAiEditTelemetryService,
		@IRenWorkspaceStore renWorkspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer renChangelogBuffer: IRenMonitorXChangelogBuffer,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super(
			fileURI,
			telemetryInfo,
			kind,
			configService,
			fileConfigService,
			chatService,
			fileService,
			undoRedoService,
			instantiationService,
			aiEditTelemetryService,
			renWorkspaceStore,
			renChangelogBuffer,
		);

		this._fileOperation = fileOperation;
		this.originalURI = fileURI; // For file operations, original and modified URI are the same
	}

	hasModificationAt(_location: Location): boolean {
		// File operations don't have specific locations, so always return true if in Modified state
		return this._stateObs.get() === ModifiedFileEntryState.Modified;
	}

	protected _createEditorIntegration(_editor: IEditorPane): IModifiedFileEntryEditorIntegration {
		// File operation entries don't need editor integration since they don't have text edits
		// Return a minimal implementation
		return {
			dispose: () => { },
			currentIndex: observableValue(this, 0),
			reveal: () => { },
			next: () => false,
			previous: () => false,
			enableAccessibleDiffView: () => { },
			acceptNearestChange: async () => { await this.accept(); },
			rejectNearestChange: async () => { await this.reject(); },
			toggleDiff: async () => { },
		};
	}

	protected _createUndoRedoElement(_response: IChatResponseModel): IUndoRedoElement | undefined {
		// File operations don't use undo/redo elements in the same way as text edits
		return undefined;
	}

	async acceptAgentEdits(_resource: URI, _edits: (TextEdit | ICellEditOperation)[], _isLastEdits: boolean, _responseModel: IChatResponseModel | undefined): Promise<void> {
		// File operation entries don't accept text edits
		// This method is called by the session but we don't need to do anything
	}

	override async acceptStreamingEditsEnd(): Promise<void> {
		// File operation entries don't have streaming edits
		// This method is called by the session but we don't need to do anything
	}

	protected async _areOriginalAndModifiedIdentical(): Promise<boolean> {
		// For file operations, we can't compare original and modified since:
		// - Create: original doesn't exist, modified exists
		// - Delete: original exists, modified doesn't exist
		return false;
	}

	createSnapshot(_requestId: string | undefined, _undoStop: string | undefined): ISnapshotEntry {
		// File operation entries don't create snapshots in the same way as text edits
		// Return a minimal snapshot
		return {
			resource: this.modifiedURI,
			languageId: '',
			snapshotUri: this.modifiedURI,
			original: this._fileOperation.originalContent || '',
			current: this._fileOperation.type === FileOperationEntryType.Create ? '' : (this._fileOperation.originalContent || ''),
			state: this._stateObs.get(),
			telemetryInfo: this._telemetryInfo,
		};
	}

	equalsSnapshot(_snapshot: ISnapshotEntry | undefined): boolean {
		// File operation entries don't compare snapshots
		return false;
	}

	async restoreFromSnapshot(_snapshot: ISnapshotEntry, _restoreToDisk?: boolean): Promise<void> {
		// File operation entries don't restore from snapshots
	}

	async resetToInitialContent(): Promise<void> {
		// For file operations, reset means undoing the operation
		await this._doReject();
	}

	protected async _doAccept(): Promise<void> {
		// Accept means finalizing the changelog entry
		// The actual file operation has already been done (file created or deleted)
		// So we just need to ensure the changelog is finalized (handled by parent class)
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[ChatEditingFileOperationEntry] _doAccept: File operation accepted', {
				type: this._fileOperation.type,
				uri: this.modifiedURI.toString()
			});
		}
		// The parent class's accept() method already calls _finalizeChangelogEntry()
		// So we don't need to do anything here
	}

	protected async _doReject(): Promise<void> {
		// Reject means undoing the file operation
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[ChatEditingFileOperationEntry] _doReject: Undoing file operation', {
				type: this._fileOperation.type,
				uri: this.modifiedURI.toString()
			});
		}

		try {
			if (this._fileOperation.type === FileOperationEntryType.Create) {
				// Undo create: delete the file
				const exists = await this._fileService.exists(this.modifiedURI);
				if (exists) {
					await this._fileService.del(this.modifiedURI, { recursive: false });
					if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
						console.log('[ChatEditingFileOperationEntry] _doReject: Deleted created file', {
							uri: this.modifiedURI.toString()
						});
					}
				}
			} else if (this._fileOperation.type === FileOperationEntryType.Delete) {
				// Undo delete: restore the file with original content
				if (this._fileOperation.originalContent !== undefined) {
					await this._fileService.writeFile(
						this.modifiedURI,
						VSBuffer.fromString(this._fileOperation.originalContent)
					);
					if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
						console.log('[ChatEditingFileOperationEntry] _doReject: Restored deleted file', {
							uri: this.modifiedURI.toString()
						});
					}
				}
			}
		} catch (error) {
			console.error('[ChatEditingFileOperationEntry] _doReject: Failed to undo file operation', error, {
				type: this._fileOperation.type,
				uri: this.modifiedURI.toString()
			});
			// Don't throw - we still want to reject the entry even if undo fails
		}
	}

	protected async buildChangelogDraft(): Promise<import('../../../renViews/common/renChangelogBuffer.js').IMonitorXChangelogDraftSeed | undefined> {
		// File operation entries should already have drafts created by the tools
		// So we return undefined here - the draft should already exist in the buffer
		// However, we can build a draft if needed for fallback
		const workspace = this._workspaceContextService.getWorkspace();
		const workspaceRelativePath = workspace.folders.length > 0
			? this._getWorkspaceRelativePath(this.modifiedURI)
			: this.modifiedURI.fsPath;

		const subject = this._fileOperation.type === FileOperationEntryType.Create
			? `Create file: ${workspaceRelativePath}`
			: `Delete file: ${workspaceRelativePath}`;

		const description = this._fileOperation.type === FileOperationEntryType.Create
			? `Created new file: ${workspaceRelativePath}`
			: `Deleted file: ${workspaceRelativePath}`;

		// Generate diff based on operation type
		let diff = '';
		if (this._fileOperation.type === FileOperationEntryType.Create) {
			// For create, we might not have content, so diff is empty or we'd need to read it
			// But since the file was just created, we can try to read it
			try {
				const content = await this._fileService.readFile(this.modifiedURI);
				const lines = content.value.toString().split('\n');
				diff = lines.map(line => `+${line}`).join('\n');
			} catch {
				// File might not exist or can't be read
				diff = '';
			}
		} else if (this._fileOperation.type === FileOperationEntryType.Delete && this._fileOperation.originalContent !== undefined) {
			// For delete, use the stored original content
			const lines = this._fileOperation.originalContent.split('\n');
			diff = lines.map(line => `-${line}`).join('\n');
		}

		return {
			subject,
			description,
			files: [{
				path: workspaceRelativePath,
				diff
			}]
		};
	}

	private _getWorkspaceRelativePath(uri: URI): string {
		const workspace = this._workspaceContextService.getWorkspace();
		if (workspace.folders.length === 0) {
			return uri.fsPath;
		}

		const folder = workspace.folders[0];
		const relative = uri.toString().substring(folder.uri.toString().length);
		return relative.startsWith('/') ? relative.substring(1) : relative;
	}
}

