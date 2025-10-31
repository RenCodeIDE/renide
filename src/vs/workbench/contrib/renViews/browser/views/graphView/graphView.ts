/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../../../base/browser/dom.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IWebviewService, IWebviewElement } from '../../../../webview/browser/webview.js';
import { ensureCodeWindow, CodeWindow } from '../../../../../../base/browser/window.js';
import { FileAccess } from '../../../../../../base/common/network.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { asWebviewUri } from '../../../../webview/common/webview.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { IRenView } from '../renView.interface.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { IEditorService, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { GroupIdentifier, SideBySideEditor } from '../../../../../common/editor.js';
import { IResourceEditorInput, ITextEditorOptions, TextEditorSelectionRevealType } from '../../../../../../platform/editor/common/editor.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { escapeRegExpCharacters } from '../../../../../../base/common/strings.js';
import { URI } from '../../../../../../base/common/uri.js';
import { isCodeEditor, isDiffEditor } from '../../../../../../editor/browser/editorBrowser.js';

import { buildGraphWebviewHTML } from '../../templates/graphWebviewTemplate.js';
import { GraphWorkspaceContext } from './graphContext.js';
import { GraphDataBuilder } from './graphDataBuilder.js';
import { GraphPickers } from './graphPickers.js';
import { GitHeatmapCommitSummary, GitHeatmapGranularity, GitHeatmapPayload, GraphEdgePayload, GraphMode, GraphNodePayload, GraphStatusLevel, GraphWebviewPayload } from './graphTypes.js';
import { isExcludedPath } from './graphConstants.js';
import { ViewButtons } from '../../components/viewButtons.js';
import { IGitHeatmapService } from '../../../../../../platform/gitHeatmap/common/gitHeatmapService.js';

