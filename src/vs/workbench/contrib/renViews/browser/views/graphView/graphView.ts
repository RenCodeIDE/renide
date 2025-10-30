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
import { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { URI } from '../../../../../../base/common/uri.js';

import { buildGraphWebviewHTML } from '../../templates/graphWebviewTemplate.js';
import { GraphWorkspaceContext } from './graphContext.js';
import { GraphDataBuilder } from './graphDataBuilder.js';
import { GraphPickers } from './graphPickers.js';
import { GraphMode, GraphStatusLevel, GraphWebviewPayload } from './graphTypes.js';

export class GraphView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _toolbar: HTMLElement | null = null;
	private _modeButton: HTMLButtonElement | null = null;
	private _targetButton: HTMLButtonElement | null = null;
	private _window: Window | null = null;
	private _webview: IWebviewElement | null = null;
	private _graphReady = false;
	private _promptInFlight = false;
	private _renderRequestId = 0;
	private _mode: GraphMode = 'file';
	private _selectedFile: URI | undefined;
	private _selectedFolder: URI | undefined;

	private readonly context: GraphWorkspaceContext;
	private readonly dataBuilder: GraphDataBuilder;
	private readonly pickers: GraphPickers;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISearchService searchService: ISearchService
	) {
		super();
		this.context = new GraphWorkspaceContext(workspaceService, uriIdentityService);
		this.dataBuilder = new GraphDataBuilder(this.logService, fileService, searchService, this.context);
		this.pickers = new GraphPickers(this.quickInputService, searchService, fileService, this.logService, this.context);
	}

	show(contentArea: HTMLElement): void {
		this.logService.info('[GraphView] show()');
		contentArea.textContent = '';

		this._window = getWindow(contentArea);
		this._graphReady = false;
		this._promptInFlight = false;
		this._renderRequestId++;

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

	hide(): void {
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

		const modeButton = document.createElement('button');
		modeButton.className = 'ren-graph-toolbar-btn';
		modeButton.addEventListener('click', () => {
			void this.pickGraphMode();
		});
		toolbar.appendChild(modeButton);
		this._modeButton = modeButton;

		const targetButton = document.createElement('button');
		targetButton.className = 'ren-graph-toolbar-btn';
		targetButton.addEventListener('click', () => {
			void this.promptForTargetAndRender();
		});
		toolbar.appendChild(targetButton);
		this._targetButton = targetButton;

		this._toolbar = toolbar;
		this.updateToolbarUI();
		return toolbar;
	}

	private updateToolbarUI(): void {
		if (this._modeButton) {
			this._modeButton.textContent = `Mode: ${this.getModeLabel(this._mode)}`;
			this._modeButton.title = 'Click to change graph scope';
		}
		if (this._targetButton) {
			switch (this._mode) {
				case 'workspace':
					this._targetButton.textContent = 'Render Workspace';
					this._targetButton.title = 'Visualize dependencies for the entire workspace';
					break;
				case 'folder':
					this._targetButton.textContent = this._selectedFolder
						? `Folder: ${this.context.formatNodeLabel(this._selectedFolder)} (Change…)`
						: 'Select Folder…';
					this._targetButton.title = 'Choose a folder to visualize';
					break;
				case 'file':
				default:
					this._targetButton.textContent = this._selectedFile
						? `File: ${this.context.formatNodeLabel(this._selectedFile)} (Change…)`
						: 'Select File…';
					this._targetButton.title = 'Choose a file to visualize';
					break;
			}
		}
	}

	private async pickGraphMode(): Promise<void> {
		const pick = this.quickInputService.createQuickPick<IQuickPickItem & { mode: GraphMode }>();
		pick.placeholder = 'Select graph scope';
		pick.items = [
			{ label: 'File', description: 'Visualize imports for a single file', mode: 'file' },
			{ label: 'Folder', description: 'Visualize imports within a folder', mode: 'folder' },
			{ label: 'Workspace', description: 'Visualize imports across the entire workspace', mode: 'workspace' }
		];
		pick.activeItems = pick.items.filter(item => item.mode === this._mode);
		const disposables = new DisposableStore();
		disposables.add(pick);

		return new Promise(resolve => {
			disposables.add(pick.onDidAccept(() => {
				const selection = pick.selectedItems[0];
				if (selection) {
					this._mode = selection.mode;
					if (this._mode !== 'file') {
						this._selectedFile = undefined;
					}
					if (this._mode !== 'folder') {
						this._selectedFolder = undefined;
					}
					this.updateToolbarUI();
					void this.sendStatus(this.getReadyMessage(), 'info');
					if (this._mode === 'workspace' && this._graphReady) {
						void this.promptForTargetAndRender();
					}
				}
				pick.hide();
			}));
			disposables.add(pick.onDidHide(() => {
				disposables.dispose();
				resolve();
			}));
			pick.show();
		});
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

