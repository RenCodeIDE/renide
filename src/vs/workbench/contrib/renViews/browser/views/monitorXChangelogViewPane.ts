/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from '../../common/renWorkspaceStore.js';
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraftUpdate } from '../../common/renChangelogBuffer.js';
import { renderMonitorXChangelog, renderMonitorXChangelogDrafts } from './monitorXChangelogRenderer.js';
import { IMonitorXChangelogFilter } from '../../common/renChangelogFilter.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IModelDeltaDecoration } from '../../../../../editor/common/model.js';
import { IChatService } from '../../../../contrib/chat/common/chatService.js';
import { ChatModel } from '../../../../contrib/chat/common/chatModel.js';

export class MonitorXChangelogViewPane extends ViewPane {
	private bodyContainer!: HTMLElement;
	private draftsContainer!: HTMLElement;
	private changelogContainer!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private filterPanel!: HTMLElement;
	private filterButton!: HTMLElement;
	private currentFilter: IMonitorXChangelogFilter = {};

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer,
		@IEditorService private readonly editorService: IEditorService,
		@IChatService private readonly chatService: IChatService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.bodyContainer = document.createElement('div');
		this.bodyContainer.className = 'monitorx-pane-container';
		container.appendChild(this.bodyContainer);

		const filterContainer = document.createElement('div');
		filterContainer.className = 'ren-monitorx-filter-container';

		const searchContainer = document.createElement('div');
		searchContainer.className = 'ren-monitorx-search-container';

		this.searchInput = document.createElement('input');
		this.searchInput.type = 'text';
		this.searchInput.className = 'ren-monitorx-search-input';
		this.searchInput.placeholder = localize('monitorx.changelog.search.placeholder', "Search changelog...");
		this.searchInput.addEventListener('input', () => this.onSearchInput());

		this.filterButton = document.createElement('button');
		this.filterButton.className = 'ren-monitorx-filter-button';
		this.filterButton.textContent = localize('monitorx.changelog.filter.button', "Filters");
		this.filterButton.addEventListener('click', () => this.toggleFilterPanel());

		searchContainer.appendChild(this.searchInput);
		searchContainer.appendChild(this.filterButton);
		filterContainer.appendChild(searchContainer);

		this.filterPanel = document.createElement('div');
		this.filterPanel.className = 'ren-monitorx-filter-panel';
		this.filterPanel.style.display = 'none';
		this.renderFilterPanel();
		filterContainer.appendChild(this.filterPanel);

		this.bodyContainer.appendChild(filterContainer);

		const draftsSection = document.createElement('section');
		draftsSection.className = 'ren-monitorx-drafts-section';
		const draftsTitle = document.createElement('h3');
		draftsTitle.className = 'ren-monitorx-section-title';
		draftsTitle.textContent = localize('monitorx.changelog.drafts.title', "Pending changes");
		draftsSection.appendChild(draftsTitle);

		this.draftsContainer = document.createElement('div');
		this.draftsContainer.className = 'ren-monitorx-drafts-body';
		draftsSection.appendChild(this.draftsContainer);
		this.bodyContainer.appendChild(draftsSection);

		const historySection = document.createElement('section');
		historySection.className = 'ren-monitorx-history-section';
		const historyTitle = document.createElement('h3');
		historyTitle.className = 'ren-monitorx-section-title';
		historyTitle.textContent = localize('monitorx.changelog.history.title', "Changelog history");
		historySection.appendChild(historyTitle);

		this.changelogContainer = document.createElement('div');
		this.changelogContainer.className = 'ren-monitorx-changelog-body';
		historySection.appendChild(this.changelogContainer);
		this.bodyContainer.appendChild(historySection);

