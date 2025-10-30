import { Disposable } from '../../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { ensureCodeWindow, CodeWindow } from '../../../../../base/browser/window.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { asWebviewUri } from '../../../webview/common/webview.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IRenView } from './renView.interface.js';
import { IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../../base/common/uri.js';

type GraphNodeKind = 'root' | 'relative' | 'external';

interface GraphNodePayload {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly kind: GraphNodeKind;
}

type GraphEdgeKind = 'relative' | 'external' | 'sideEffect';

interface GraphEdgePayload {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	label: string;
	readonly specifier: string;
	kind: GraphEdgeKind;
}

interface GraphWebviewPayload {
	readonly nodes: GraphNodePayload[];
	readonly edges: GraphEdgePayload[];
}

interface ImportDescriptor {
	specifier: string;
	defaultImport?: { name: string; isTypeOnly: boolean };
	namespaceImport?: { name: string; isTypeOnly: boolean };
	namedImports: Array<{ name: string; propertyName?: string; isTypeOnly: boolean }>;
	isSideEffectOnly: boolean;
}

type GraphStatusLevel = 'info' | 'warning' | 'error' | 'loading' | 'success';

export class GraphView extends Disposable implements IRenView {
	private static readonly FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
	private static readonly INDEX_FILENAMES = this.FILE_EXTENSIONS.map(ext => `index${ext}`);
	private _mainContainer: HTMLElement | null = null;
	private _toolbar: HTMLElement | null = null;
	private _window: Window | null = null;
	private _webview: IWebviewElement | null = null;
	private _graphReady = false;
	private _promptInFlight = false;
	private _renderRequestId = 0;
	private _lastSelectedFile: URI | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();
	}

	show(contentArea: HTMLElement): void {
		this.logService.info('[GraphView] show()');
		// Clear existing content safely
		contentArea.textContent = '';

		// Store window reference
		this._window = getWindow(contentArea);
		this._graphReady = false;
		this._promptInFlight = false;
		this._renderRequestId++;
		this._lastSelectedFile = undefined;

		// Create main container
		this._mainContainer = document.createElement('div');
		this._mainContainer.className = 'ren-graph-container';
		// Ensure container participates in layout and fills available space
		this._mainContainer.style.display = 'flex';
		this._mainContainer.style.flexDirection = 'column';
		this._mainContainer.style.height = '100%';

		// Create title
		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.className = 'ren-graph-title';

		// Create viewport container
		const viewport = document.createElement('div');
		viewport.className = 'ren-graph-viewport';
		viewport.style.position = 'relative';
		viewport.style.flex = '1 1 auto';
		viewport.style.minHeight = '240px';

		this._mainContainer.appendChild(title);
		this._mainContainer.appendChild(viewport);

		// Create toolbar for view switching
		this.createToolbar();
		this._mainContainer.appendChild(this._toolbar!);

		contentArea.appendChild(this._mainContainer);

		// Load Cytoscape into a real Webview element
		void this.loadWebview(viewport);
	}


	private async loadWebview(container: HTMLElement): Promise<void> {
		if (!this._window) {
			return;
		}

		// Create workbench webview element (matches Getting Started and other views)
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
			extension: undefined,
		});

		// Claim and mount the webview properly
		const win = this._window!;
		ensureCodeWindow(win, 1);
		this._webview.mountTo(container, win as unknown as CodeWindow);
		this._register(this._webview);
		container.style.position = container.style.position || 'relative';
		container.style.height = '100%';

		// Build HTML with proper CSP using webview's built-in system
		const mediaRoot = FileAccess.asFileUri('vs/workbench/contrib/renViews/browser/media/');
		const libUri = asWebviewUri(joinPath(mediaRoot, 'cytoscape.min.js')).toString(true);
		const nonce = generateUuid();
		const html = this.buildWebviewHTMLForPanel(libUri, nonce);
		this._webview.setHtml(html);
		this._graphReady = false;

		// Basic failure indicator
		const failTimer = this._window.setTimeout(() => {
			this.logService.error('[GraphView] graph failed to load (timeout)');
			this.showGraphFailed(container);
			void this.sendStatus('Graph webview failed to load.', 'error');
		}, 5000);

		// Set up proper webview event handling (following VS Code patterns)
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
					void this.sendStatus('Select a file to visualize its imports.', 'info');
					void this.promptForFileAndRender();
					break;
				}
				case 'REN_SELECT_FILE':
					this.logService.info('[GraphView] select file requested from webview');
					void this.promptForFileAndRender();
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

	// old iframe builder removed

	private createToolbar(): void {
		if (!this._mainContainer) {
			return;
		}

		this._toolbar = document.createElement('div');
		this._toolbar.className = 'ren-graph-toolbar';

		const codeButton = document.createElement('button');
		codeButton.className = 'ren-graph-toolbar-btn';
		codeButton.textContent = 'Code';
		codeButton.title = 'Switch to Code View';
		codeButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'code' }));
		});
		this._toolbar.appendChild(codeButton);

		const previewButton = document.createElement('button');
		previewButton.className = 'ren-graph-toolbar-btn';
		previewButton.textContent = 'Preview';
		previewButton.title = 'Switch to Preview View';
		previewButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'preview' }));
		});
		this._toolbar.appendChild(previewButton);

		const graphButton = document.createElement('button');
		graphButton.className = 'ren-graph-toolbar-btn active';
		graphButton.textContent = 'Graph';
		graphButton.title = 'Already in Graph View';
		graphButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'graph' }));
		});
		this._toolbar.appendChild(graphButton);

		const selectFileButton = document.createElement('button');
		selectFileButton.className = 'ren-graph-toolbar-btn';
		selectFileButton.textContent = 'Select File...';
		selectFileButton.title = 'Choose a file to visualize imports';
		selectFileButton.addEventListener('click', () => {
			void this.promptForFileAndRender();
		});
		this._toolbar.appendChild(selectFileButton);
	}

	hide(): void {
		if (this._mainContainer) {
			this._mainContainer.remove();
			this._mainContainer = null;
			this._toolbar = null;
		}
		// Properly dispose of webview
		if (this._webview) {
			this._webview.dispose();
			this._webview = null;
		}
		this._graphReady = false;
		this._promptInFlight = false;
		this._lastSelectedFile = undefined;
	}

	private showGraphFailed(container: HTMLElement): void {
		// Replace viewport content with a minimal failure notice
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

	private async promptForFileAndRender(): Promise<void> {
		if (!this._webview) {
			return;
		}
		if (!this._graphReady) {
			this.logService.debug('[GraphView] prompt requested before graph ready, skipping');
			return;
		}
		if (this._promptInFlight) {
			this.logService.debug('[GraphView] prompt already in flight');
			return;
		}

		this._promptInFlight = true;
		const requestId = ++this._renderRequestId;
		await this.sendStatus('Waiting for file selection...', 'loading');

		let sourceUri: URI | undefined;
		try {
			sourceUri = await this.pickSourceFile();
		} catch (error) {
			this.logService.error('[GraphView] error selecting file', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to open file picker.', 'error');
			}
			this._promptInFlight = false;
			return;
		}

		if (requestId !== this._renderRequestId) {
			this._promptInFlight = false;
			return;
		}

		if (!sourceUri) {
			await this.sendStatus('No file selected.', 'warning', 4000);
			this._promptInFlight = false;
			return;
		}

		this._lastSelectedFile = sourceUri;
		await this.sendStatus('Building import graph...', 'loading');

		try {
			const payload = await this.buildGraphPayload(sourceUri);
			if (requestId !== this._renderRequestId) {
				return;
			}
			await this._webview.postMessage({ type: 'REN_GRAPH_DATA', payload });
			if (payload.edges.length === 0) {
				await this.sendStatus('No import statements found in the selected file.', 'warning', 5000);
			} else {
				await this.sendStatus(`Rendered imports for ${this.formatNodeLabel(sourceUri)}.`, 'success', 4000);
			}
		} catch (error) {
			this.logService.error('[GraphView] failed to build graph', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to build graph. Check logs for details.', 'error');
			}
		} finally {
			if (requestId === this._renderRequestId) {
				this._promptInFlight = false;
			}
		}
	}

	private async pickSourceFile(): Promise<URI | undefined> {
		const options = this.getOpenDialogOptions();
		const selection = await this.fileDialogService.showOpenDialog(options);
		if (!selection || selection.length === 0) {
			return undefined;
		}
		return selection[0];
	}

	private getOpenDialogOptions(): IOpenDialogOptions {
		const filters = GraphView.FILE_EXTENSIONS.map(ext => ext.replace('.', ''));
		const dialogFilters = [
			{ name: 'JavaScript / TypeScript', extensions: filters },
			{ name: 'All Files', extensions: ['*'] }
		];
		const options: IOpenDialogOptions = {
			title: 'Select file to visualize imports',
			openLabel: 'Select file',
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: dialogFilters
		};
		const defaultUri = this.getDefaultDialogUri();
		if (defaultUri) {
			options.defaultUri = defaultUri;
		}
		return options;
	}

	private getDefaultDialogUri(): URI | undefined {
		if (this._lastSelectedFile) {
			return dirname(this._lastSelectedFile);
		}
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders[0]?.uri;
	}

	private async buildGraphPayload(sourceUri: URI): Promise<GraphWebviewPayload> {
		const buffer = await this.fileService.readFile(sourceUri);
		const content = buffer.value.toString();
		const descriptors = this.extractImportDescriptors(content);
		const nodes = new Map<string, GraphNodePayload>();
		const edges = new Map<string, { payload: GraphEdgePayload; symbols: Set<string> }>();
		const rootId = this.toNodeId(sourceUri);
		nodes.set(rootId, {
			id: rootId,
			label: this.formatNodeLabel(sourceUri),
			path: sourceUri.toString(true),
			kind: 'root'
		});

		for (const descriptor of descriptors) {
			const resolvedUri = await this.resolveImportTarget(sourceUri, descriptor.specifier);
			const edgeKind: GraphEdgeKind = descriptor.isSideEffectOnly ? 'sideEffect' : (resolvedUri ? 'relative' : 'external');
			let targetId: string;
			if (resolvedUri) {
				targetId = this.toNodeId(resolvedUri);
				if (!nodes.has(targetId)) {
					nodes.set(targetId, {
						id: targetId,
						label: this.formatNodeLabel(resolvedUri),
						path: resolvedUri.toString(true),
						kind: 'relative'
					});
				}
			} else {
				targetId = this.toNodeId(`module:${descriptor.specifier}`);
				if (!nodes.has(targetId)) {
					nodes.set(targetId, {
						id: targetId,
						label: descriptor.specifier,
						path: descriptor.specifier,
						kind: 'external'
					});
				}
			}

			const edgeKey = `${rootId}->${targetId}`;
			let entry = edges.get(edgeKey);
			if (!entry) {
				const payload: GraphEdgePayload = {
					id: this.toNodeId(`edge:${edgeKey}`),
					source: rootId,
					target: targetId,
					label: '',
					specifier: descriptor.specifier,
					kind: edgeKind
				};
				entry = { payload, symbols: new Set<string>() };
				edges.set(edgeKey, entry);
			}

			for (const symbol of this.getSymbolsForDescriptor(descriptor)) {
				entry.symbols.add(symbol);
			}

			if (descriptor.isSideEffectOnly) {
				entry.payload.kind = 'sideEffect';
			} else if (entry.payload.kind !== 'sideEffect') {
				entry.payload.kind = edgeKind;
			}

			entry.payload.label = this.composeEdgeLabel(entry.symbols, entry.payload.kind);
		}

		return {
			nodes: Array.from(nodes.values()),
			edges: Array.from(edges.values(), entry => entry.payload)
		};
	}

	private toNodeId(value: URI | string): string {
		const raw = typeof value === 'string' ? value : value.toString(true);
		return this.toCytoscapeId(raw);
	}

	private toCytoscapeId(value: string): string {
		return encodeURIComponent(value).replace(/%/g, '_');
	}

	private formatNodeLabel(resource: URI): string {
		const workspace = this.workspaceService.getWorkspace();
		for (const folder of workspace.folders) {
			const relative = this.uriIdentityService.extUri.relativePath(folder.uri, resource);
			if (relative) {
				return relative;
			}
		}
		return basename(resource);
	}

	private getSymbolsForDescriptor(descriptor: ImportDescriptor): string[] {
		const symbols: string[] = [];
		if (descriptor.defaultImport) {
			symbols.push(this.decorateSymbol(descriptor.defaultImport.name, descriptor.defaultImport.isTypeOnly));
		}
		if (descriptor.namespaceImport) {
			symbols.push(this.decorateSymbol(`* as ${descriptor.namespaceImport.name}`, descriptor.namespaceImport.isTypeOnly));
		}
		for (const item of descriptor.namedImports) {
			const display = item.propertyName ? `${item.propertyName} as ${item.name}` : item.name;
			symbols.push(this.decorateSymbol(display, item.isTypeOnly));
		}
		return symbols;
	}

	private decorateSymbol(name: string, isTypeOnly: boolean): string {
		return isTypeOnly ? `${name} (type)` : name;
	}

	private composeEdgeLabel(symbols: Set<string>, kind: GraphEdgeKind): string {
		if (kind === 'sideEffect') {
			return '[side-effect]';
		}
		if (symbols.size === 0) {
			return '';
		}
		return Array.from(symbols).sort((a, b) => a.localeCompare(b)).join(', ');
	}

	private async resolveImportTarget(sourceUri: URI, specifier: string): Promise<URI | undefined> {
		if (!specifier) {
			return undefined;
		}
		const extUri = this.uriIdentityService.extUri;
		let baseUri: URI | undefined;
		if (specifier.startsWith('.')) {
			baseUri = extUri.resolvePath(dirname(sourceUri), specifier);
		} else if (specifier.startsWith('/')) {
			const workspaceRoot = this.getDefaultWorkspaceRoot();
			if (workspaceRoot) {
				baseUri = extUri.resolvePath(workspaceRoot, specifier);
			}
		} else {
			return undefined;
		}

		if (!baseUri) {
			return undefined;
		}

		const candidates = this.expandImportCandidates(baseUri);
		for (const candidate of candidates) {
			try {
				if (await this.fileService.exists(candidate)) {
					return candidate;
				}
			} catch (error) {
				this.logService.debug('[GraphView] error checking candidate', error);
			}
		}
		return undefined;
	}

	private expandImportCandidates(baseUri: URI): URI[] {
		const extUri = this.uriIdentityService.extUri;
		const extension = extUri.extname(baseUri).toLowerCase();
		const candidates: URI[] = [];
		const seen = new Set<string>();
		const pushCandidate = (uri: URI) => {
			const key = uri.toString();
			if (!seen.has(key)) {
				seen.add(key);
				candidates.push(uri);
			}
		};

		if (extension && GraphView.FILE_EXTENSIONS.includes(extension)) {
			pushCandidate(baseUri);
			return candidates;
		}

		const dir = dirname(baseUri);
		const baseName = basename(baseUri);

		for (const ext of GraphView.FILE_EXTENSIONS) {
			pushCandidate(extUri.joinPath(dir, `${baseName}${ext}`));
		}

		if (baseName && baseName !== 'index') {
			for (const indexName of GraphView.INDEX_FILENAMES) {
				pushCandidate(extUri.joinPath(baseUri, indexName));
			}
		}

		return candidates;
	}

	private getDefaultWorkspaceRoot(): URI | undefined {
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders[0]?.uri;
	}

	private extractImportDescriptors(content: string): ImportDescriptor[] {
		const descriptors: ImportDescriptor[] = [];
		let match: RegExpExecArray | null;

		const importFromRegex = /import\s+([^'";]+?)\s+from\s+['"]([^'";]+)['"]/g;
		while ((match = importFromRegex.exec(content)) !== null) {
			let clause = match[1]?.trim() ?? '';
			const specifier = match[2]?.trim() ?? '';
			if (!specifier) {
				continue;
			}

			let clauseIsTypeOnly = false;
			if (clause.startsWith('type ')) {
				clauseIsTypeOnly = true;
				clause = clause.slice(4).trim();
			}

			const descriptor: ImportDescriptor = {
				specifier,
				defaultImport: undefined,
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: false
			};

			let remainder = clause;
			if (remainder && !remainder.startsWith('{') && !remainder.startsWith('*')) {
				const commaIndex = remainder.indexOf(',');
				const defaultPart = commaIndex === -1 ? remainder : remainder.slice(0, commaIndex);
				remainder = commaIndex === -1 ? '' : remainder.slice(commaIndex + 1);
				const name = defaultPart.trim();
				if (name) {
					descriptor.defaultImport = { name, isTypeOnly: clauseIsTypeOnly };
				}
			}

			remainder = remainder.trim();
			if (remainder.startsWith('{') && remainder.includes('}')) {
				const inside = remainder.slice(1, remainder.indexOf('}'));
				for (const entry of inside.split(',')) {
					let token = entry.trim();
					if (!token) {
						continue;
					}
					let isTypeOnly = clauseIsTypeOnly;
					if (token.startsWith('type ')) {
						isTypeOnly = true;
						token = token.slice(5).trim();
					}
					const asMatch = /^(.*?)\s+as\s+(.*)$/.exec(token);
					if (asMatch) {
						const original = asMatch[1].trim();
						const alias = asMatch[2].trim();
						if (alias) {
							descriptor.namedImports.push({
								name: alias,
								propertyName: original && original !== alias ? original : undefined,
								isTypeOnly
							});
						}
					} else if (token) {
						descriptor.namedImports.push({ name: token, propertyName: undefined, isTypeOnly });
					}
				}
			} else if (remainder.startsWith('*')) {
				const nsMatch = /\*\s+as\s+([A-Za-z0-9_$]+)/.exec(remainder);
				if (nsMatch) {
					descriptor.namespaceImport = { name: nsMatch[1], isTypeOnly: clauseIsTypeOnly };
				}
			}

			descriptors.push(descriptor);
		}

		const sideEffectRegex = /import\s+['"]([^'";]+)['"]/g;
		while ((match = sideEffectRegex.exec(content)) !== null) {
			const specifier = match[1]?.trim() ?? '';
			if (!specifier) {
				continue;
			}
			descriptors.push({
				specifier,
				defaultImport: undefined,
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: true
			});
		}

		const importEqualsRegex = /import\s+(type\s+)?([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"]([^'";]+)['"]\s*\)/g;
		while ((match = importEqualsRegex.exec(content)) !== null) {
			const specifier = match[3]?.trim() ?? '';
			const name = match[2]?.trim() ?? '';
			if (!specifier || !name) {
				continue;
			}
			const isTypeOnly = !!match[1];
			descriptors.push({
				specifier,
				defaultImport: { name, isTypeOnly },
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: false
			});
		}

		return descriptors;
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

	private buildWebviewHTMLForPanel(libSrc: string, nonce: string): string {
		return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Graph</title>
		<style>
			html, body {
				height: 100%;
				width: 100%;
				margin: 0;
				padding: 0;
				background: transparent;
				color: var(--vscode-editor-foreground);
				font-family: var(--vscode-font-family, sans-serif);
			}

			#cy {
				height: 100%;
				width: 100%;
				position: absolute;
				top: 0;
				left: 0;
			}

			#toolbar {
				position: absolute;
				top: 12px;
				right: 12px;
				display: flex;
				gap: 8px;
				padding: 8px 10px;
				border-radius: 8px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
				z-index: 5;
			}

			#toolbar button {
				background: var(--vscode-button-secondaryBackground, #2d2d30);
				color: var(--vscode-button-secondaryForeground, #ffffff);
				border: 1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.2));
				border-radius: 4px;
				padding: 4px 10px;
				font-size: 12px;
				cursor: pointer;
				line-height: 1.4;
			}

			#toolbar button:hover {
				background: var(--vscode-button-hoverBackground, #3c3c40);
			}

			#status {
				position: absolute;
				left: 16px;
				bottom: 16px;
				padding: 8px 12px;
				border-radius: 6px;
				font-size: 12px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
				color: var(--vscode-editorWidget-foreground, #ffffff);
				display: none;
				pointer-events: none;
				box-shadow: 0 2px 8px rgba(0,0,0,0.25);
				z-index: 6;
			}

			#status.show {
				display: inline-flex;
			}

			#status.info {
				background: var(--vscode-charts-blue, rgba(33, 150, 243, 0.75));
			}

			#status.success {
				background: var(--vscode-charts-green, rgba(102, 187, 106, 0.75));
			}

			#status.warning {
				background: var(--vscode-charts-orange, rgba(255, 183, 77, 0.85));
				color: #211b00;
			}

			#status.error {
				background: var(--vscode-charts-red, rgba(244, 67, 54, 0.85));
			}

			#status.loading {
				background: var(--vscode-editorHoverWidget-background, rgba(158, 158, 158, 0.8));
				color: var(--vscode-editorHoverWidget-foreground, #000000);
			}
		</style>
	</head>
	<body>
		<div id="cy" role="presentation" aria-hidden="true"></div>
		<div id="toolbar" aria-label="Graph controls">
			<button id="selectFile" title="Select a file to visualize">Select File...</button>
			<button id="zoomIn" title="Zoom in">+</button>
			<button id="zoomOut" title="Zoom out">-</button>
		</div>
		<div id="status" class="status" aria-live="polite"></div>
		<script src="${libSrc}"></script>
		<script nonce="${nonce}">
		(function(){
			const vscode = acquireVsCodeApi();
			let cy;
			let autoClearHandle = undefined;
			const statusEl = document.getElementById('status');

			const send = (type, payload) => {
				try {
					vscode.postMessage({ type, payload });
				} catch (error) {
					console.error('[graph-view] failed to post message', error);
				}
			};

			const clearStatus = () => {
				if (autoClearHandle) {
					clearTimeout(autoClearHandle);
					autoClearHandle = undefined;
				}
				statusEl.className = 'status';
				statusEl.textContent = '';
			};

			const updateStatus = (message, level, autoClearMs) => {
				if (!message) {
					clearStatus();
					return;
				}
				if (autoClearHandle) {
					clearTimeout(autoClearHandle);
					autoClearHandle = undefined;
				}
				statusEl.className = 'status show ' + level;
				statusEl.textContent = message;
				if (autoClearMs && autoClearMs > 0) {
					autoClearHandle = window.setTimeout(() => {
						clearStatus();
						send('REN_GRAPH_EVT', { type: 'status-auto-clear' });
					}, autoClearMs);
				}
			};

			const ensureCy = () => {
				if (cy) {
					return;
				}
				cy = window.cytoscape({
					container: document.getElementById('cy'),
					style: [
						{ selector: 'node', style: {
							'background-color': '#4FC3F7',
							'border-width': 2,
							'border-color': '#0B1A2B',
							'label': 'data(label)',
							'font-size': 12,
							'font-weight': 600,
							'color': '#0B1A2B',
							'text-wrap': 'wrap',
							'text-max-width': 160,
							'text-valign': 'center',
							'text-halign': 'center',
							'width': 80,
							'height': 80
						}},
						{ selector: 'node.root', style: {
							'background-color': '#FFB300',
							'border-color': '#8D6E63',
							'color': '#221600'
						}},
						{ selector: 'node.external', style: {
							'background-color': '#AB47BC',
							'border-color': '#6A1B9A',
							'color': '#1E0F2B'
						}},
						{ selector: 'edge', style: {
							'width': 2,
							'curve-style': 'bezier',
							'line-color': '#E0E0E0',
							'target-arrow-color': '#E0E0E0',
							'target-arrow-shape': 'triangle',
							'arrow-scale': 1.2,
							'label': 'data(label)',
							'font-size': 11,
							'color': '#ffffff',
							'text-wrap': 'wrap',
							'text-max-width': 140,
							'text-background-color': 'rgba(0, 0, 0, 0.65)',
							'text-background-opacity': 1,
							'text-background-padding': '2px',
							'text-background-shape': 'roundrectangle'
						}},
						{ selector: 'edge.external', style: {
							'line-color': '#B39DDB',
							'target-arrow-color': '#B39DDB'
						}},
						{ selector: 'edge.sideEffect', style: {
							'line-style': 'dashed',
							'line-color': '#FFCC80',
							'target-arrow-color': '#FFCC80',
							'color': '#FFECB3'
						}}
					],
					wheelSensitivity: 0.2,
					minZoom: 0.1,
					maxZoom: 5
				});

				cy.on('tap', 'node', evt => {
					send('REN_GRAPH_EVT', { type: 'node-tap', data: evt.target.data() });
				});
				cy.on('tap', 'edge', evt => {
					send('REN_GRAPH_EVT', { type: 'edge-tap', data: evt.target.data() });
				});
			};

			const applyZoom = factor => {
				if (!cy) {
					return;
				}
				const current = cy.zoom();
				const next = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), current * factor));
				cy.zoom({ level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
				cy.resize();
				send('REN_ZOOM', { zoom: cy.zoom(), pan: cy.pan() });
			};

			const applyGraph = payload => {
				if (!payload) {
					return;
				}
				ensureCy();
				cy.stop();
				cy.elements().remove();
				const nodes = (payload.nodes || []).map(node => ({
					group: 'nodes',
					data: {
						id: node.id,
						label: node.label,
						path: node.path,
						kind: node.kind
					},
					classes: node.kind
				}));
				const edges = (payload.edges || []).map(edge => ({
					group: 'edges',
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						label: edge.label,
						specifier: edge.specifier
					},
					classes: edge.kind
				}));

				cy.add([...nodes, ...edges]);
				cy.resize();

				const rootIds = nodes.filter(n => n.classes === 'root').map(n => n.data.id);
				const layoutName = nodes.length > 14 ? 'cose' : 'breadthfirst';
				const layoutOptions = layoutName === 'breadthfirst'
					? { name: 'breadthfirst', directed: true, padding: 80, spacingFactor: 1.2, roots: rootIds }
					: { name: 'cose', padding: 60, animate: false };

				const layout = cy.layout(layoutOptions);
				layout.one('layoutstop', () => {
					cy.fit(undefined, 80);
					send('REN_GRAPH_APPLIED', { nodes: nodes.length, edges: edges.length });
				});
				layout.run();
			};

			window.addEventListener('message', event => {
				const message = event.data || {};
				switch (message.type) {
					case 'REN_GRAPH_DATA':
						applyGraph(message.payload);
						break;
					case 'REN_GRAPH_STATUS':
						updateStatus(message.payload?.message || '', message.payload?.level || 'info', message.payload?.autoClearMs);
						break;
					case 'REN_GRAPH_ERROR':
						updateStatus('Graph rendering error inside webview.', 'error');
						break;
					default:
						break;
				}
			});

			document.getElementById('selectFile').addEventListener('click', () => send('REN_SELECT_FILE'));
			document.getElementById('zoomIn').addEventListener('click', () => applyZoom(1.2));
			document.getElementById('zoomOut').addEventListener('click', () => applyZoom(1 / 1.2));

			window.addEventListener('resize', () => {
				if (!cy) {
					return;
				}
				cy.resize();
			});

			const init = () => {
				if (typeof window.cytoscape !== 'function') {
					setTimeout(init, 50);
					return;
				}
				ensureCy();
				send('REN_GRAPH_READY');
			};

			init();
		})();
		</script>
	</body>
	</html>`;
	}
}
