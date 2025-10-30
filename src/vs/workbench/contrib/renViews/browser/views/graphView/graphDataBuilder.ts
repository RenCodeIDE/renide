/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ISearchService, IFileMatch, QueryType } from '../../../../../services/search/common/search.js';

import { GraphWorkspaceContext } from './graphContext.js';
import {
	GraphEdgeKind,
	GraphEdgePayload,
	GraphNodeKind,
	GraphScopeOptions,
	GraphWebviewPayload,
	ImportDescriptor
} from './graphTypes.js';

import {
	GRAPH_DEFAULT_EXCLUDE_GLOBS,
	GRAPH_FILE_EXTENSIONS,
	GRAPH_IGNORED_IMPORT_SPECIFIERS,
	GRAPH_INDEX_FILENAMES,
	getImportBase,
	isExcludedPath,
	toCytoscapeId
} from './graphConstants.js';

export class GraphDataBuilder {
	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly context: GraphWorkspaceContext
	) { }

	async buildGraphForFile(sourceUri: URI): Promise<GraphWebviewPayload> {
		return this.buildGraphFromFiles([
			sourceUri
		], {
			scopeRoots: new Set([this.context.getUriKey(sourceUri)]),
			scopeMode: 'file'
		});
	}

	async buildGraphForScope(folders: URI[], mode: 'folder' | 'workspace'): Promise<GraphWebviewPayload> {
		const files = await this.collectFilesInScope(folders);
		return this.buildGraphFromFiles(files, {
			scopeRoots: new Set(files.map(uri => this.context.getUriKey(uri))),
			scopeMode: mode
		});
	}

	async collectFilesInScope(folders: readonly URI[]): Promise<URI[]> {
		if (!folders.length) {
			return [];
		}
		const folderQueries = folders.map(folder => ({ folder }));
		const searchQuery = {
			type: QueryType.File as QueryType.File,
			folderQueries,
			filePattern: undefined,
			sortByScore: false,
			excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
			maxResults: 5000
		};
		const results = await this.searchService.fileSearch(searchQuery);
		const files: URI[] = [];
		if (results.limitHit) {
			this.logService.warn('[GraphView] file search limit reached; graph may be incomplete.');
		}
		for (const match of results.results) {
			const resource = (match as IFileMatch).resource;
			if (!resource) {
				continue;
			}
			if (isExcludedPath(resource.path)) {
				continue;
			}
			const lowerPath = resource.path.toLowerCase();
			if (!GRAPH_FILE_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
				continue;
			}
			files.push(resource);
		}
		return files;
	}

	private async buildGraphFromFiles(initialFiles: URI[], options: GraphScopeOptions): Promise<GraphWebviewPayload> {
		type MutableGraphNode = {
			id: string;
			label: string;
			path: string;
			kind: GraphNodeKind;
			weight: number;
			fanIn: number;
			fanOut: number;
			openable: boolean;
		};

		const nodes = new Map<string, MutableGraphNode>();
		const edges = new Map<string, { payload: GraphEdgePayload; labelParts: Set<string>; symbolNames: Set<string> }>();
		const processed = new Set<string>();
		const queue: URI[] = [...initialFiles];
		const descriptorCache = new Map<string, Promise<ImportDescriptor[]>>();
		const resolvedCache = new Map<string, Promise<URI | undefined>>();

		const ensureFileNode = (uri: URI): MutableGraphNode => {
			const id = this.toNodeId(uri);
			let node = nodes.get(id);
			const isRoot = options.scopeMode !== 'workspace' && options.scopeRoots.has(this.context.getUriKey(uri));
			const isExcluded = isExcludedPath(uri.path);
			const isWithinWorkspace = this.context.isWithinWorkspace(uri);
			const openable = isWithinWorkspace && !isExcluded;
			if (!node) {
				node = {
					id,
					label: this.context.formatNodeLabel(uri),
					path: uri.toString(true),
					kind: isRoot ? 'root' : 'relative',
					weight: 1,
					fanIn: 0,
					fanOut: 0,
					openable
				};
				nodes.set(id, node);
			} else if (isRoot && node.kind !== 'root') {
				node.kind = 'root';
			}
			node.openable = node.openable && openable;
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
					fanOut: 0,
					openable: false
				};
				nodes.set(id, node);
			}
			return node;
		};

		while (queue.length) {
			const fileUri = queue.shift()!;
			const fileKey = this.context.getUriKey(fileUri);
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
				if (resolvedUri && this.context.isWithinWorkspace(resolvedUri) && !isExcludedPath(resolvedUri.path)) {
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
						kind: edgeKind,
						sourcePath: sourceNode.path,
						targetPath: targetNode.path,
						symbols: []
					};
					entry = { payload, labelParts: new Set<string>(), symbolNames: new Set<string>() };
					edges.set(edgeKey, entry);
				}

				for (const symbol of this.getSymbolsForDescriptor(descriptor)) {
					entry.labelParts.add(symbol);
				}
				for (const candidate of this.getSymbolNameCandidates(descriptor)) {
					entry.symbolNames.add(candidate);
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
				entry.payload.label = this.composeEdgeLabel(entry.labelParts, entry.payload.kind);
				entry.payload.symbols = entry.symbolNames.size ? Array.from(entry.symbolNames) : [];
			}
		}

		const nodeArray = Array.from(nodes.values()).map(node => {
			if (node.weight <= 1) {
				node.weight = Math.max(1, node.fanIn + node.fanOut);
			}
			return node;
		});
		const edgeArray = Array.from(edges.values(), entry => {
			if (!entry.payload.symbols || entry.payload.symbols.length === 0) {
				entry.payload.symbols = entry.symbolNames.size ? Array.from(entry.symbolNames) : [];
			}
			return entry.payload;
		});
		return { nodes: nodeArray, edges: edgeArray };
	}

	private async getImportDescriptors(uri: URI, cache: Map<string, Promise<ImportDescriptor[]>>): Promise<ImportDescriptor[]> {
		const key = this.context.getUriKey(uri);
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
		const cacheKey = `${this.context.getUriKey(sourceUri)}::${specifier}`;
		let promise = cache.get(cacheKey);
		if (!promise) {
			promise = this.resolveImportTarget(sourceUri, specifier);
			cache.set(cacheKey, promise);
		}
		return promise;
	}

	private toNodeId(value: URI | string): string {
		const raw = typeof value === 'string' ? value : value.toString(true);
		return toCytoscapeId(raw);
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

	private getSymbolNameCandidates(descriptor: ImportDescriptor): string[] {
		const candidates: string[] = [];
		if (descriptor.defaultImport) {
			candidates.push(descriptor.defaultImport.name);
		}
		if (descriptor.namespaceImport) {
			candidates.push(descriptor.namespaceImport.name);
		}
		for (const item of descriptor.namedImports) {
			candidates.push(item.propertyName ?? item.name);
		}
		return candidates;
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
		let baseUri: URI | undefined;
		if (specifier.startsWith('.')) {
			baseUri = this.context.extUri.resolvePath(this.context.extUri.dirname(sourceUri), specifier);
		} else if (specifier.startsWith('/')) {
			const workspaceRoot = this.context.getDefaultWorkspaceRoot();
			if (workspaceRoot) {
				baseUri = this.context.extUri.resolvePath(workspaceRoot, specifier);
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
		const extUri = this.context.extUri;
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

		if (extension && GRAPH_FILE_EXTENSIONS.some(ext => ext === extension)) {
			pushCandidate(baseUri);
			return candidates;
		}

		const dir = extUri.dirname(baseUri);
		const baseName = extUri.basename(baseUri);

		for (const ext of GRAPH_FILE_EXTENSIONS) {
			pushCandidate(extUri.joinPath(dir, `${baseName}${ext}`));
		}

		if (baseName && baseName !== 'index') {
			for (const indexName of GRAPH_INDEX_FILENAMES) {
				pushCandidate(extUri.joinPath(baseUri, indexName));
			}
		}

		return candidates;
	}

	private shouldIgnoreImport(specifier: string, resolvedUri: URI | undefined): boolean {
		const base = getImportBase(specifier);
		if (GRAPH_IGNORED_IMPORT_SPECIFIERS.has(base)) {
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
}