		this.renderDrafts();
		this.renderEntries();
		this._register(this.workspaceStore.onDidChangeChangelog(() => this.renderEntries()));
		this._register(this.changelogBuffer.onDidChangeDraft(() => this.renderDrafts()));
	}

	protected override layoutBody(height: number, width: number): void {
		this.bodyContainer.style.height = `${height}px`;
		this.bodyContainer.style.overflow = 'hidden';
	}

	private renderDrafts(): void {
		const filter = this.buildFilter();
		const drafts = this.changelogBuffer.listDrafts(filter);
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX UI] renderDrafts: called', { draftCount: drafts.length, drafts: drafts.map(d => ({ sessionId: d.sessionId, subject: d.subject?.substring(0, 50) })) });
		}
		renderMonitorXChangelogDrafts(this.draftsContainer, drafts, {
			emptyMessage: localize('monitorx.changelog.drafts.empty', "No pending MonitorX drafts."),
			onFileClick: path => this.openFile(path),
			onViewDiff: file => this.openDiff(file),
			onSubjectChange: (sessionId, subject) => this.handleDraftUpdate(sessionId, { subject }),
			onDescriptionChange: (sessionId, description) => this.handleDraftUpdate(sessionId, { description }),
			onFinalize: (sessionId) => this.handleFinalizeDraft(sessionId)
		});
	}

	private async renderEntries(): Promise<void> {
		const filter = this.buildFilter();
		const entries = await this.workspaceStore.getAllChangelogEntries(filter);
		this.updateEntries(entries);
	}

	private buildFilter(): IMonitorXChangelogFilter | undefined {
		const hasFilter = Object.values(this.currentFilter).some(value => value !== undefined && value !== null && value !== '');
		return hasFilter ? this.currentFilter : undefined;
	}

	private async openFile(filePath: string): Promise<void> {
		const fileUri = URI.file(filePath);
		const editorInput: IResourceEditorInput = { resource: fileUri };
		await this.editorService.openEditor(editorInput, SIDE_GROUP);
	}

	private async openDiff(file: { path: string; diff: string }): Promise<void> {
		const label = `${file.path} (diff)`;
		const resource = URI.from({ scheme: 'untitled', path: label });
		const editorPane = await this.editorService.openEditor({ resource, contents: file.diff, languageId: 'diff', options: { pinned: true } }, SIDE_GROUP);

		if (!editorPane) {
			return;
		}

		// Wait a bit for the editor to be fully initialized
		setTimeout(() => {
			const codeEditor = getCodeEditor(editorPane.getControl());
			if (!codeEditor) {
				return;
			}

			const model = codeEditor.getModel();
			if (!model) {
				return;
			}

			const decorations: IModelDeltaDecoration[] = [];
			const lines = file.diff.split('\n');

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const lineNumber = i + 1;

				if (line.startsWith('+') && !line.startsWith('+++')) {
					// Added line - highlight in green
					const range = new Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber));
					decorations.push({
						range,
						options: {
							description: 'monitorx-diff-inserted',
							className: 'monitorx-diff-inserted-line',
							isWholeLine: true
						}
					});
				} else if (line.startsWith('-') && !line.startsWith('---')) {
					// Deleted line - highlight in red
					const range = new Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber));
					decorations.push({
						range,
						options: {
							description: 'monitorx-diff-deleted',
							className: 'monitorx-diff-deleted-line',
							isWholeLine: true
						}
					});
				}
			}

			if (decorations.length > 0) {
				codeEditor.changeDecorations(changeAccessor => {
					changeAccessor.deltaDecorations([], decorations);
				});
			}
		}, 100);
	}

	private updateEntries(entries: IMonitorXChangelogEntry[]): void {
		renderMonitorXChangelog(this.changelogContainer, entries, {
			emptyMessage: localize('monitorx.changelog.empty', "No MonitorX activity recorded yet."),
			limit: 50,
			onFileClick: (path) => this.openFile(path),
			onViewDiff: (file) => this.openDiff(file)
		});
	}

	private onSearchInput(): void {
		const text = this.searchInput.value.trim();
		if (text) {
			this.currentFilter.text = text;
		} else {
			delete this.currentFilter.text;
		}
		this.applyFilter();
	}

	private toggleFilterPanel(): void {
		const isVisible = this.filterPanel.style.display !== 'none';
		this.filterPanel.style.display = isVisible ? 'none' : 'block';
		this.filterButton.classList.toggle('active', !isVisible);
	}

	private renderFilterPanel(): void {
		while (this.filterPanel.firstChild) {
			this.filterPanel.removeChild(this.filterPanel.firstChild);
		}

		const filePathRow = document.createElement('div');
		filePathRow.className = 'ren-monitorx-filter-row';
		const filePathLabel = document.createElement('label');
		filePathLabel.textContent = localize('monitorx.changelog.filter.filePath', "File path:");
		const filePathInput = document.createElement('input');
		filePathInput.type = 'text';
		filePathInput.className = 'ren-monitorx-filter-input';
		filePathInput.value = this.currentFilter.filePath || '';
		filePathInput.placeholder = localize('monitorx.changelog.filter.filePath.placeholder', "e.g., src/");
		filePathInput.addEventListener('input', () => {
			const value = filePathInput.value.trim();
			if (value) {
				this.currentFilter.filePath = value;
			} else {
				delete this.currentFilter.filePath;
			}
			this.applyFilter();
		});
		filePathRow.appendChild(filePathLabel);
		filePathRow.appendChild(filePathInput);
		this.filterPanel.appendChild(filePathRow);

		const agentIdRow = document.createElement('div');
		agentIdRow.className = 'ren-monitorx-filter-row';
		const agentIdLabel = document.createElement('label');
		agentIdLabel.textContent = localize('monitorx.changelog.filter.agentId', "Agent:");
		const agentIdInput = document.createElement('input');
		agentIdInput.type = 'text';
		agentIdInput.className = 'ren-monitorx-filter-input';
		agentIdInput.value = this.currentFilter.agentId || '';
		agentIdInput.placeholder = localize('monitorx.changelog.filter.agentId.placeholder', "e.g., Gemini");
		agentIdInput.addEventListener('input', () => {
			const value = agentIdInput.value.trim();
			if (value) {
				this.currentFilter.agentId = value;
			} else {
				delete this.currentFilter.agentId;
			}
			this.applyFilter();
		});
		agentIdRow.appendChild(agentIdLabel);
		agentIdRow.appendChild(agentIdInput);
		this.filterPanel.appendChild(agentIdRow);

		const modelIdRow = document.createElement('div');
		modelIdRow.className = 'ren-monitorx-filter-row';
		const modelIdLabel = document.createElement('label');
		modelIdLabel.textContent = localize('monitorx.changelog.filter.modelId', "Model:");
		const modelIdInput = document.createElement('input');
		modelIdInput.type = 'text';
		modelIdInput.className = 'ren-monitorx-filter-input';
		modelIdInput.value = this.currentFilter.modelId || '';
		modelIdInput.placeholder = localize('monitorx.changelog.filter.modelId.placeholder', "e.g., gpt-4");
		modelIdInput.addEventListener('input', () => {
			const value = modelIdInput.value.trim();
			if (value) {
				this.currentFilter.modelId = value;
			} else {
				delete this.currentFilter.modelId;
			}
			this.applyFilter();
		});
		modelIdRow.appendChild(modelIdLabel);
		modelIdRow.appendChild(modelIdInput);
		this.filterPanel.appendChild(modelIdRow);

		const commandRow = document.createElement('div');
		commandRow.className = 'ren-monitorx-filter-row';
		const commandLabel = document.createElement('label');
		commandLabel.textContent = localize('monitorx.changelog.filter.command', "Command:");
		const commandInput = document.createElement('input');
		commandInput.type = 'text';
		commandInput.className = 'ren-monitorx-filter-input';
		commandInput.value = this.currentFilter.command || '';
		commandInput.placeholder = localize('monitorx.changelog.filter.command.placeholder', "e.g., edit");
		commandInput.addEventListener('input', () => {
			const value = commandInput.value.trim();
			if (value) {
				this.currentFilter.command = value;
			} else {
				delete this.currentFilter.command;
			}
			this.applyFilter();
		});
		commandRow.appendChild(commandLabel);
		commandRow.appendChild(commandInput);
		this.filterPanel.appendChild(commandRow);

		const modeIdRow = document.createElement('div');
		modeIdRow.className = 'ren-monitorx-filter-row';
		const modeIdLabel = document.createElement('label');
		modeIdLabel.textContent = localize('monitorx.changelog.filter.modeId', "Mode:");
		const modeIdInput = document.createElement('input');
		modeIdInput.type = 'text';
		modeIdInput.className = 'ren-monitorx-filter-input';
		modeIdInput.value = this.currentFilter.modeId || '';
		modeIdInput.placeholder = localize('monitorx.changelog.filter.modeId.placeholder', "e.g., agent");
		modeIdInput.addEventListener('input', () => {
			const value = modeIdInput.value.trim();
			if (value) {
				this.currentFilter.modeId = value;
			} else {
				delete this.currentFilter.modeId;
			}
			this.applyFilter();
		});
		modeIdRow.appendChild(modeIdLabel);
		modeIdRow.appendChild(modeIdInput);
		this.filterPanel.appendChild(modeIdRow);

		const clearButton = document.createElement('button');
		clearButton.className = 'ren-monitorx-filter-clear';
		clearButton.textContent = localize('monitorx.changelog.filter.clear', "Clear filters");
		clearButton.addEventListener('click', () => this.clearFilters());
		this.filterPanel.appendChild(clearButton);
	}

	private clearFilters(): void {
		this.currentFilter = {};
		this.searchInput.value = '';
		const inputs = this.filterPanel.querySelectorAll('input');
		inputs.forEach(input => input.value = '');
		this.applyFilter();
	}

	private applyFilter(): void {
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX UI] applyFilter: called', { filter: this.currentFilter });
		}
		this.renderDrafts();
		this.renderEntries();
	}

	private handleDraftUpdate(sessionId: string, update: IMonitorXChangelogDraftUpdate): void {
		try {
			this.changelogBuffer.updateDraft(sessionId, update);
		} catch (error) {
			console.error('Failed to update MonitorX draft:', error);
			this.renderDrafts();
		}
	}

	private async handleFinalizeDraft(sessionId: string): Promise<void> {
		try {
			// Get the draft
			const draft = this.changelogBuffer.getDraft(sessionId);
			if (!draft) {
				console.warn(`[MonitorX] handleFinalizeDraft: Draft not found for sessionId: ${sessionId}`);
				return;
			}

			// Extract sessionId and URI from draft key (format: sessionId:uri)
			const parts = sessionId.split(':');
			if (parts.length < 2) {
				console.warn(`[MonitorX] handleFinalizeDraft: Invalid draft key format: ${sessionId}`);
				return;
			}

			const chatSessionId = parts[0];
			const model = this.chatService.getSession(chatSessionId) as ChatModel | undefined;

			// Try to find corresponding ChatEditingSession entry
			if (model && model.editingSession) {
				const editingSession = model.editingSession;
				const entry = editingSession.getEntryByDraftKey(sessionId);

				if (entry) {
					// Entry exists (EditTool or file operation entry) - call accept() which will finalize changelog AND apply edits
					if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
						console.log(`[MonitorX] handleFinalizeDraft: Found entry for draft, calling accept()`, { sessionId, entryUri: entry.modifiedURI.toString() });
					}
					await entry.accept();
					return;
				}
			}

			// No entry found (shouldn't happen for file operations, but handle gracefully)
			// Finalize draft directly and add to changelog
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.log(`[MonitorX] handleFinalizeDraft: No entry found, finalizing draft directly`, { sessionId });
			}

			const finalizedEntry = this.changelogBuffer.finalizeDraft(sessionId);
			if (finalizedEntry) {
				await this.workspaceStore.addChangelogEntry(finalizedEntry);
				if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
					console.log(`[MonitorX] handleFinalizeDraft: Draft finalized and added to changelog`, { sessionId, subject: finalizedEntry.subject?.substring(0, 50) });
				}
			} else {
				console.warn(`[MonitorX] handleFinalizeDraft: Failed to finalize draft`, { sessionId });
			}
		} catch (error) {
			console.error(`[MonitorX] handleFinalizeDraft: Error finalizing draft`, error, { sessionId });
			throw error;
		}
	}
}

