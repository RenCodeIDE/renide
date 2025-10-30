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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../../base/common/uri.js';
import { buildGraphWebviewHTML } from '../templates/graphWebviewTemplate.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISearchService, QueryType, IFileMatch } from '../../../../services/search/common/search.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';

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
	private static readonly DEFAULT_EXCLUDE_GLOBS: Readonly<Record<string, boolean>> = Object.freeze({
		'**/node_modules/**': true,
		'**/node_modules/react/**': true,
		'**/node_modules/react-dom/**': true,
		'**/node_modules/react-native/**': true,
		'**/node_modules/@types/react/**': true,
		'**/node_modules/@types/react-dom/**': true,
		'**/.git/**': true,
		'**/.hg/**': true,
		'**/dist/**': true,
		'**/build/**': true,
		'**/out/**': true,
		'**/.next/**': true,
		'**/.turbo/**': true,
		'**/.vercel/**': true,
		'**/coverage/**': true,
		'**/tmp/**': true,
		'**/.cache/**': true
	});
	private static readonly EXCLUDED_PATH_SEGMENTS = new Set([
		'node_modules',
		'.git',
		'.hg',
		'dist',
		'build',
		'out',
		'.next',
		'.turbo',
		'.vercel',
		'coverage',
		'tmp',
		'.cache'
	]);

	private static readonly EXCLUDED_LEAF_NAMES = new Set([
		'react.js',
		'react.ts',
		'react.jsx',
		'react.tsx',
		'react.production.min.js',
		'react-dom.js',
		'react-dom.ts',
		'react-dom.jsx',
		'react-dom.tsx',
		'react-dom.production.min.js'
	]);
	private static readonly IGNORED_IMPORT_SPECIFIERS = new Set([
		'react',
		'react-dom',
		'react-router',
		'react-router-dom',
		'react-router-native',
		'react-router-config',
		'recoil',
		'redux',
		'@reduxjs/toolkit',
		'@types/react',
		'@types/react-dom'
	]);
	private _mainContainer: HTMLElement | null = null;
	private _toolbar: HTMLElement | null = null;
	private _window: Window | null = null;
	private _webview: IWebviewElement | null = null;
	private _graphReady = false;
	private _promptInFlight = false;
	private _renderRequestId = 0;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISearchService private readonly searchService: ISearchService,
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

		this._mainContainer.appendChild(this.ensureToolbar());

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
		const html = buildGraphWebviewHTML(libUri, nonce);
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

		const selectFileButton = document.createElement('button');
		selectFileButton.className = 'ren-graph-toolbar-btn';
		selectFileButton.textContent = 'Select File…';
		selectFileButton.title = 'Choose a file to visualize imports';
		selectFileButton.addEventListener('click', () => {
			void this.promptForFileAndRender();
		});
		toolbar.appendChild(selectFileButton);

		this._toolbar = toolbar;
		return toolbar;
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
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace.folders || workspace.folders.length === 0) {
			return undefined;
		}

		const quickPick = this.quickInputService.createQuickPick<IQuickPickItem & { uri: URI }>();
		quickPick.placeholder = 'Type to search for files (e.g., component.tsx, utils.js)...';
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.canSelectMany = false;
		quickPick.items = [];

		let searchTimeout: ReturnType<typeof setTimeout> | undefined;
		let searchCancellation: CancellationTokenSource | undefined;
		const folderQueries = workspace.folders.map(folder => ({ folder: folder.uri }));

		const setResults = (items: Array<IQuickPickItem & { uri: URI }>) => {
			quickPick.items = items;
			if (!quickPick.busy) {
				quickPick.placeholder = items.length === 0
					? 'No matching files found'
					: 'Select a file to visualize its imports';
			}
		};

		const searchFiles = async (query: string) => {
			if (searchTimeout) {
				clearTimeout(searchTimeout);
			}
			if (searchCancellation) {
				searchCancellation.cancel();
				searchCancellation.dispose();
				searchCancellation = undefined;
			}

			quickPick.busy = true;
			quickPick.placeholder = 'Searching…';
			setResults([]);

			searchTimeout = setTimeout(async () => {
				try {
					const trimmed = query.trim();
					const filePattern = trimmed ? `*${trimmed.replace(/\s+/g, '*')}*` : undefined;
					const searchQuery = {
						type: QueryType.File as QueryType.File,
						folderQueries,
						filePattern,
						sortByScore: true,
						excludePattern: GraphView.DEFAULT_EXCLUDE_GLOBS,
						maxResults: 400
					};

					searchCancellation = new CancellationTokenSource();
					const results = await this.searchService.fileSearch(searchQuery, searchCancellation.token);

					const items: (IQuickPickItem & { uri: URI })[] = results.results
						.map((fileMatch: IFileMatch) => {
							const uri = fileMatch.resource;
							const relativePath = this.formatNodeLabel(uri);
							const folderPath = dirname(uri);
							const folderName = this.uriIdentityService.extUri.relativePath(
								workspace.folders[0]?.uri || URI.file(''),
								folderPath
							) || folderPath.toString();

							return {
								label: basename(uri),
								description: folderName,
								detail: relativePath,
								uri: uri,
							};
						})
						.filter(item => {
							const filePath = item.uri.path;
							if (!GraphView.FILE_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext))) {
								return false;
							}
							const baseName = basename(item.uri).toLowerCase();
							if (GraphView.EXCLUDED_LEAF_NAMES.has(baseName)) {
								return false;
							}
							return !GraphView.isExcludedPath(filePath);
						})
						.filter((item: IQuickPickItem & { uri: URI }) => {
							// Filter by query if provided
							if (!query.trim()) {
								return true;
							}
							const queryLower = query.toLowerCase();
							return item.label.toLowerCase().includes(queryLower) ||
								(item.description?.toLowerCase().includes(queryLower) ?? false) ||
								(item.detail?.toLowerCase().includes(queryLower) ?? false);
						})
						.sort((a: IQuickPickItem & { uri: URI }, b: IQuickPickItem & { uri: URI }) => {
							// Sort by relevance: exact matches first, then by name
							const aLabel = a.label.toLowerCase();
							const bLabel = b.label.toLowerCase();
							const queryLower = query.toLowerCase();

							if (aLabel.startsWith(queryLower) && !bLabel.startsWith(queryLower)) {
								return -1;
							}
							if (!aLabel.startsWith(queryLower) && bLabel.startsWith(queryLower)) {
								return 1;
							}
							return a.label.localeCompare(b.label);
						});

					setResults(items);
				} catch (error) {
					if (!isCancellationError(error)) {
						this.logService.error('[GraphView] error searching files', error);
					}
					setResults([]);
				} finally {
					quickPick.busy = false;
				}
			}, query.trim() ? 300 : 100); // Debounce: shorter delay for empty query
		};

		// Initial search
		await searchFiles('');

		// Search as user types
		const searchDisposable = quickPick.onDidChangeValue(async (value) => {
			await searchFiles(value);
		});

		return new Promise<URI | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0] as (IQuickPickItem & { uri?: URI }) | undefined;
				if (selected?.uri) {
					resolve(selected.uri);
				} else {
					resolve(undefined);
				}
				searchDisposable.dispose();
				quickPick.dispose();
				if (searchCancellation) {
					searchCancellation.cancel();
					searchCancellation.dispose();
					searchCancellation = undefined;
				}
			});

			quickPick.onDidHide(() => {
				searchDisposable.dispose();
				quickPick.dispose();
				if (searchTimeout) {
					clearTimeout(searchTimeout);
				}
				if (searchCancellation) {
					searchCancellation.cancel();
					searchCancellation.dispose();
					searchCancellation = undefined;
				}
				resolve(undefined);
			});

			quickPick.show();
		});
	}

	private static isExcludedPath(path: string): boolean {
		const segments = path.split(/[\\/]+/);
		return segments.some(segment => this.EXCLUDED_PATH_SEGMENTS.has(segment));
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
			if (this.shouldIgnoreImport(descriptor.specifier, resolvedUri)) {
				continue;
			}
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

	private static getImportBase(specifier: string): string {
		if (!specifier) {
			return specifier;
		}
		const trimmed = specifier.trim();
		if (trimmed.startsWith('@')) {
			const [scope, name] = trimmed.split('/', 3);
			return name ? `${scope}/${name}`.toLowerCase() : trimmed.toLowerCase();
		}
		const [base] = trimmed.split('/', 2);
		return (base ?? trimmed).toLowerCase();
	}

	private shouldIgnoreImport(specifier: string, resolvedUri: URI | undefined): boolean {
		const base = GraphView.getImportBase(specifier);
		if (GraphView.IGNORED_IMPORT_SPECIFIERS.has(base)) {
			return true;
		}
		if (resolvedUri) {
			const path = resolvedUri.path.toLowerCase();
			if (path.includes('/node_modules/') || path.includes('\\node_modules\\')) {
				return true;
			}
		}
		return false;
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
}
