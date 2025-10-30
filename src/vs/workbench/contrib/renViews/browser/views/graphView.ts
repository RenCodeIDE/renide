import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
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
	readonly weight: number;
	readonly fanIn: number;
	readonly fanOut: number;
}

type GraphEdgeKind = 'relative' | 'external' | 'sideEffect';

type GraphMode = 'file' | 'folder' | 'workspace';

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
						? `Folder: ${this.formatNodeLabel(this._selectedFolder)} (Change…)`
						: 'Select Folder…';
					this._targetButton.title = 'Choose a folder to visualize';
					break;
				case 'file':
				default:
					this._targetButton.textContent = this._selectedFile
						? `File: ${this.formatNodeLabel(this._selectedFile)} (Change…)`
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
					const folder = await this.pickFolder();
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
					const file = await this.pickSourceFile();
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
		await this.sendStatus(`Building import graph for ${this.formatNodeLabel(sourceUri)}…`, 'loading');
		try {
			const payload = await this.buildGraphForFile(sourceUri);
			if (requestId !== this._renderRequestId) {
				return;
			}
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload });
			await this.sendStatus(payload.edges.length === 0
				? 'No import statements found in the selected file.'
				: `Rendered imports for ${this.formatNodeLabel(sourceUri)}.`,
				payload.edges.length === 0 ? 'warning' : 'success',
				payload.edges.length === 0 ? 5000 : 4000);
		} catch (error) {
			this.logService.error('[GraphView] failed to build file graph', error);
			if (requestId === this._renderRequestId) {
				await this.sendStatus('Failed to build graph. Check logs for details.', 'error');
			}
		}
	}

	private async renderFolderGraph(folder: URI, requestId: number): Promise<void> {
		await this.sendStatus(`Scanning folder ${this.formatNodeLabel(folder)}…`, 'loading');
		try {
			const payload = await this.buildGraphForScope([folder], 'folder');
			if (requestId !== this._renderRequestId) {
				return;
			}
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload });
			if (payload.nodes.length === 0) {
				await this.sendStatus('No matching source files found in the selected folder.', 'warning', 4000);
			} else {
				await this.sendStatus(`Rendered folder graph for ${this.formatNodeLabel(folder)}.`, 'success', 4000);
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
			const workspaceFolders = this.workspaceService.getWorkspace().folders.map(folder => folder.uri);
			const payload = await this.buildGraphForScope(workspaceFolders, 'workspace');
			if (effectiveRequestId !== this._renderRequestId) {
				return;
			}
			await this._webview?.postMessage({ type: 'REN_GRAPH_DATA', payload });
			if (payload.nodes.length === 0) {
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
		const disposables = new DisposableStore();
		disposables.add(quickPick);

		let searchTimeout: ReturnType<typeof setTimeout> | undefined;
		let searchCancellation: CancellationTokenSource | undefined;
		const folderQueries = workspace.folders.map(folder => ({ folder: folder.uri }));

		const resetSearchHandles = () => {
			if (searchTimeout) {
				clearTimeout(searchTimeout);
				searchTimeout = undefined;
			}
			if (searchCancellation) {
				searchCancellation.cancel();
				searchCancellation.dispose();
				searchCancellation = undefined;
			}
		};

		const setResults = (items: Array<IQuickPickItem & { uri: URI }>) => {
			quickPick.items = items;
			if (!quickPick.busy) {
				quickPick.placeholder = items.length === 0
					? 'No matching files found'
					: 'Select a file to visualize its imports';
			}
		};

		const searchFiles = async (query: string) => {
			resetSearchHandles();
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
							if (!query.trim()) {
								return true;
							}
							const queryLower = query.toLowerCase();
							return item.label.toLowerCase().includes(queryLower) ||
								(item.description?.toLowerCase().includes(queryLower) ?? false) ||
								(item.detail?.toLowerCase().includes(queryLower) ?? false);
						})
						.sort((a: IQuickPickItem & { uri: URI }, b: IQuickPickItem & { uri: URI }) => {
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
			}, query.trim() ? 300 : 100);
		};

		await searchFiles('');
		disposables.add(quickPick.onDidChangeValue(async value => {
			await searchFiles(value);
		}));

		return new Promise<URI | undefined>((resolve) => {
			let finished = false;
			const finalize = (result: URI | undefined) => {
				if (finished) {
					return;
				}
				finished = true;
				resetSearchHandles();
				disposables.dispose();
				resolve(result);
			};

			disposables.add(quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0] as (IQuickPickItem & { uri?: URI }) | undefined;
				finalize(selected?.uri);
				quickPick.hide();
			}));

			disposables.add(quickPick.onDidHide(() => {
				finalize(undefined);
			}));

			quickPick.show();
		});
	}

	private async pickFolder(): Promise<URI | undefined> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace.folders || workspace.folders.length === 0) {
			return undefined;
		}

		type FolderPickKind = 'select' | 'folder' | 'parent' | 'workspaceRoot' | 'workspaceRootList' | 'custom';
		type FolderPickItem = IQuickPickItem & { uri?: URI; kind: FolderPickKind; customValue?: string };

		const quickPick = this.quickInputService.createQuickPick<FolderPickItem>();
		quickPick.placeholder = 'Select a folder to visualize';
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.items = [];
		const disposables = new DisposableStore();
		disposables.add(quickPick);

		const extUri = this.uriIdentityService.extUri;
		const workspaceFolders = workspace.folders.map(folder => folder.uri);
		const normalizeValue = (value: string) => value.trim().replace(/\\/g, '/');

		let currentFolder: URI | undefined;
		let currentWorkspaceRoot: URI | undefined;
		let baseItems: FolderPickItem[] = [];
		let customItem: FolderPickItem | undefined;
		let updateToken = 0;

		const findWorkspaceRoot = (uri: URI | undefined): URI | undefined => {
			if (!uri) {
				return undefined;
			}
			for (const root of workspaceFolders) {
				if (extUri.isEqualOrParent(uri, root)) {
					return root;
				}
			}
			return undefined;
		};

		const refreshItems = () => {
			const items = customItem ? [customItem, ...baseItems] : baseItems;
			quickPick.items = items;
			if (customItem) {
				quickPick.activeItems = [customItem];
			} else if (items.length > 0) {
				quickPick.activeItems = [items[0]];
			} else {
				quickPick.activeItems = [];
			}
		};

		const setBaseItems = (items: FolderPickItem[]) => {
			baseItems = items;
			refreshItems();
		};

		const updateCustomItemFromValue = (value: string) => {
			const normalized = normalizeValue(value);
			if (!normalized) {
				if (customItem) {
					customItem = undefined;
					refreshItems();
				}
				quickPick.validationMessage = undefined;
				return;
			}
			customItem = {
				label: `Use folder: ${normalized}`,
				description: 'Press Enter to resolve this path',
				kind: 'custom',
				customValue: normalized
			};
			refreshItems();
		};

		const updateItemsForFolder = async (folder: URI | undefined) => {
			const token = ++updateToken;
			currentFolder = folder;
			currentWorkspaceRoot = findWorkspaceRoot(folder);
			quickPick.busy = true;
			quickPick.validationMessage = undefined;

			const items: FolderPickItem[] = [];

			try {
				if (!folder) {
					const workspaceItems = workspace.folders
						.map(folderData => ({
							label: `$(root-folder) ${folderData.name ?? basename(folderData.uri)}`,
							description: folderData.uri.toString(true),
							uri: folderData.uri,
							kind: 'workspaceRoot' as const
						}))
						.sort((a, b) => a.label.localeCompare(b.label));
					if (token !== updateToken) {
						return;
					}
					setBaseItems(workspaceItems);
					quickPick.placeholder = workspace.folders.length === 1
						? 'Select the workspace folder or type a path'
						: 'Select a workspace folder to browse or type a path';
				} else {
					const folderLabel = this.formatNodeLabel(folder) || basename(folder);
					items.push({
						label: `$(check) Use ${folderLabel}`,
						description: folder.toString(true),
						uri: folder,
						kind: 'select'
					});

					if (workspaceFolders.length > 1) {
						items.push({
							label: '$(arrow-left) Back to workspace folders',
							description: 'Choose a different workspace root',
							kind: 'workspaceRootList'
						});
					}

					const parentCandidate = dirname(folder);
					if ((currentWorkspaceRoot && !extUri.isEqual(folder, currentWorkspaceRoot)) || (!currentWorkspaceRoot && !extUri.isEqual(parentCandidate, folder))) {
						items.push({
							label: '$(arrow-up) ..',
							description: this.formatNodeLabel(parentCandidate) || parentCandidate.toString(true),
							detail: 'Go up one level',
							uri: currentWorkspaceRoot && extUri.isEqual(parentCandidate, currentWorkspaceRoot) ? currentWorkspaceRoot : parentCandidate,
							kind: 'parent'
						});
					}

					const stat = await this.fileService.resolve(folder, { resolveMetadata: false });
					const children = stat.children ?? [];
					const directories = children
						.filter(child => child.isDirectory && !GraphView.isExcludedPath(child.resource.path))
						.sort((a, b) => a.name.localeCompare(b.name));

					for (const directory of directories) {
						items.push({
							label: `$(folder) ${directory.name}`,
							description: this.formatNodeLabel(directory.resource),
							detail: directory.resource.toString(true),
							uri: directory.resource,
							kind: 'folder'
						});
					}

					if (token !== updateToken) {
						return;
					}

					setBaseItems(items);
					quickPick.placeholder = `Select a folder within ${folderLabel}, or choose "Use ${folderLabel}"`;
				}
			} catch (error) {
				this.logService.error('[GraphView] failed to enumerate folders', error);
				if (token !== updateToken) {
					return;
				}
				setBaseItems(items.length ? items : [{
					label: 'Failed to load folders',
					description: 'Check logs for details',
					kind: 'workspaceRootList'
				}]);
			} finally {
				if (token === updateToken) {
					quickPick.busy = false;
				}
			}
		};

		disposables.add(quickPick.onDidChangeValue(value => {
			updateCustomItemFromValue(value);
		}));

		return new Promise<URI | undefined>(resolve => {
			let finished = false;
			const finalize = (result: URI | undefined) => {
				if (finished) {
					return;
				}
				finished = true;
				disposables.dispose();
				resolve(result);
			};

			disposables.add(quickPick.onDidAccept(async () => {
				const selected = quickPick.selectedItems[0];
				if (selected?.kind === 'custom') {
					const resolved = await this.resolveFolderInput(selected.customValue ?? quickPick.value, currentFolder ?? currentWorkspaceRoot ?? workspace.folders[0]?.uri);
					if (resolved) {
						finalize(resolved);
						quickPick.hide();
					} else {
						quickPick.validationMessage = 'Folder not found or not accessible.';
					}
					return;
				}
				if (!selected) {
					return;
				}
				switch (selected.kind) {
					case 'select':
						if (selected.uri) {
							finalize(selected.uri);
							quickPick.hide();
						}
						break;
					case 'folder':
					case 'workspaceRoot':
						if (selected.uri) {
							quickPick.value = '';
							customItem = undefined;
							void updateItemsForFolder(selected.uri);
						}
						break;
					case 'parent':
						if (selected.uri) {
							quickPick.value = '';
							customItem = undefined;
							void updateItemsForFolder(selected.uri);
						}
						break;
					case 'workspaceRootList':
						quickPick.value = '';
						customItem = undefined;
						void updateItemsForFolder(undefined);
						break;
					default:
						if (selected.uri) {
							finalize(selected.uri);
							quickPick.hide();
						}
						break;
				}
			}));

			disposables.add(quickPick.onDidHide(() => {
				finalize(undefined);
			}));

			const initialFolder = this._selectedFolder
				?? (workspace.folders.length === 1 ? workspace.folders[0].uri : undefined);
			void updateItemsForFolder(initialFolder);
			quickPick.show();
		});
	}

	private async resolveFolderInput(rawValue: string, baseFolder?: URI): Promise<URI | undefined> {
		const normalized = rawValue.trim();
		if (!normalized) {
			return undefined;
		}
		const value = normalized.replace(/\\/g, '/');
		const workspace = this.workspaceService.getWorkspace();
		const extUri = this.uriIdentityService.extUri;
		const candidates: URI[] = [];
		const seen = new Set<string>();

		const addCandidate = (candidate: URI | undefined) => {
			if (!candidate) {
				return;
			}
			const key = this.getUriKey(candidate);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			candidates.push(candidate);
		};

		if (value.includes('://')) {
			try {
				addCandidate(URI.parse(value));
			} catch (error) {
				this.logService.debug('[GraphView] failed to parse folder input', value, error);
			}
		}

		if (baseFolder) {
			addCandidate(extUri.resolvePath(baseFolder, value));
		}

		for (const folder of workspace.folders) {
			addCandidate(extUri.resolvePath(folder.uri, value));
		}

		if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
			try {
				addCandidate(URI.file(value));
			} catch (error) {
				this.logService.debug('[GraphView] failed to parse absolute folder path', value, error);
			}
		}

		for (const candidate of candidates) {
			try {
				const resolved = await this.tryResolveDirectory(candidate);
				if (resolved) {
					return resolved;
				}
			} catch (error) {
				this.logService.debug('[GraphView] failed to resolve folder input', candidate.toString(true), error);
			}
		}

		return undefined;
	}

	private async tryResolveDirectory(uri: URI): Promise<URI | undefined> {
		if (GraphView.isExcludedPath(uri.path)) {
			return undefined;
		}
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.isDirectory) {
				return uri;
			}
		} catch (error) {
			this.logService.debug('[GraphView] failed to resolve directory', uri.toString(true), error);
		}
		return undefined;
	}

	private static isExcludedPath(path: string): boolean {
		const segments = path.split(/[\\/]+/);
		return segments.some(segment => this.EXCLUDED_PATH_SEGMENTS.has(segment));
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

	private getUriKey(uri: URI): string {
		return this.uriIdentityService.extUri.getComparisonKey(uri, true);
	}

	private isWithinWorkspace(uri: URI): boolean {
		const workspace = this.workspaceService.getWorkspace();
		for (const folder of workspace.folders) {
			if (this.uriIdentityService.extUri.isEqualOrParent(uri, folder.uri)) {
				return true;
			}
		}
		return false;
	}

	private async buildGraphForFile(sourceUri: URI): Promise<GraphWebviewPayload> {
		return this.buildGraphFromFiles([sourceUri], {
			scopeRoots: new Set([this.getUriKey(sourceUri)]),
			scopeMode: 'file'
		});
	}

	private async buildGraphForScope(folders: URI[], mode: 'folder' | 'workspace'): Promise<GraphWebviewPayload> {
		const files = await this.collectFilesInScope(folders);
		return this.buildGraphFromFiles(files, {
			scopeRoots: new Set(files.map(uri => this.getUriKey(uri))),
			scopeMode: mode
		});
	}

	private async collectFilesInScope(folders: readonly URI[]): Promise<URI[]> {
		if (!folders.length) {
			return [];
		}
		const folderQueries = folders.map(folder => ({ folder }));
		const searchQuery = {
			type: QueryType.File as QueryType.File,
			folderQueries,
			filePattern: undefined,
			sortByScore: false,
			excludePattern: GraphView.DEFAULT_EXCLUDE_GLOBS,
			maxResults: 5000
		};
		const results = await this.searchService.fileSearch(searchQuery);
		const files: URI[] = [];
		if (results.limitHit) {
			this.logService.warn('[GraphView] file search limit reached; graph may be incomplete.');
		}
		for (const match of results.results) {
			const resource = match.resource;
			if (!resource) {
				continue;
			}
			if (GraphView.isExcludedPath(resource.path)) {
				continue;
			}
			const lowerPath = resource.path.toLowerCase();
			if (!GraphView.FILE_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
				continue;
			}
			files.push(resource);
		}
		return files;
	}

	private async buildGraphFromFiles(initialFiles: URI[], options: { scopeRoots: Set<string>; scopeMode: GraphMode }): Promise<GraphWebviewPayload> {
		type MutableGraphNode = {
			id: string;
			label: string;
			path: string;
			kind: GraphNodeKind;
			weight: number;
			fanIn: number;
			fanOut: number;
		};

		const nodes = new Map<string, MutableGraphNode>();
		const edges = new Map<string, { payload: GraphEdgePayload; symbols: Set<string> }>();
		const processed = new Set<string>();
		const queue: URI[] = [...initialFiles];
		const descriptorCache = new Map<string, Promise<ImportDescriptor[]>>();
		const resolvedCache = new Map<string, Promise<URI | undefined>>();

		const ensureFileNode = (uri: URI): MutableGraphNode => {
			const id = this.toNodeId(uri);
			let node = nodes.get(id);
			const isRoot = options.scopeMode !== 'workspace' && options.scopeRoots.has(this.getUriKey(uri));
			if (!node) {
				node = {
					id,
					label: this.formatNodeLabel(uri),
					path: uri.toString(true),
					kind: isRoot ? 'root' : 'relative',
					weight: 1,
					fanIn: 0,
					fanOut: 0
				};
				nodes.set(id, node);
			} else if (isRoot && node.kind !== 'root') {
				node.kind = 'root';
			}
			return node;
		};

		const ensureExternalNode = (specifier: string): MutableGraphNode => {
			const id = this.toNodeId(`module:${specifier}`);
			let node = nodes.get(id);
			if (!node) {
				node = {
					id,
					label: specifier,
					path: specifier,
					kind: 'external',
					weight: 1,
					fanIn: 0,
					fanOut: 0
				};
				nodes.set(id, node);
			}
			return node;
		};

		while (queue.length) {
			const fileUri = queue.shift()!;
			const fileKey = this.getUriKey(fileUri);
			if (processed.has(fileKey)) {
				continue;
			}
			processed.add(fileKey);

			const sourceNode = ensureFileNode(fileUri);
			let descriptors: ImportDescriptor[] = [];
			try {
				descriptors = await this.getImportDescriptors(fileUri, descriptorCache);
			} catch (error) {
				this.logService.error('[GraphView] failed to parse imports', fileUri.toString(true), error);
				continue;
			}

			for (const descriptor of descriptors) {
				const resolvedUri = await this.resolveImportTargetCached(fileUri, descriptor.specifier, resolvedCache);
				if (this.shouldIgnoreImport(descriptor.specifier, resolvedUri)) {
					continue;
				}

				let targetNode: MutableGraphNode;
				let targetId: string;
				let edgeKind: GraphEdgeKind;
				if (resolvedUri && this.isWithinWorkspace(resolvedUri) && !GraphView.isExcludedPath(resolvedUri.path)) {
					queue.push(resolvedUri);
					targetNode = ensureFileNode(resolvedUri);
					targetId = targetNode.id;
					edgeKind = descriptor.isSideEffectOnly ? 'sideEffect' : 'relative';
				} else {
					targetNode = ensureExternalNode(descriptor.specifier);
					targetId = targetNode.id;
					edgeKind = descriptor.isSideEffectOnly ? 'sideEffect' : 'external';
				}

				const edgeKey = `${sourceNode.id}->${targetId}`;
				let entry = edges.get(edgeKey);
				if (!entry) {
					const payload: GraphEdgePayload = {
						id: this.toNodeId(`edge:${edgeKey}`),
						source: sourceNode.id,
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

				targetNode.fanIn += 1;
				sourceNode.fanOut += 1;
				sourceNode.weight = Math.max(sourceNode.weight, sourceNode.fanIn + sourceNode.fanOut);
				targetNode.weight = Math.max(targetNode.weight, targetNode.fanIn + targetNode.fanOut);
				entry.payload.label = this.composeEdgeLabel(entry.symbols, entry.payload.kind);
			}
		}

		const nodeArray = Array.from(nodes.values()).map(node => {
			if (node.weight <= 1) {
				node.weight = Math.max(1, node.fanIn + node.fanOut);
			}
			return node;
		});
		const edgeArray = Array.from(edges.values(), entry => entry.payload);
		return { nodes: nodeArray, edges: edgeArray };
	}

	private async getImportDescriptors(uri: URI, cache: Map<string, Promise<ImportDescriptor[]>>): Promise<ImportDescriptor[]> {
		const key = this.getUriKey(uri);
		let promise = cache.get(key);
		if (!promise) {
			promise = (async () => {
				const buffer = await this.fileService.readFile(uri);
				const content = buffer.value.toString();
				return this.extractImportDescriptors(content);
			})();
			cache.set(key, promise);
		}
		return promise;
	}

	private async resolveImportTargetCached(sourceUri: URI, specifier: string, cache: Map<string, Promise<URI | undefined>>): Promise<URI | undefined> {
		const cacheKey = `${this.getUriKey(sourceUri)}::${specifier}`;
		let promise = cache.get(cacheKey);
		if (!promise) {
			promise = this.resolveImportTarget(sourceUri, specifier);
			cache.set(cacheKey, promise);
		}
		return promise;
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
