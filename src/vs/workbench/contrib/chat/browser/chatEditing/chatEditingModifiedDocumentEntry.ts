/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReference, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ITransaction, autorun, transaction } from '../../../../../base/common/observable.js';
import { assertType } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Location, TextEdit } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { SingleModelEditStackElement } from '../../../../../editor/common/model/editStack.js';
import { createTextBufferFactoryFromSnapshot } from '../../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IUndoRedoElement, IUndoRedoService } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { IEditorPane, SaveReason } from '../../../../common/editor.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileService, isTextFileEditorModel, stringToSnapshot } from '../../../../services/textfile/common/textfiles.js';
import { IAiEditTelemetryService } from '../../../editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { ICellEditOperation } from '../../../notebook/common/notebookCommon.js';
import { ChatEditKind, IModifiedEntryTelemetryInfo, IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ISnapshotEntry, ModifiedFileEntryState } from '../../common/chatEditingService.js';
import { IChatResponseModel } from '../../common/chatModel.js';
import { IChatService } from '../../common/chatService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { relativePath, basename } from '../../../../../base/common/resources.js';
import { IDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { IRenWorkspaceStore } from '../../../renViews/common/renWorkspaceStore.js';
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraftSeed } from '../../../renViews/common/renChangelogBuffer.js';
import { ChatEditingCodeEditorIntegration } from './chatEditingCodeEditorIntegration.js';
import { AbstractChatEditingModifiedFileEntry } from './chatEditingModifiedFileEntry.js';
import { ChatEditingTextModelChangeService } from './chatEditingTextModelChangeService.js';
import { ChatEditingSnapshotTextModelContentProvider, ChatEditingTextModelContentProvider } from './chatEditingTextModelContentProviders.js';

interface IMultiDiffEntryDelegate {
	collapse: (transaction: ITransaction | undefined) => void;
}


export class ChatEditingModifiedDocumentEntry extends AbstractChatEditingModifiedFileEntry implements IModifiedFileEntry {

	readonly initialContent: string;

	private readonly originalModel: ITextModel;
	private readonly modifiedModel: ITextModel;

	private readonly _docFileEditorModel: IResolvedTextEditorModel;

	override get changesCount() {
		return this._textModelChangeService.diffInfo.map(diff => diff.changes.length);
	}

	get linesAdded() {
		return this._textModelChangeService.diffInfo.map(diff => {
			let added = 0;
			for (const c of diff.changes) {
				added += Math.max(0, c.modified.endLineNumberExclusive - c.modified.startLineNumber);
			}
			return added;
		});
	}
	get linesRemoved() {
		return this._textModelChangeService.diffInfo.map(diff => {
			let removed = 0;
			for (const c of diff.changes) {
				removed += Math.max(0, c.original.endLineNumberExclusive - c.original.startLineNumber);
			}
			return removed;
		});
	}

	readonly originalURI: URI;
	private readonly _textModelChangeService: ChatEditingTextModelChangeService;