export class GraphView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _toolbar: HTMLElement | null = null;
	private _modeSelect: HTMLSelectElement | null = null;
	private _targetButton: HTMLButtonElement | null = null;
	private _window: Window | null = null;
	private _webview: IWebviewElement | null = null;
	private _graphReady = false;
	private _promptInFlight = false;
	private _renderRequestId = 0;
	private _mode: GraphMode = 'file';
	private _isUpdatingProgrammatically = false;
	private _selectedFile: URI | undefined;
	private _selectedFolder: URI | undefined;
	private _currentGraph:
		| {
			payload: GraphWebviewPayload;
			nodeById: Map<string, GraphNodePayload>;
			edgeById: Map<string, GraphEdgePayload>;
			nodeByResourceKey: Map<string, GraphNodePayload>;
		}
		| undefined;
	private _codeViewGroupId: GroupIdentifier | undefined;
	private _viewButtons: ViewButtons | null = null;
	private _selectionModeEnabled = false;
	private _heatmapGranularity: GitHeatmapGranularity = 'topLevel';
	private _heatmapWindowDays = 120;
	private _heatmapControls: {
		container: HTMLElement;
		granularitySelect: HTMLSelectElement;
		windowSelect: HTMLSelectElement;
		summary: HTMLElement;
	} | null = null;
	private _latestHeatmap: GitHeatmapPayload | null = null;
	private _heatmapRefreshQueued = false;

	private readonly context: GraphWorkspaceContext;
	private readonly dataBuilder: GraphDataBuilder;
	private readonly pickers: GraphPickers;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISearchService searchService: ISearchService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IGitHeatmapService gitHeatmapService: IGitHeatmapService
	) {
		super();
		this.context = new GraphWorkspaceContext(workspaceService, uriIdentityService);
		this.dataBuilder = new GraphDataBuilder(this.logService, this.fileService, searchService, this.context, this._commandService, this._languageFeaturesService, gitHeatmapService);
		this.pickers = new GraphPickers(this.quickInputService, searchService, this.fileService, this.logService, this.context);
	}

	show(contentArea: HTMLElement): void {
		this.logService.info('[GraphView] show()');
		contentArea.textContent = '';

		this._window = getWindow(contentArea);
		this._graphReady = false;
		this._promptInFlight = false;
		this._renderRequestId++;

		// Set up event listener for graph mode changes from top toolbar
		if (this._window) {
			const handleGraphModeChange = (e: Event) => {
				const customEvent = e as CustomEvent<GraphMode>;
				if (customEvent.detail && customEvent.detail !== this._mode) {
					// Prevent event loop by checking if mode is different
					this.applyModeChange(customEvent.detail);
				}
			};
			this._window.document.addEventListener('ren-graph-mode-change', handleGraphModeChange);
			this._register({ dispose: () => this._window?.document.removeEventListener('ren-graph-mode-change', handleGraphModeChange) });
		}

		this._mainContainer = document.createElement('div');
		this._mainContainer.className = 'ren-graph-container';
		this._mainContainer.style.display = 'flex';
		this._mainContainer.style.flexDirection = 'column';
		this._mainContainer.style.height = '100%';

		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.className = 'ren-graph-title';

		const viewport = document.createElement('div');
		viewport.className = 'ren-graph-viewport';
		viewport.style.position = 'relative';
		viewport.style.flex = '1 1 auto';
		viewport.style.minHeight = '240px';

		this._mainContainer.appendChild(title);
		this._mainContainer.appendChild(viewport);
		this._mainContainer.appendChild(this.ensureToolbar());

		contentArea.appendChild(this._mainContainer);

		// Add view buttons at bottom right
		contentArea.style.position = 'relative';
		this.addViewButtons(contentArea);

		void this.loadWebview(viewport);
	}

	private async loadWebview(container: HTMLElement): Promise<void> {
		if (!this._window) {
			return;
		}

		this._webview = this.webviewService.createWebviewElement({
			title: 'Graph',
			options: {
				disableServiceWorker: false,
				enableFindWidget: false
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [FileAccess.asFileUri('vs/workbench/contrib/renViews/browser/media/')]
			},
			extension: undefined
		});

		const win = this._window;
		ensureCodeWindow(win, 1);
		this._webview.mountTo(container, win as unknown as CodeWindow);
		this._register(this._webview);
		container.style.position = container.style.position || 'relative';
		container.style.height = '100%';

		const mediaRoot = FileAccess.asFileUri('vs/workbench/contrib/renViews/browser/media/');
		const libUri = asWebviewUri(joinPath(mediaRoot, 'cytoscape.min.js')).toString(true);
		const nonce = generateUuid();
		const html = buildGraphWebviewHTML(libUri, nonce);
		this._webview.setHtml(html);
		this._graphReady = false;

		const failTimer = this._window.setTimeout(() => {
			this.logService.error('[GraphView] graph failed to load (timeout)');
			this.showGraphFailed(container);
			void this.sendStatus('Graph webview failed to load.', 'error');
		}, 5000);

		this._register(this._webview.onMessage(e => {
			const data = e.message;
			const type = data?.type;
			if (!type) {
				return;
			}
			switch (type) {
				case 'REN_GRAPH_READY': {
					clearTimeout(failTimer);
					this.logService.info('[GraphView] graph ready', data?.payload ?? '');
					this._graphReady = true;
					this._promptInFlight = false;
					void this.sendStatus(this.getReadyMessage(), 'info');
					void this.promptForTargetAndRender();
					break;
				}
				case 'REN_SELECT_FILE':
					this.logService.info('[GraphView] select file requested from webview');
					void this.promptForTargetAndRender();
					break;
				case 'REN_GRAPH_APPLIED':
					this.logService.info('[GraphView] graph applied', data?.payload ?? '');
					break;
				case 'REN_GRAPH_EVT':
					this.logService.info('[GraphView] graph evt', data?.payload ?? '');
					this.handleGraphEvent(data?.payload);
					break;
				case 'REN_ZOOM':
					this.logService.info('[GraphView] zoom button', data?.payload ?? '');
					break;
				case 'REN_WHEEL':
					this.logService.info('[GraphView] wheel', data?.payload ?? '');
					break;
				case 'REN_GRAPH_ERROR':
					this.logService.error('[GraphView] webview error', data?.payload ?? '');
					break;
				default:
					this.logService.debug(`[GraphView] webview message: ${type}`, data?.payload ?? '');
			}
		}));
	}

	private addViewButtons(container: HTMLElement): void {
		container.style.position = 'relative';
		this._viewButtons = new ViewButtons(container);
		this._register(this._viewButtons);
	}

	hide(): void {
		if (this._viewButtons) {
			this._viewButtons.dispose();
			this._viewButtons = null;
		}
		if (this._mainContainer) {
			this._mainContainer.remove();
			this._mainContainer = null;
			this._toolbar = null;
		}
		if (this._webview) {
			this._webview.dispose();
			this._webview = null;
		}
		this._graphReady = false;
		this._promptInFlight = false;
		this._currentGraph = undefined;
		this._selectionModeEnabled = false;
	}

	private ensureToolbar(): HTMLElement {
		if (this._toolbar) {
			return this._toolbar;
		}

		const toolbar = document.createElement('div');
		toolbar.className = 'ren-graph-toolbar';
		toolbar.style.display = 'inline-flex';
		toolbar.style.gap = '8px';
		toolbar.style.margin = '8px 0 0';
		toolbar.style.alignSelf = 'flex-end';

		const modeLabel = document.createElement('label');
		modeLabel.className = 'ren-graph-toolbar-field';
		modeLabel.textContent = 'View: ';

		const modeSelect = document.createElement('select');
		modeSelect.id = 'renGraphModeSelect';
		modeSelect.className = 'ren-graph-toolbar-select';
		(['file', 'folder', 'workspace', 'architecture', 'gitHeatmap'] as GraphMode[]).forEach(mode => {
			const option = document.createElement('option');
			option.value = mode;
			option.textContent = this.getModeLabel(mode);
			modeSelect.appendChild(option);
		});
		modeSelect.value = this._mode;
		modeSelect.title = 'Select graph scope';
		modeSelect.addEventListener('change', () => {
			// Prevent event loop - ignore changes triggered programmatically
			if (this._isUpdatingProgrammatically) {
				return;
			}
			const selectedMode = modeSelect.value as GraphMode;
			// Dispatch event to sync with top toolbar
			if (this._window) {
				const event = new CustomEvent('ren-graph-mode-change', { detail: selectedMode });
				this._window.document.dispatchEvent(event);
			}
			this.applyModeChange(selectedMode);
		});

		modeLabel.appendChild(modeSelect);
		toolbar.appendChild(modeLabel);
		this._modeSelect = modeSelect;

		const targetButton = document.createElement('button');
		targetButton.className = 'ren-graph-toolbar-btn';
		targetButton.addEventListener('click', () => {
			void this.promptForTargetAndRender();
		});
		toolbar.appendChild(targetButton);
		this._targetButton = targetButton;

		const heatmapControlsContainer = document.createElement('div');
		heatmapControlsContainer.className = 'ren-graph-toolbar-heatmap';
		heatmapControlsContainer.style.display = 'none';
		heatmapControlsContainer.style.alignItems = 'center';
		heatmapControlsContainer.style.gap = '6px';

		const granularityLabel = document.createElement('label');
		granularityLabel.className = 'ren-graph-toolbar-field';
		granularityLabel.textContent = 'Granularity: ';
		const granularitySelect = document.createElement('select');
		granularitySelect.className = 'ren-graph-toolbar-select';
		([['topLevel', 'Top folders'], ['twoLevel', 'Folder · Subfolder'], ['file', 'Individual files']] as const).forEach(([value, label]) => {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			granularitySelect.appendChild(option);
		});
		granularitySelect.value = this._heatmapGranularity;
		granularitySelect.addEventListener('change', () => {
			this._heatmapGranularity = granularitySelect.value as GitHeatmapGranularity;
			this.handleHeatmapSettingChanged();
		});
		granularityLabel.appendChild(granularitySelect);
		heatmapControlsContainer.appendChild(granularityLabel);

		const windowLabel = document.createElement('label');
		windowLabel.className = 'ren-graph-toolbar-field';
		windowLabel.textContent = 'Window: ';
		const windowSelect = document.createElement('select');
		windowSelect.className = 'ren-graph-toolbar-select';
		([['60', '60 days'], ['90', '90 days'], ['120', '120 days'], ['180', '180 days']] as const).forEach(([value, label]) => {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			windowSelect.appendChild(option);
		});
		windowSelect.value = String(this._heatmapWindowDays);
		windowSelect.addEventListener('change', () => {
			const parsed = parseInt(windowSelect.value, 10);
			if (!Number.isNaN(parsed) && parsed > 0) {
				this._heatmapWindowDays = parsed;
				this.handleHeatmapSettingChanged();
			}
		});
		windowLabel.appendChild(windowSelect);
		heatmapControlsContainer.appendChild(windowLabel);

		const heatmapSummary = document.createElement('span');
		heatmapSummary.className = 'ren-graph-toolbar-summary';
		heatmapSummary.textContent = 'Coupling across recent commits.';
		heatmapControlsContainer.appendChild(heatmapSummary);

		toolbar.appendChild(heatmapControlsContainer);
		this._heatmapControls = {
			container: heatmapControlsContainer,
			granularitySelect,
			windowSelect,
			summary: heatmapSummary
		};

		this._toolbar = toolbar;
		this.updateToolbarUI();
		return toolbar;
	}

	private updateToolbarUI(): void {
		if (this._modeSelect) {
			this._isUpdatingProgrammatically = true;
			try {
				this._modeSelect.value = this._mode;
			} finally {
				// Use setTimeout to ensure the change event has fired before resetting the flag
				setTimeout(() => {
					this._isUpdatingProgrammatically = false;
				}, 0);
			}
			this._modeSelect.title = 'Select graph scope';
		}
		if (this._targetButton) {
			switch (this._mode) {
				case 'workspace':
					this._targetButton.textContent = 'Render Workspace';
					this._targetButton.title = 'Visualize dependencies for the entire workspace';
					break;
				case 'folder':
					this._targetButton.textContent = this._selectedFolder
						? 'Change source'
						: 'Select source';
					this._targetButton.title = 'Choose a folder to visualize';
					break;
				case 'architecture':
					this._targetButton.textContent = 'Analyze Architecture';
					this._targetButton.title = 'Inspect the project to build an architecture graph';
					break;
				case 'gitHeatmap':
					this._targetButton.textContent = 'Refresh Heatmap';
					this._targetButton.title = 'Rebuild module co-change heatmap from Git history';
					break;
				case 'file':
				default:
					this._targetButton.textContent = this._selectedFile
						? 'Change source'
						: 'Select source';
					this._targetButton.title = 'Choose a file to visualize';
					break;
			}
		}
		if (this._heatmapControls) {
			const visible = this._mode === 'gitHeatmap';
			this._heatmapControls.container.style.display = visible ? 'inline-flex' : 'none';
			if (visible) {
				this._heatmapControls.granularitySelect.value = this._heatmapGranularity;
				this._heatmapControls.windowSelect.value = String(this._heatmapWindowDays);
				this._heatmapControls.summary.textContent = this._latestHeatmap
					? this.buildHeatmapSummary(this._latestHeatmap)
					: 'Coupling across recent commits.';
			}
		}
		if (this._toolbar) {
			this._toolbar.style.display = this._mode === 'gitHeatmap' ? 'none' : 'inline-flex';
		}
	}

	private applyModeChange(mode: GraphMode): void {
		if (mode === this._mode) {
			return;
		}

		this._mode = mode;
		if (this._mode !== 'file') {
			this._selectedFile = undefined;
		}
		if (this._mode !== 'folder') {
			this._selectedFolder = undefined;
		}
		this.updateToolbarUI();
		void this.sendStatus(this.getReadyMessage(), 'info');
		if (this._graphReady && (this._mode === 'workspace' || this._mode === 'architecture' || this._mode === 'gitHeatmap')) {
			void this.promptForTargetAndRender();
		}
	}

	private buildHeatmapSummary(payload: GitHeatmapPayload): string {
		const modules = payload.modules.length;
		const pairs = payload.cells.length;
		const windowDays = payload.windowDays;
		const peak = payload.colorScale.max;
		const roundedPeak = Number.isFinite(peak) && peak > 0 ? peak.toFixed(2) : '0';
		return `${modules} modules · ${pairs} pairs · ${windowDays}d · peak ${roundedPeak}`;
	}

	private handleHeatmapSettingChanged(): void {
		if (this._mode !== 'gitHeatmap') {
			return;
		}
		this.queueHeatmapRefresh();
	}

	private queueHeatmapRefresh(): void {
		if (this._mode !== 'gitHeatmap' || !this._graphReady) {
			return;
		}
		if (this._promptInFlight) {
			this._heatmapRefreshQueued = true;
			return;
		}
		void this.promptForTargetAndRender();
	}

	private updateHeatmapSummary(payload: GitHeatmapPayload | null): void {
		if (!this._heatmapControls) {
			return;
		}
		this._heatmapControls.summary.textContent = payload
			? this.buildHeatmapSummary(payload)
			: 'Coupling across recent commits.';
	}

	private onHeatmapCellSelected(raw: unknown): void {
		if (!this._latestHeatmap || !raw || typeof raw !== 'object') {
			return;
		}
		const cell = raw as {
			row?: unknown;
			column?: unknown;
			normalized?: unknown;
			normalizedWeight?: unknown;
			weight?: unknown;
			commitCount?: unknown;
			commits?: unknown;
		};
		const row = typeof cell.row === 'number' ? cell.row : -1;
		const column = typeof cell.column === 'number' ? cell.column : -1;
		const moduleA = this._latestHeatmap.modules[row] ?? `(row ${row})`;
		const moduleB = this._latestHeatmap.modules[column] ?? `(col ${column})`;
		const normalized = typeof cell.normalized === 'number'
			? cell.normalized
			: typeof cell.normalizedWeight === 'number'
				? cell.normalizedWeight
				: 0;
		const weight = typeof cell.weight === 'number' ? cell.weight : 0;
		const commitCount = typeof cell.commitCount === 'number'
			? cell.commitCount
			: Array.isArray(cell.commits)
				? (cell.commits as unknown[]).length
				: 0;
		let message = `${moduleA} ↔ ${moduleB}: score ${normalized.toFixed(2)} · weighted ${weight.toFixed(1)} · commits ${commitCount}`;
		const commits = Array.isArray(cell.commits)
			? (cell.commits as GitHeatmapCommitSummary[])
			: [];
		if (commits.length > 0) {
			const sample = commits[0];
			const hash = sample.hash ? sample.hash.slice(0, 7) : '';
			const subject = sample.message ? sample.message.trim() : '';
			const excerpt = [hash, subject].filter(Boolean).join(' ');
			if (excerpt) {
				message += ` · e.g. ${excerpt}`;
			}
		}
		void this.sendStatus(message, 'info', 8000);
	}

	private onHeatmapHover(raw: unknown): void {
		// Hover updates are now handled in the webview only, not in the toolbar summary
		// This prevents the toolbar from being updated on every hover
	}

	private onHeatmapSelectionCleared(): void {
		this.updateHeatmapSummary(this._latestHeatmap);
	}

	private async promptForTargetAndRender(): Promise<void> {
		if (!this._webview || !this._graphReady) {
			return;
		}
		if (this._promptInFlight) {
			this.logService.debug('[GraphView] prompt already in flight');
			return;
		}

		this._promptInFlight = true;
		const requestId = ++this._renderRequestId;

		try {
			switch (this._mode) {
				case 'workspace':
					await this.renderWorkspaceGraph(requestId);
					break;
				case 'folder': {
					await this.sendStatus('Waiting for folder selection…', 'loading');
					const folder = await this.pickers.pickFolder(this._selectedFolder);
					if (!folder) {
						await this.sendStatus('No folder selected.', 'warning', 4000);
						return;
					}
					this._selectedFolder = folder;
					this.updateToolbarUI();
					await this.renderFolderGraph(folder, requestId);
					break;
				}
				case 'architecture':
					await this.renderArchitectureGraph(requestId);
					break;
				case 'gitHeatmap':
					await this.renderGitHeatmap(requestId);
					break;
				case 'file':
				default: {
					await this.sendStatus('Waiting for file selection…', 'loading');
					const file = await this.pickers.pickSourceFile();
					if (!file) {
						await this.sendStatus('No file selected.', 'warning', 4000);
						return;
					}
					this._selectedFile = file;
					this.updateToolbarUI();
					await this.renderFileGraph(file, requestId);
					break;
				}
			}
		} finally {
			if (requestId === this._renderRequestId) {
				this._promptInFlight = false;
				if (this._heatmapRefreshQueued && this._mode === 'gitHeatmap') {
					this._heatmapRefreshQueued = false;
					void this.promptForTargetAndRender();
				}
			}
		}
	}

	private async renderFileGraph(sourceUri: URI, requestId: number): Promise<void> {
		await this.sendStatus(`Building import graph for ${this.context.formatNodeLabel(sourceUri)}…`, 'loading');
		try {
			const payload = await this.dataBuilder.buildGraphForFile(sourceUri);
			const graphPayload: GraphWebviewPayload = payload;
			if (requestId !== this._renderRequestId) {
				return;
			}
			this.storeGraphPayload(graphPayload);
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload: graphPayload });
			const edgeCount = this.getEdgeCount(graphPayload);
			await this.sendStatus(
				edgeCount === 0
					? 'No import statements found in the selected file.'
					: `Rendered imports for ${this.context.formatNodeLabel(sourceUri)}.`,
				edgeCount === 0 ? 'warning' : 'success',
				edgeCount === 0 ? 5000 : 4000
			);
		} catch (error) {
			this.logService.error('[GraphView] failed to build file graph', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to build graph. Check logs for details.', 'error');
			}
		}
	}

	private async renderFolderGraph(folder: URI, requestId: number): Promise<void> {
		await this.sendStatus(`Scanning folder ${this.context.formatNodeLabel(folder)}…`, 'loading');
		try {
			const payload = await this.dataBuilder.buildGraphForScope([folder], 'folder');
			const graphPayload: GraphWebviewPayload = payload;
			if (requestId !== this._renderRequestId) {
				return;
			}
			this.storeGraphPayload(graphPayload);
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload: graphPayload });
			if (this.getNodeCount(graphPayload) === 0) {
				await this.sendStatus('No matching source files found in the selected folder.', 'warning', 4000);
			} else {
				await this.sendStatus(`Rendered folder graph for ${this.context.formatNodeLabel(folder)}.`, 'success', 4000);
			}
		} catch (error) {
			this.logService.error('[GraphView] failed to build folder graph', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to build folder graph. Check logs for details.', 'error');
			}
		}
	}

	private async renderWorkspaceGraph(requestId?: number): Promise<void> {
		const effectiveRequestId = requestId ?? ++this._renderRequestId;
		if (requestId === undefined) {
			this._promptInFlight = true;
		}
		try {
			await this.sendStatus('Scanning workspace for imports…', 'loading');
			const payload = await this.dataBuilder.buildGraphForScope(
				this.context.getWorkspaceFolders().map(folder => folder.uri),
				'workspace'
			);
			const graphPayload: GraphWebviewPayload = payload;
			if (effectiveRequestId !== this._renderRequestId) {
				return;
			}
			this.storeGraphPayload(graphPayload);
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload: graphPayload });
			if (this.getNodeCount(graphPayload) === 0) {
				await this.sendStatus('No source files found in the workspace to visualize.', 'warning', 4000);
			} else {
				await this.sendStatus('Rendered workspace import graph.', 'success', 4000);
			}
		} catch (error) {
			this.logService.error('[GraphView] failed to build workspace graph', error);
			if (effectiveRequestId === this._renderRequestId) {
				await this.sendStatus('Failed to build workspace graph. Check logs for details.', 'error');
			}
		} finally {
			if (requestId === undefined && effectiveRequestId === this._renderRequestId) {
				this._promptInFlight = false;
			}
		}
	}

	private async renderGitHeatmap(requestId: number): Promise<void> {
		await this.sendStatus(`Mining Git history (last ${this._heatmapWindowDays} days)…`, 'loading');
		try {
			const payload = await this.dataBuilder.buildGitHeatmap({
				windowDays: this._heatmapWindowDays,
				granularity: this._heatmapGranularity,
			});
			if (requestId !== this._renderRequestId) {
				return;
			}
			this._currentGraph = undefined;
			this._latestHeatmap = payload.heatmap ?? null;
			this.updateToolbarUI();
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload });
			this.updateHeatmapSummary(payload.heatmap ?? null);
			if (payload.heatmap) {
				await this.sendStatus(`Rendered Git heatmap across ${payload.heatmap.modules.length} modules.`, 'success', 6000);
			} else {
				await this.sendStatus('Git heatmap data unavailable.', 'warning', 4000);
			}
		} catch (error) {
			this.logService.error('[GraphView] failed to build git heatmap', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to build Git heatmap. Check logs for details.', 'error');
			}
		}
	}

	private async renderArchitectureGraph(requestId: number): Promise<void> {
		await this.sendStatus('Analyzing project architecture…', 'loading');
		const progressListeners = new DisposableStore();
		try {
			progressListeners.add(this.dataBuilder.onArchitectureProgress(message => {
				if (typeof message === 'string' && message.trim().length) {
					void this.sendStatus(message, 'loading');
				}
			}));
			const payload = await this.dataBuilder.buildArchitectureGraph();
			if (requestId !== this._renderRequestId) {
				return;
			}
			this.storeGraphPayload(payload);
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload });
			const nodeCount = this.getNodeCount(payload);
			this.logService.info('[GraphView] architecture graph result', { nodes: nodeCount, edges: this.getEdgeCount(payload) });
			if (nodeCount === 0) {
				await this.sendStatus('Unable to detect architecture components in this workspace. Falling back to import graph.', 'warning', 6000);
				await this.renderWorkspaceGraph(requestId);
				return;
			}
			await this.sendStatus(`Rendered architecture graph (${nodeCount} components).`, 'success', 4000);
			if (Array.isArray(payload.warnings) && payload.warnings.length) {
				await this.sendStatus(payload.warnings[0], 'warning', 6000);
			}
		} catch (error) {
			this.logService.error('[GraphView] failed to build architecture graph', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to analyze architecture. Check logs for details.', 'error');
			}
		} finally {
			progressListeners.dispose();
		}
	}

	private storeGraphPayload(payload: GraphWebviewPayload): void {
		const nodeById = new Map<string, GraphNodePayload>();
		const nodeByResourceKey = new Map<string, GraphNodePayload>();
		for (const node of payload.nodes ?? []) {
			nodeById.set(node.id, node);
			const resourceKey = this.getResourceKeyFromNode(node);
			if (resourceKey) {
				nodeByResourceKey.set(resourceKey, node);
			}
		}
		const edgeById = new Map<string, GraphEdgePayload>();
		for (const edge of payload.edges ?? []) {
			edgeById.set(edge.id, edge);
		}
		this._currentGraph = { payload, nodeById, edgeById, nodeByResourceKey };
	}

	private getResourceKeyFromNode(node: GraphNodePayload): string | undefined {
		if (!node?.path) {
			return undefined;
		}
		const resource = this.safeParseUri(node.path);
		if (!resource) {
			return undefined;
		}
		return this.getResourceKey(resource);
	}

	private getResourceKey(resource: URI): string {
		return this.context.getUriKey(resource);
	}

	private handleGraphEvent(event: unknown): void {
		if (!event || typeof event !== 'object') {
			return;
		}
		const { type, data } = event as { type?: string; data?: unknown };
		switch (type) {
			case 'heatmap-cell':
				this.onHeatmapCellSelected(data);
				break;
			case 'heatmap-hover':
				this.onHeatmapHover(data);
				break;
			case 'heatmap-selection-cleared':
				this.onHeatmapSelectionCleared();
				break;
			case 'heatmap-mode-change':
				if (data && typeof data === 'object') {
					const eventData = data as { mode?: unknown };
					if (eventData.mode !== undefined) {
						const mode = eventData.mode;
						if (typeof mode === 'string') {
							this.applyModeChange(mode as GraphMode);
						}
					}
				}
				break;
			case 'heatmap-refresh':
				void this.promptForTargetAndRender();
				break;
			case 'heatmap-granularity-change':
				if (data && typeof data === 'object') {
					const eventData = data as { granularity?: unknown };
					if (eventData.granularity !== undefined) {
						const granularity = eventData.granularity;
						if (typeof granularity === 'string' && ['topLevel', 'twoLevel', 'file'].includes(granularity)) {
							this._heatmapGranularity = granularity as GitHeatmapGranularity;
							this.handleHeatmapSettingChanged();
						}
					}
				}
				break;
			case 'heatmap-window-change':
				if (data && typeof data === 'object') {
					const eventData = data as { windowDays?: unknown };
					if (eventData.windowDays !== undefined) {
						const windowDays = eventData.windowDays;
						if (typeof windowDays === 'number' && windowDays > 0) {
							this._heatmapWindowDays = windowDays;
							this.handleHeatmapSettingChanged();
						}
					}
				}
				break;
			case 'selection-mode-changed':
				this._selectionModeEnabled = !!(data && typeof data === 'object' && (data as { enabled?: unknown }).enabled);
				this.logService.debug('[GraphView] selection mode changed', this._selectionModeEnabled);
				break;
			case 'selection-node':
				this.logService.debug('[GraphView] node highlighted', data ?? '');
				break;
			case 'selection-cleared':
				this.logService.debug('[GraphView] selection cleared');
				break;
			case 'node-tap':
				if (this._selectionModeEnabled) {
					this.logService.debug('[GraphView] ignoring node tap while selection mode enabled');
					break;
				}
				void this.onNodeTap(data);
				break;
			case 'edge-tap':
				if (this._selectionModeEnabled) {
					this.logService.debug('[GraphView] ignoring edge tap while selection mode enabled');
					break;
				}
				void this.onEdgeTap(data);
				break;
			default:
				break;
		}
	}

	private async onNodeTap(rawNode: unknown): Promise<void> {
		if (!rawNode || typeof rawNode !== 'object') {
			return;
		}
		const node = rawNode as { id?: unknown; path?: unknown; kind?: unknown; openable?: unknown };
		if (node.kind === 'external') {
			return;
		}
		const nodePayload = this.resolveNodePayload(node);
		const resource = this.safeParseUri(node.path) ?? this.safeParseUri(nodePayload?.path);
		if (!resource) {
			this.logService.warn('[GraphView] node tap missing resource', node);
			return;
		}
		if (!this.isResourceOpenable(resource, nodePayload)) {
			await this.notifyUnopenable(resource, 'node', 'node-blocked');
			return;
		}
		await this.openResourceInSideGroup(resource);
	}

	private async onEdgeTap(rawEdge: unknown): Promise<void> {
		if (!rawEdge || typeof rawEdge !== 'object') {
			return;
		}
		const edge = rawEdge as { id?: unknown; target?: unknown; source?: unknown; targetPath?: unknown; sourcePath?: unknown; symbols?: unknown; specifier?: unknown };
		let targetResource = this.safeParseUri(edge.targetPath);
		let sourceResource = this.safeParseUri(edge.sourcePath);
		let symbolNames = this.sanitizeSymbolNames(edge.symbols);
		if (this._currentGraph) {
			if (!targetResource && typeof edge.target === 'string') {
				const node = this._currentGraph.nodeById.get(edge.target);
				if (node) {
					targetResource = this.safeParseUri(node.path);
				}
			}
			if (!sourceResource && typeof edge.source === 'string') {
				const node = this._currentGraph.nodeById.get(edge.source);
				if (node) {
					sourceResource = this.safeParseUri(node.path);
				}
			}
			if (!symbolNames.length && typeof edge.id === 'string') {
				const storedEdge = this._currentGraph.edgeById.get(edge.id);
				if (storedEdge) {
					if (!targetResource && storedEdge.targetPath) {
						targetResource = this.safeParseUri(storedEdge.targetPath);
					}
					if (!sourceResource && storedEdge.sourcePath) {
						sourceResource = this.safeParseUri(storedEdge.sourcePath);
					}
					symbolNames = this.sanitizeSymbolNames(storedEdge.symbols);
				}
			}
		}
		const resourceToOpen = targetResource ?? sourceResource;
		if (!resourceToOpen) {
			return;
		}
		if (!this.isResourceOpenable(resourceToOpen)) {
			await this.notifyUnopenable(resourceToOpen, 'edge', 'edge-blocked');
			return;
		}

		let selection: Range | undefined;
		if (targetResource && this.areResourcesEqual(resourceToOpen, targetResource) && symbolNames.length) {
			selection = await this.findSymbolRange(targetResource, symbolNames);
		}
		if (!selection && sourceResource && this.areResourcesEqual(resourceToOpen, sourceResource) && typeof edge.specifier === 'string') {
			selection = await this.findImportRange(sourceResource, edge.specifier);
		}

		await this.openResourceInSideGroup(resourceToOpen, selection);
	}

	private areResourcesEqual(a: URI, b: URI): boolean {
		return this.context.extUri.isEqual(a, b);
	}

	private safeParseUri(value: unknown): URI | undefined {
		if (!value) {
			return undefined;
		}
		if (value instanceof URI) {
			return value;
		}
		if (typeof value === 'string') {
			if (value.includes('://')) {
				try {
					return URI.parse(value);
				} catch (error) {
					this.logService.debug('[GraphView] failed to parse URI from graph event', value, error);
				}
			}
			const workspaceRoot = this.context.getDefaultWorkspaceRoot();
			if (workspaceRoot) {
				const normalized = value.startsWith('/') ? value.slice(1) : value;
				try {
					return this.context.extUri.joinPath(workspaceRoot, normalized);
				} catch (error) {
					this.logService.debug('[GraphView] failed to join workspace path for graph event', value, error);
				}
			}
			const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value);
			if (value.startsWith('/') || isWindowsAbsolute) {
				try {
					return URI.file(value);
				} catch (error) {
					this.logService.debug('[GraphView] failed to treat absolute path as file URI', value, error);
				}
			}
			const absoluteCandidate = value.startsWith('/') ? value : `/${value}`;
			try {
				return URI.file(absoluteCandidate);
			} catch (error) {
				this.logService.debug('[GraphView] failed to treat path as file URI', value, error);
			}
		}
		return undefined;
	}

	private async notifyUnopenable(resource: URI, context: 'node' | 'edge', reason: string): Promise<void> {
		this.logService.info('[GraphView] skipping open for resource', { resource: resource.toString(true), context, reason });
		await this.sendStatus('Cannot open this item because it is excluded from the workspace.', 'warning', 4000);
	}

	private isResourceOpenable(resource: URI, nodePayload?: GraphNodePayload | null): boolean {
		const node = nodePayload ?? this.getNodeForResource(resource);
		if (node) {
			if (!node.openable) {
				this.logService.info('[GraphView] resource flagged non-openable by node payload', resource.toString(true));
			}
			return !!node.openable;
		}
		if (!this.context.isWithinWorkspace(resource)) {
			this.logService.info('[GraphView] resource outside workspace', resource.toString(true));
			return false;
		}
		if (isExcludedPath(resource.path)) {
			this.logService.info('[GraphView] resource matches excluded path', resource.toString(true));
			return false;
		}
		return true;
	}

	private async openResourceInSideGroup(resource: URI, selection?: Range): Promise<void> {
		if (!this.isResourceOpenable(resource)) {
			await this.notifyUnopenable(resource, 'node', 'resource-blocked');
			return;
		}
		let editorInput: IResourceEditorInput;
		if (selection) {
			const options: ITextEditorOptions = {
				selection: {
					startLineNumber: selection.startLineNumber,
					startColumn: selection.startColumn,
					endLineNumber: selection.endLineNumber,
					endColumn: selection.endColumn
				},
				selectionRevealType: TextEditorSelectionRevealType.NearTopIfOutsideViewport
			};
			editorInput = { resource, options };
		} else {
			editorInput = { resource };
		}

		const preferredGroup = this.resolvePreferredEditorGroup(resource);
		try {
			const editorPane = await this.editorService.openEditor(editorInput, preferredGroup);
			const groupId = editorPane?.group?.id;
			if (groupId !== undefined) {
				this._codeViewGroupId = groupId;
			}
			this.logService.info('[GraphView] opened editor', resource.toString(true), groupId ?? preferredGroup);
		} catch (error) {
			this.logService.error('[GraphView] failed to open editor', resource.toString(true), error);
		}
	}

	private resolvePreferredEditorGroup(resource: URI): GroupIdentifier | typeof SIDE_GROUP {
		const existingEditors = this.editorService.findEditors(resource, { supportSideBySide: SideBySideEditor.ANY });
		if (existingEditors.length > 0) {
			return existingEditors[0].groupId;
		}

		const emptyGroup = this.findEmptyCodeGroup();
		if (emptyGroup !== undefined) {
			return emptyGroup;
		}

		const activeGroupCandidate = this.pickActiveCodeGroup();
		if (activeGroupCandidate !== undefined) {
			return activeGroupCandidate;
		}

		const trackedGroup = this.getTrackedCodeViewGroupId();
		if (trackedGroup !== undefined) {
			return trackedGroup;
		}

		return SIDE_GROUP;
	}

	private resolveNodePayload(node: { id?: unknown; path?: unknown }): GraphNodePayload | undefined {
		if (typeof node.id === 'string') {
			const byId = this._currentGraph?.nodeById.get(node.id);
			if (byId) {
				return byId;
			}
		}
		if (typeof node.path === 'string') {
			const resource = this.safeParseUri(node.path);
			if (resource) {
				return this.getNodeForResource(resource);
			}
		}
		return undefined;
	}

	private getNodeForResource(resource: URI): GraphNodePayload | undefined {
		if (!this._currentGraph) {
			return undefined;
		}
		return this._currentGraph.nodeByResourceKey.get(this.getResourceKey(resource));
	}

	private pickActiveCodeGroup(): GroupIdentifier | undefined {
		const activeGroup = this.editorGroupsService.activeGroup;
		if (!activeGroup) {
			return undefined;
		}
		if (this.editorGroupsService.count <= 1) {
			return undefined;
		}
		if (!this.groupSupportsCodeEditors(activeGroup)) {
			return undefined;
		}
		return activeGroup.id;
	}

	private findEmptyCodeGroup(): GroupIdentifier | undefined {
		const groups = this.editorGroupsService.groups;
		for (let i = groups.length - 1; i >= 0; i--) {
			const group = groups[i];
			if (group.count === 0 && this.groupSupportsCodeEditors(group)) {
				return group.id;
			}
		}
		return undefined;
	}

	private getTrackedCodeViewGroupId(): GroupIdentifier | undefined {
		if (this._codeViewGroupId !== undefined) {
			if (this.isGroupPresent(this._codeViewGroupId) && this.groupSupportsCodeEditorsById(this._codeViewGroupId)) {
				return this._codeViewGroupId;
			}
			this._codeViewGroupId = undefined;
		}

		const existingGroup = this.findExistingCodeViewGroup();
		if (existingGroup !== undefined) {
			this._codeViewGroupId = existingGroup;
		}
		return this._codeViewGroupId;
	}

	private isGroupPresent(groupId: GroupIdentifier): boolean {
		return this.editorGroupsService.groups.some(group => group.id === groupId);
	}

	private findExistingCodeViewGroup(): GroupIdentifier | undefined {
		const groups = this.editorGroupsService.groups;
		if (groups.length <= 1) {
			return undefined;
		}
		const activeGroupId = this.editorGroupsService.activeGroup?.id;
		for (const group of groups) {
			if (group.id === activeGroupId) {
				continue;
			}
			if (this.groupSupportsCodeEditors(group)) {
				return group.id;
			}
		}
		return undefined;
	}

	private groupSupportsCodeEditorsById(groupId: GroupIdentifier): boolean {
		const group = this.editorGroupsService.groups.find(candidate => candidate.id === groupId);
		return !!group && this.groupSupportsCodeEditors(group);
	}

	private groupSupportsCodeEditors(group: IEditorGroup): boolean {
		const pane = group.activeEditorPane;
		if (!pane) {
			return true;
		}
		const control = pane.getControl();
		return !!control && (isCodeEditor(control) || isDiffEditor(control));
	}

	private sanitizeSymbolNames(symbols: unknown): string[] {
		if (!Array.isArray(symbols)) {
			return [];
		}
		const unique = new Set<string>();
		for (const entry of symbols) {
			if (typeof entry !== 'string') {
				continue;
			}
			let value = entry.trim();
			if (!value) {
				continue;
			}
			value = value.replace(/\s*\(type\)$/i, '');
			if (/^\*\s+as\s+/i.test(value)) {
				value = value.replace(/^\*\s+as\s+/i, '');
			}
			const asMatch = /^(.*)\s+as\s+(.*)$/i.exec(value);
			if (asMatch) {
				if (asMatch[1]?.trim()) {
					unique.add(asMatch[1].trim());
				}
				if (asMatch[2]?.trim()) {
					unique.add(asMatch[2].trim());
				}
				continue;
			}
			unique.add(value);
		}
		return Array.from(unique);
	}

	private buildSymbolRegexes(name: string): RegExp[] {
		const escaped = escapeRegExpCharacters(name);
		return [
			new RegExp(`^\\s*export\\s+default\\s+function\\s+${escaped}\\b`),
			new RegExp(`^\\s*export\\s+async\\s+function\\s+${escaped}\\b`),
			new RegExp(`^\\s*export\\s+function\\s+${escaped}\\b`),
			new RegExp(`^\\s*async\\s+function\\s+${escaped}\\b`),
			new RegExp(`^\\s*function\\s+${escaped}\\b`),
			new RegExp(`^\\s*export\\s+(const|let|var)\\s+${escaped}\\s*=`),
			new RegExp(`^\\s*(const|let|var)\\s+${escaped}\\s*=`),
			new RegExp(`^\\s*export\\s+default\\s+class\\s+${escaped}\\b`),
			new RegExp(`^\\s*export\\s+class\\s+${escaped}\\b`),
			new RegExp(`^\\s*class\\s+${escaped}\\b`)
		];
	}

	private async findSymbolRange(resource: URI, symbolNames: string[]): Promise<Range | undefined> {
		if (!symbolNames.length) {
			return undefined;
		}
		const lines = await this.readFileLines(resource);
		if (!lines) {
			return undefined;
		}

		let best: { line: number; column: number; length: number } | undefined;
		let defaultExportLine: number | undefined;
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i];
			if (defaultExportLine === undefined && /^\s*export\s+default\b/.test(lineText)) {
				defaultExportLine = i;
			}
			let matched = false;
			for (const name of symbolNames) {
				for (const regex of this.buildSymbolRegexes(name)) {
					const match = regex.exec(lineText);
					if (match) {
						const column = (match.index ?? 0) + 1;
						const length = lineText.length + 1;
						if (!best || i < best.line || (i === best.line && column < best.column)) {
							best = { line: i, column, length };
						}
						matched = true;
						break;
					}
				}
				if (matched) {
					break;
				}
			}
		}

		if (best) {
			const lineNumber = best.line + 1;
			const column = best.column;
			return new Range(lineNumber, column, lineNumber, best.length);
		}
		if (defaultExportLine !== undefined) {
			const lineNumber = defaultExportLine + 1;
			const length = (lines[defaultExportLine]?.length ?? 0) + 1;
			return new Range(lineNumber, 1, lineNumber, length);
		}
		return undefined;
	}

	private async findImportRange(resource: URI, specifier: string): Promise<Range | undefined> {
		if (!specifier) {
			return undefined;
		}
		const lines = await this.readFileLines(resource);
		if (!lines) {
			return undefined;
		}
		const escaped = escapeRegExpCharacters(specifier);
		const matcher = new RegExp(escaped, 'g');
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i];
			if (!/^\s*import\s+/.test(lineText)) {
				continue;
			}
			const match = matcher.exec(lineText);
			if (match) {
				const column = (match.index ?? 0) + 1;
				const lineNumber = i + 1;
				return new Range(lineNumber, column, lineNumber, column + specifier.length);
			}
			matcher.lastIndex = 0;
		}
		return undefined;
	}

	private async readFileLines(resource: URI): Promise<string[] | undefined> {
		try {
			const buffer = await this.fileService.readFile(resource);
			const content = buffer.value.toString();
			return content.split(/\r?\n/);
		} catch (error) {
			this.logService.error('[GraphView] failed to read file for graph selection', resource.toString(true), error);
			return undefined;
		}
	}

	private showGraphFailed(container: HTMLElement): void {
		if (!container) {
			return;
		}
		container.textContent = '';
		const msg = document.createElement('div');
		msg.style.padding = '12px';
		msg.style.color = 'var(--vscode-errorForeground)';
		msg.textContent = 'Graph failed to load.';
		container.appendChild(msg);
	}

	private getModeLabel(mode: GraphMode): string {
		switch (mode) {
			case 'workspace':
				return 'Workspace';
			case 'folder':
				return 'Folder';
			case 'architecture':
				return 'Architecture';
			case 'gitHeatmap':
				return 'Git Heatmap';
			case 'file':
			default:
				return 'File';
		}
	}

	private getReadyMessage(): string {
		switch (this._mode) {
			case 'workspace':
				return 'Rendering entire workspace import graph…';
			case 'folder':
				return 'Select a folder to visualize its imports.';
			case 'architecture':
				return 'Analyze the workspace to discover its architecture.';
			case 'gitHeatmap':
				return 'Generate a Git co-change heatmap for your workspace.';
			case 'file':
			default:
				return 'Select a file to visualize its imports.';
		}
	}

	private getEdgeCount(payload: GraphWebviewPayload): number {
		const value = (payload as unknown as { edges?: unknown }).edges;
		return Array.isArray(value) ? value.length : 0;
	}

	private getNodeCount(payload: GraphWebviewPayload): number {
		const value = (payload as unknown as { nodes?: unknown }).nodes;
		return Array.isArray(value) ? value.length : 0;
	}

	private async sendStatus(message: string, level: GraphStatusLevel, autoClearMs?: number): Promise<void> {
		if (!this._webview) {
			return;
		}
		try {
			await this._webview.postMessage({ type: 'REN_GRAPH_STATUS', payload: { message, level, autoClearMs } });
		} catch (error) {
			this.logService.debug('[GraphView] failed to post status to webview', error);
		}
	}
}

