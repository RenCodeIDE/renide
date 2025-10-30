/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ISearchService, QueryType } from '../../../../../services/search/common/search.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

import { GraphWorkspaceContext } from './graphContext.js';
import {
	GRAPH_DEFAULT_EXCLUDE_GLOBS,
	GRAPH_EXCLUDED_LEAF_NAMES,
	GRAPH_FILE_EXTENSIONS,
	isExcludedPath
} from './graphConstants.js';

type FileQuickPickItem = IQuickPickItem & { uri: URI };

type FolderPickKind = 'select' | 'folder' | 'parent' | 'workspaceRoot' | 'workspaceRootList' | 'custom';
type FolderPickItem = IQuickPickItem & { uri?: URI; kind: FolderPickKind; customValue?: string };

export class GraphPickers {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly searchService: ISearchService,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly context: GraphWorkspaceContext
	) { }

	async pickSourceFile(): Promise<URI | undefined> {
		const workspace = this.context.getWorkspace();
		if (!workspace.folders || workspace.folders.length === 0) {
			return undefined;
		}

		const quickPick = this.quickInputService.createQuickPick<FileQuickPickItem>();
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

		const setResults = (items: FileQuickPickItem[]) => {
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
						excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
						maxResults: 400
					};

					searchCancellation = new CancellationTokenSource();
					const results = await this.searchService.fileSearch(searchQuery, searchCancellation.token);

					const items: FileQuickPickItem[] = results.results
						.map(fileMatch => {
							const uri = fileMatch.resource;
							const relativePath = this.context.formatNodeLabel(uri);
							const folderPath = this.context.extUri.dirname(uri);
							const folderName = this.context.extUri.relativePath(
								workspace.folders[0]?.uri ?? URI.file(''),
								folderPath
							) ?? folderPath.toString(true);

							return {
								label: this.context.extUri.basename(uri),
								description: folderName,
								detail: relativePath,
								uri
							};
						})
						.filter(item => {
							const filePath = item.uri.path;
							if (!GRAPH_FILE_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext))) {
								return false;
							}
							const baseName = this.context.extUri.basename(item.uri).toLowerCase();
							if (GRAPH_EXCLUDED_LEAF_NAMES.has(baseName)) {
								return false;
							}
							return !isExcludedPath(filePath);
						})
						.filter(item => {
							if (!query.trim()) {
								return true;
							}
							const queryLower = query.toLowerCase();
							return item.label.toLowerCase().includes(queryLower) ||
								(item.description?.toLowerCase().includes(queryLower) ?? false) ||
								(item.detail?.toLowerCase().includes(queryLower) ?? false);
						})
						.sort((a, b) => {
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
				const selected = quickPick.selectedItems[0] as FileQuickPickItem | undefined;
				finalize(selected?.uri);
				quickPick.hide();
			}));

			disposables.add(quickPick.onDidHide(() => {
				finalize(undefined);
			}));

			quickPick.show();
		});
	}

	async pickFolder(initialFolder?: URI): Promise<URI | undefined> {
		const workspace = this.context.getWorkspace();
		if (!workspace.folders || workspace.folders.length === 0) {
			return undefined;
		}

		const quickPick = this.quickInputService.createQuickPick<FolderPickItem>();
		quickPick.placeholder = 'Select a folder to visualize';
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.items = [];

		const disposables = new DisposableStore();
		disposables.add(quickPick);

		const normalizeValue = (value: string) => value.trim().replace(/\\/g, '/');
		let currentFolder = initialFolder;
		let currentWorkspaceRoot: URI | undefined;
		let baseItems: FolderPickItem[] = [];
		let customItem: FolderPickItem | undefined;
		let updateToken = 0;

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

		const findWorkspaceRoot = (uri: URI | undefined): URI | undefined => {
			if (!uri) {
				return undefined;
			}
			for (const root of workspace.folders.map(folder => folder.uri)) {
				if (this.context.extUri.isEqualOrParent(uri, root)) {
					return root;
				}
			}
			return undefined;
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
							label: `$(root-folder) ${folderData.name ?? this.context.extUri.basename(folderData.uri)}`,
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
					const folderLabel = this.context.formatNodeLabel(folder) || this.context.extUri.basename(folder);
					items.push({
						label: `$(check) Use ${folderLabel}`,
						description: folder.toString(true),
						uri: folder,
						kind: 'select'
					});

					if (workspace.folders.length > 1) {
						items.push({
							label: '$(arrow-left) Back to workspace folders',
							description: 'Choose a different workspace root',
							kind: 'workspaceRootList'
						});
					}

					const parentCandidate = this.context.extUri.dirname(folder);
					if ((currentWorkspaceRoot && !this.context.extUri.isEqual(folder, currentWorkspaceRoot)) || (!currentWorkspaceRoot && !this.context.extUri.isEqual(parentCandidate, folder))) {
						items.push({
							label: '$(arrow-up) ..',
							description: this.context.formatNodeLabel(parentCandidate) || parentCandidate.toString(true),
							detail: 'Go up one level',
							uri: currentWorkspaceRoot && this.context.extUri.isEqual(parentCandidate, currentWorkspaceRoot) ? currentWorkspaceRoot : parentCandidate,
							kind: 'parent'
						});
					}

					const stat = await this.fileService.resolve(folder, { resolveMetadata: false });
					const children = stat.children ?? [];
					const directories = children
						.filter(child => child.isDirectory && !isExcludedPath(child.resource.path))
						.sort((a, b) => a.name.localeCompare(b.name));

					for (const directory of directories) {
						items.push({
							label: `$(folder) ${directory.name}`,
							description: this.context.formatNodeLabel(directory.resource),
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

			void updateItemsForFolder(initialFolder ?? (workspace.folders.length === 1 ? workspace.folders[0].uri : undefined));
			quickPick.show();
		});
	}

	private async resolveFolderInput(rawValue: string, baseFolder?: URI): Promise<URI | undefined> {
		const normalized = rawValue.trim();
		if (!normalized) {
			return undefined;
		}
		const value = normalized.replace(/\\/g, '/');
		const workspace = this.context.getWorkspace();
		const extUri = this.context.extUri;
		const candidates: URI[] = [];
		const seen = new Set<string>();
		const addCandidate = (candidate: URI | undefined) => {
			if (!candidate) {
				return;
			}
			const key = extUri.getComparisonKey(candidate, true);
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
		if (isExcludedPath(uri.path)) {
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
}