	constructor(
		resourceRef: IReference<IResolvedTextEditorModel>,
		private readonly _multiDiffEntryDelegate: IMultiDiffEntryDelegate,
		telemetryInfo: IModifiedEntryTelemetryInfo,
		kind: ChatEditKind,
		initialContent: string | undefined,
		@IMarkerService markerService: IMarkerService,
		@IModelService modelService: IModelService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageService languageService: ILanguageService,
		@IConfigurationService configService: IConfigurationService,
		@IFilesConfigurationService fileConfigService: IFilesConfigurationService,
		@IChatService chatService: IChatService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService fileService: IFileService,
		@IUndoRedoService undoRedoService: IUndoRedoService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAiEditTelemetryService aiEditTelemetryService: IAiEditTelemetryService,
		@IRenWorkspaceStore renWorkspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer renChangelogBuffer: IRenMonitorXChangelogBuffer,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super(
			resourceRef.object.textEditorModel.uri,
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

		this._docFileEditorModel = this._register(resourceRef).object;
		this.modifiedModel = resourceRef.object.textEditorModel;
		this.originalURI = ChatEditingTextModelContentProvider.getFileURI(telemetryInfo.sessionId, this.entryId, this.modifiedURI.path);

		this.initialContent = initialContent ?? this.modifiedModel.getValue();
		const docSnapshot = this.originalModel = this._register(
			modelService.createModel(
				createTextBufferFactoryFromSnapshot(initialContent ? stringToSnapshot(initialContent) : this.modifiedModel.createSnapshot()),
				languageService.createById(this.modifiedModel.getLanguageId()),
				this.originalURI,
				false
			)
		);

		this._textModelChangeService = this._register(instantiationService.createInstance(ChatEditingTextModelChangeService,
			this.originalModel, this.modifiedModel, this._stateObs));

		this._register(this._textModelChangeService.onDidAcceptOrRejectAllHunks(action => {
			this._stateObs.set(action, undefined);
			this._notifySessionAction(action === ModifiedFileEntryState.Accepted ? 'accepted' : 'rejected');
		}));

		this._register(this._textModelChangeService.onDidAcceptOrRejectLines(action => {
			this._notifyAction({
				kind: 'chatEditingHunkAction',
				uri: this.modifiedURI,
				outcome: action.state,
				languageId: this.modifiedModel.getLanguageId(),
				...action
			});
		}));

		// Create a reference to this model to avoid it being disposed from under our nose
		(async () => {
			const reference = await textModelService.createModelReference(docSnapshot.uri);
			if (this._store.isDisposed) {
				reference.dispose();
				return;
			}
			this._register(reference);
		})();


		this._register(this._textModelChangeService.onDidUserEditModel(() => {
			this._userEditScheduler.schedule();
			const didResetToOriginalContent = this.modifiedModel.getValue() === this.initialContent;
			if (this._stateObs.get() === ModifiedFileEntryState.Modified && didResetToOriginalContent) {
				this._stateObs.set(ModifiedFileEntryState.Rejected, undefined);
			}
		}));

		const resourceFilter = this._register(new MutableDisposable());
		this._register(autorun(r => {
			const inProgress = this._waitsForLastEdits.read(r);
			if (inProgress) {
				const res = this._lastModifyingResponseObs.read(r);
				const req = res && res.session.getRequests().find(value => value.id === res.requestId);
				resourceFilter.value = markerService.installResourceFilter(this.modifiedURI, req?.message.text || localize('default', "Chat Edits"));
			} else {
				resourceFilter.clear();
			}
		}));
	}

	equalsSnapshot(snapshot: ISnapshotEntry | undefined): boolean {
		return !!snapshot &&
			this.modifiedURI.toString() === snapshot.resource.toString() &&
			this.modifiedModel.getLanguageId() === snapshot.languageId &&
			this.originalModel.getValue() === snapshot.original &&
			this.modifiedModel.getValue() === snapshot.current &&
			this.state.get() === snapshot.state;
	}

	createSnapshot(requestId: string | undefined, undoStop: string | undefined): ISnapshotEntry {
		return {
			resource: this.modifiedURI,
			languageId: this.modifiedModel.getLanguageId(),
			snapshotUri: ChatEditingSnapshotTextModelContentProvider.getSnapshotFileURI(this._telemetryInfo.sessionId, requestId, undoStop, this.modifiedURI.path),
			original: this.originalModel.getValue(),
			current: this.modifiedModel.getValue(),
			state: this.state.get(),
			telemetryInfo: this._telemetryInfo
		};
	}

	public getCurrentContents() {
		return this.modifiedModel.getValue();
	}

	public override hasModificationAt(location: Location): boolean {
		return location.uri.toString() === this.modifiedModel.uri.toString() && this._textModelChangeService.hasHunkAt(location.range);
	}

	async restoreFromSnapshot(snapshot: ISnapshotEntry, restoreToDisk = true) {
		this._stateObs.set(snapshot.state, undefined);
		await this._textModelChangeService.resetDocumentValues(snapshot.original, restoreToDisk ? snapshot.current : undefined);
	}

	async resetToInitialContent() {
		await this._textModelChangeService.resetDocumentValues(undefined, this.initialContent);
	}

	protected override async _areOriginalAndModifiedIdentical(): Promise<boolean> {
		return this._textModelChangeService.areOriginalAndModifiedIdentical();
	}

	protected override _resetEditsState(tx: ITransaction): void {
		super._resetEditsState(tx);
		this._textModelChangeService.clearCurrentEditLineDecoration();
	}

	protected override _createUndoRedoElement(response: IChatResponseModel): IUndoRedoElement {
		const request = response.session.getRequests().find(req => req.id === response.requestId);
		const label = request?.message.text ? localize('chatEditing1', "Chat Edit: '{0}'", request.message.text) : localize('chatEditing2', "Chat Edit");
		return new SingleModelEditStackElement(label, 'chat.edit', this.modifiedModel, null);
	}

	async acceptAgentEdits(resource: URI, textEdits: (TextEdit | ICellEditOperation)[], isLastEdits: boolean, responseModel: IChatResponseModel | undefined): Promise<void> {

		const result = await this._textModelChangeService.acceptAgentEdits(resource, textEdits, isLastEdits, responseModel);

		transaction((tx) => {
			this._waitsForLastEdits.set(!isLastEdits, tx);
			this._stateObs.set(ModifiedFileEntryState.Modified, tx);

			if (!isLastEdits) {
				this._rewriteRatioObs.set(result.rewriteRatio, tx);
			} else {
				this._resetEditsState(tx);
				this._rewriteRatioObs.set(1, tx);
			}
		});
		if (isLastEdits && this._shouldAutoSave()) {
			await this._textFileService.save(this.modifiedModel.uri, {
				reason: SaveReason.AUTO,
				skipSaveParticipants: true,
			});
		}

		if (isLastEdits) {
			try {
				if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
					console.log('[MonitorX] acceptAgentEdits: calling storeChangelogDraft', { isLastEdits, resource: resource.toString() });
				}
				// Wait a bit for diff to compute (it's async but not awaited in acceptAgentEdits)
				await new Promise(resolve => setTimeout(resolve, 100));
				await this.storeChangelogDraft();
			} catch (error) {
				console.error('[MonitorX] acceptAgentEdits: Failed to update MonitorX draft:', error);
			}
		}
	}


