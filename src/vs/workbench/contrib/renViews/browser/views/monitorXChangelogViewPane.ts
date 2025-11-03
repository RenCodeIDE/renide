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

export class MonitorXChangelogViewPane extends ViewPane {
	private bodyContainer!: HTMLElement;
	private draftsContainer!: HTMLElement;
	private changelogContainer!: HTMLElement;

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
		@IEditorService private readonly editorService: IEditorService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.bodyContainer = document.createElement('div');
		this.bodyContainer.className = 'monitorx-pane-container';
		container.appendChild(this.bodyContainer);

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
		this._register(this.workspaceStore.onDidChangeChangelog(entries => this.updateEntries(entries)));
		this._register(this.changelogBuffer.onDidChangeDraft(() => this.renderDrafts()));
	}

	protected override layoutBody(height: number, width: number): void {
		this.bodyContainer.style.height = `${height}px`;
		this.bodyContainer.style.overflow = 'hidden';
	}

	private renderDrafts(): void {
		const drafts = this.changelogBuffer.listDrafts();
		renderMonitorXChangelogDrafts(this.draftsContainer, drafts, {
			emptyMessage: localize('monitorx.changelog.drafts.empty', "No pending MonitorX drafts."),
			onFileClick: path => this.openFile(path),
			onSubjectChange: (sessionId, subject) => this.handleDraftUpdate(sessionId, { subject }),
			onDescriptionChange: (sessionId, description) => this.handleDraftUpdate(sessionId, { description })
		});
	}

	private async renderEntries(): Promise<void> {
		const entries = await this.workspaceStore.getAllChangelogEntries();
		this.updateEntries(entries);
	}

	private async openFile(filePath: string): Promise<void> {
		const fileUri = URI.file(filePath);
		const editorInput: IResourceEditorInput = { resource: fileUri };
		await this.editorService.openEditor(editorInput, SIDE_GROUP);
	}

	private updateEntries(entries: IMonitorXChangelogEntry[]): void {
		renderMonitorXChangelog(this.changelogContainer, entries, {
			emptyMessage: localize('monitorx.changelog.empty', "No MonitorX activity recorded yet."),
			limit: 50,
			onFileClick: (path) => this.openFile(path)
		});
	}

	private handleDraftUpdate(sessionId: string, update: IMonitorXChangelogDraftUpdate): void {
		try {
			this.changelogBuffer.updateDraft(sessionId, update);
		} catch (error) {
			console.error('Failed to update MonitorX draft:', error);
			this.renderDrafts();
		}
	}
}

