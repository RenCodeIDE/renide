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
import { IEditorService, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
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
import { GraphEdgePayload, GraphMode, GraphNodePayload, GraphStatusLevel, GraphWebviewPayload } from './graphTypes.js';
import { isExcludedPath } from './graphConstants.js';

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
	private _currentGraph:
		| {
			payload: GraphWebviewPayload;
			nodeById: Map<string, GraphNodePayload>;
			edgeById: Map<string, GraphEdgePayload>;
			nodeByResourceKey: Map<string, GraphNodePayload>;
		}
		| undefined;
	private _codeViewGroupId: GroupIdentifier | undefined;

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
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService
	) {
		super();
		this.context = new GraphWorkspaceContext(workspaceService, uriIdentityService);
		this.dataBuilder = new GraphDataBuilder(this.logService, this.fileService, searchService, this.context);
		this.pickers = new GraphPickers(this.quickInputService, searchService, this.fileService, this.logService, this.context);
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
		this._currentGraph = undefined;
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
			case 'node-tap':
				void this.onNodeTap(data);
				break;
			case 'edge-tap':
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