	protected override async _doAccept(): Promise<void> {
		this._textModelChangeService.keep();
		this._multiDiffEntryDelegate.collapse(undefined);

		const config = this._fileConfigService.getAutoSaveConfiguration(this.modifiedURI);
		if (!config.autoSave || !this._textFileService.isDirty(this.modifiedURI)) {
			// SAVE after accept for manual-savers, for auto-savers
			// trigger explict save to get save participants going
			try {
				await this._textFileService.save(this.modifiedURI, {
					reason: SaveReason.EXPLICIT,
					force: true,
					ignoreErrorHandler: true
				});
			} catch {
				// ignored
			}
		}
	}

	protected override async _doReject(): Promise<void> {
		if (this.createdInRequestId === this._telemetryInfo.requestId) {
			if (isTextFileEditorModel(this._docFileEditorModel)) {
				await this._docFileEditorModel.revert({ soft: true });
				await this._fileService.del(this.modifiedURI).catch(err => {
					// don't block if file is already deleted
				});
			}
			this._onDidDelete.fire();
		} else {
			this._textModelChangeService.undo();
			if (this._textModelChangeService.allEditsAreFromUs && isTextFileEditorModel(this._docFileEditorModel)) {
				// save the file after discarding so that the dirty indicator goes away
				// and so that an intermediate saved state gets reverted
				await this._docFileEditorModel.save({ reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
			}
			this._multiDiffEntryDelegate.collapse(undefined);
		}
	}

	protected override async buildChangelogDraft(): Promise<IMonitorXChangelogDraftSeed | undefined> {
		const diffInfo = this._textModelChangeService.diffInfo.get();
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX] buildChangelogDraft: called', { hasDiffInfo: !!diffInfo, isIdentical: diffInfo?.identical, uri: this.originalURI.toString() });
		}
		if (!diffInfo || diffInfo.identical) {
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.warn('[MonitorX] buildChangelogDraft: No diffInfo or identical', { hasDiffInfo: !!diffInfo, isIdentical: diffInfo?.identical });
			}
			return undefined;
		}

		const filePath = this._resolveWorkspaceRelativePath();
		const diffString = this._formatUnifiedDiff(diffInfo);
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX] buildChangelogDraft: diffString generated', { filePath, diffLength: diffString.length, diffTrimmed: diffString.trim().length });
		}
		if (!diffString.trim()) {
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.warn('[MonitorX] buildChangelogDraft: Empty diffString', { filePath });
			}
			return undefined;
		}

		let linesAdded = 0;
		let linesRemoved = 0;
		for (const change of diffInfo.changes) {
			linesAdded += Math.max(0, change.modified.endLineNumberExclusive - change.modified.startLineNumber);
			linesRemoved += Math.max(0, change.original.endLineNumberExclusive - change.original.startLineNumber);
		}

		const subject = this._generateSubject(linesAdded, linesRemoved);
		const description = this._generateDescription(linesAdded, linesRemoved);
		const metadata = this._buildMetadata(linesAdded, linesRemoved);

		console.log('[MonitorX] buildChangelogDraft: final result', {
			filePath,
			subject,
			descriptionLength: description.length,
			hasMetadata: !!metadata,
			editExplanation: this._telemetryInfo.editExplanation,
			requestId: this._telemetryInfo.requestId,
			sessionId: this._telemetryInfo.sessionId
		});

		return {
			subject,
			description,
			files: [{ path: filePath, diff: diffString }],
			metadata
		};
	}

	private _formatUnifiedDiff(diff: IDocumentDiff): string {
		const lines: string[] = [];
		const originalLines = this.originalModel.getLinesContent();
		const modifiedLines = this.modifiedModel.getLinesContent();

		for (const change of diff.changes) {
			const originalStart = change.original.startLineNumber;
			const originalEnd = change.original.endLineNumberExclusive;
			const modifiedStart = change.modified.startLineNumber;
			const modifiedEnd = change.modified.endLineNumberExclusive;

			const originalLineCount = originalEnd - originalStart;
			const modifiedLineCount = modifiedEnd - modifiedStart;

			// Unified diff header: @@ -start,count +start,count @@
			lines.push(`@@ -${originalStart},${originalLineCount} +${modifiedStart},${modifiedLineCount} @@`);

			// Process inner changes if available, otherwise process the entire range
			if (change.innerChanges && change.innerChanges.length > 0) {
				// Use inner changes for more granular diff
				let lastProcessedOriginal = originalStart - 1;
				let lastProcessedModified = modifiedStart - 1;

				for (const innerChange of change.innerChanges) {
					// Context before inner change (unchanged lines)
					const innerOrigStart = innerChange.originalRange.startLineNumber;
					for (let i = Math.max(originalStart, lastProcessedOriginal + 1); i < innerOrigStart; i++) {
						if (i > 0 && i <= originalLines.length) {
							lines.push(' ' + originalLines[i - 1]);
						}
					}

					// Deleted lines (original) - Range.endLineNumber is inclusive
					const origStart = innerChange.originalRange.startLineNumber;
					const origEnd = innerChange.originalRange.endLineNumber;
					for (let i = origStart; i <= origEnd && i > 0 && i <= originalLines.length; i++) {
						lines.push('-' + originalLines[i - 1]);
					}
					lastProcessedOriginal = Math.max(lastProcessedOriginal, origEnd);

					// Added lines (modified) - Range.endLineNumber is inclusive
					const modStart = innerChange.modifiedRange.startLineNumber;
					const modEnd = innerChange.modifiedRange.endLineNumber;
					for (let i = modStart; i <= modEnd && i > 0 && i <= modifiedLines.length; i++) {
						lines.push('+' + modifiedLines[i - 1]);
					}
					lastProcessedModified = Math.max(lastProcessedModified, modEnd);
				}

				// Context after last inner change
				for (let i = lastProcessedOriginal + 1; i < Math.min(originalEnd, originalLines.length + 1); i++) {
					if (i > 0 && i <= originalLines.length) {
						lines.push(' ' + originalLines[i - 1]);
					}
				}
			} else {
				// No inner changes - show deleted then added
				for (let i = originalStart; i < originalEnd && i > 0 && i <= originalLines.length; i++) {
					lines.push('-' + originalLines[i - 1]);
				}
				for (let i = modifiedStart; i < modifiedEnd && i > 0 && i <= modifiedLines.length; i++) {
					lines.push('+' + modifiedLines[i - 1]);
				}
			}
		}

		return lines.join('\n');
	}

	private _resolveWorkspaceRelativePath(): string {
		const workspace = this._workspaceContextService.getWorkspace();
		const workspaceFolder = workspace.folders[0];
		if (workspaceFolder) {
			const relative = relativePath(workspaceFolder.uri, this.originalURI);
			if (relative) {
				return relative;
			}
		}
		return this.originalURI.fsPath;
	}

	private _generateSubject(linesAdded: number, linesRemoved: number): string {
		const fileName = basename(this.originalURI);
		const fallback = this._buildFallbackSubject(fileName, linesAdded, linesRemoved);

		// Prefer model-provided subject if available
		const modelSubject = this._telemetryInfo.editSubject;
		if (typeof modelSubject === 'string' && modelSubject.trim()) {
			console.log('[MonitorX] _generateSubject: using model-provided subject', {
				file: this.originalURI.toString(),
				subject: modelSubject,
				subjectWordCount: modelSubject.split(/\s+/).length,
				requestId: this._telemetryInfo.requestId,
				sessionId: this._telemetryInfo.sessionId
			});
			return modelSubject.trim();
		}

		// Fall back to extracting from explanation
		const raw = this._telemetryInfo.editExplanation;
		if (typeof raw === 'string' && raw.trim()) {
			// Generate a meaningful 5-6 word subject from the explanation
			const subject = this._extractMeaningfulSubject(raw.trim());

			console.log('[MonitorX] _generateSubject: extracted from explanation', {
				file: this.originalURI.toString(),
				rawLength: raw.length,
				rawPreview: raw.substring(0, 100),
				subject,
				subjectWordCount: subject.split(/\s+/).length,
				fallback,
				requestId: this._telemetryInfo.requestId,
				sessionId: this._telemetryInfo.sessionId
			});

			return subject || fallback;
		}

		console.log('[MonitorX] _generateSubject: using fallback', {
			file: this.originalURI.toString(),
			hasRawExplanation: !!raw,
			hasModelSubject: !!modelSubject,
			fallback,
			requestId: this._telemetryInfo.requestId,
			sessionId: this._telemetryInfo.sessionId
		});

		return fallback;
	}

	private _extractMeaningfulSubject(explanation: string): string {
		// Clean up the explanation
		let text = explanation.trim();

		// Remove common introductory phrases that don't add meaning
		const introPhrases = [
			/^(of course[.,]?\s+)/i,
			/^(i have\s+)/i,
			/^(i've\s+)/i,
			/^(i\s+)/i,
			/^(yes[.,]?\s+)/i,
			/^(sure[.,]?\s+)/i,
			/^(okay[.,]?\s+)/i,
			/^(ok[.,]?\s+)/i,
		];

		for (const pattern of introPhrases) {
			text = text.replace(pattern, '');
		}

		text = text.trim();
		if (!text) {
			// If we removed everything, fall back to original
			text = explanation.trim();
		}

		// Try to find the first complete sentence - prefer complete sentences
		const sentenceMatch = text.match(/^[^.!?]+[.!?]/);
		if (sentenceMatch) {
			const firstSentence = sentenceMatch[0].trim();
			const words = firstSentence.split(/\s+/).filter(w => w.length > 0);
			// Use complete sentence if it's reasonable (up to 12 words to keep it a one-liner)
			if (words.length <= 12) {
				return firstSentence;
			}
			// If sentence is too long, try to find a natural break point
			// Look for conjunctions, prepositions, or commas as natural breaks
			const naturalBreaks = [' and ', ' or ', ' but ', ' with ', ' to ', ' in ', ' on ', ' for ', ' at ', ' from ', ', '];
			let bestBreak = -1;
			for (const breakWord of naturalBreaks) {
				const breakIndex = firstSentence.toLowerCase().indexOf(breakWord, 30); // Start looking after 30 chars
				if (breakIndex > 0 && breakIndex < firstSentence.length - 10) {
					const wordsUpToBreak = firstSentence.substring(0, breakIndex).split(/\s+/).filter(w => w.length > 0);
					if (wordsUpToBreak.length >= 5 && wordsUpToBreak.length <= 10) {
						bestBreak = breakIndex;
						break;
					}
				}
			}
			if (bestBreak > 0) {
				return firstSentence.substring(0, bestBreak).trim();
			}
			// If no natural break, take first 10 words as a reasonable one-liner
			const truncated = words.slice(0, 10).join(' ').trim();
			return truncated;
		}

		// No sentence boundary found, extract meaningful phrase (up to 10 words)
		const words = text.split(/\s+/).filter(w => w.length > 0);
		const targetWords = Math.min(10, words.length);
		const phrase = words.slice(0, targetWords).join(' ').trim();
		// Remove trailing punctuation that might be incomplete
		const cleanPhrase = phrase.replace(/[.,;:]+$/, '');
		return cleanPhrase || phrase;
	}

	private _generateDescription(linesAdded: number, linesRemoved: number): string {
		// Prefer model-provided description; fallback to minimal legacy summary
		const provided = (this._telemetryInfo as unknown as { editDescription?: string }).editDescription;
		if (typeof provided === 'string' && provided.trim()) {
			return provided.trim();
		}
		const parts: string[] = [];
		if (linesAdded || linesRemoved) {
			parts.push(`Lines changed: +${linesAdded}/-${linesRemoved}.`);
		}
		if (this._telemetryInfo.command) {
			parts.push(`Invoked via ${this._telemetryInfo.command}.`);
		}
		return parts.join(' ') || `Edited ${basename(this.originalURI)}.`;
	}

	// concise helpers removed per model-provided description plan

	private _buildMetadata(linesAdded: number, linesRemoved: number): Record<string, unknown> {
		const metadata: Record<string, unknown> = {
			linesAdded,
			linesRemoved,
			sessionId: this._telemetryInfo.sessionId,
			agentId: this._telemetryInfo.agentId,
			requestId: this._telemetryInfo.requestId,
			modeId: this._telemetryInfo.modeId,
			modelId: this._telemetryInfo.modelId,
			command: this._telemetryInfo.command,
			// Preserve full explanation separately for optional UI expansion
			explanation: (this._telemetryInfo.editExplanation || '').trim()
		};
		for (const key of Object.keys(metadata)) {
			if (metadata[key] === undefined) {
				delete metadata[key];
			}
		}
		return metadata;
	}

	private _buildFallbackSubject(fileName: string, linesAdded: number, linesRemoved: number): string {
		const delta = linesAdded + linesRemoved;
		if (delta === 0) {
			return `Update ${fileName}`;
		}
		return `Update ${fileName} (+${linesAdded}/-${linesRemoved})`;
	}


	protected _createEditorIntegration(editor: IEditorPane): IModifiedFileEntryEditorIntegration {
		const codeEditor = getCodeEditor(editor.getControl());
		assertType(codeEditor);

		const diffInfo = this._textModelChangeService.diffInfo;

		return this._instantiationService.createInstance(ChatEditingCodeEditorIntegration, this, codeEditor, diffInfo, false);
	}

	private _shouldAutoSave() {
		return this.modifiedURI.scheme !== Schemas.untitled;
	}
}
