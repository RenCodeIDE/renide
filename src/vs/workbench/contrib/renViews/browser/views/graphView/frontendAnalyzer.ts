/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ISearchService, QueryType, IFileMatch } from '../../../../../services/search/common/search.js';
import { GraphWorkspaceContext } from './graphContext.js';
import { GRAPH_DEFAULT_EXCLUDE_GLOBS } from './graphConstants.js';
import {
	ArchNode,
	ArchEdge,
	ArchNodeType,
	ArchLayer,
	FrontendArchPayload
} from './graphTypes.js';

/**
 * Component information extracted from source files
 */
interface ComponentInfo {
	name: string;
	filePath: string;
	type: 'page' | 'layout' | 'component' | 'hook' | 'context';
	isExported: boolean;
	isRoot: boolean; // Is this a root component (App.tsx, main.tsx, etc.)
	props: string[];
	hooks: string[];
	imports: string[];
	children: string[];
}

/**
 * Route information
 */
interface RouteInfo {
	path: string;
	component: string;
	layout?: string;
	filePath: string;
	isDynamic: boolean;
}

/**
 * State store information
 */
interface StateInfo {
	name: string;
	type: 'redux' | 'zustand' | 'context' | 'jotai' | 'recoil' | 'mobx' | 'pinia' | 'vuex';
	filePath: string;
	actions: string[];
}

/**
 * Frontend Analyzer
 *
 * Extracts frontend-specific architecture information:
 * - Component hierarchy (pages, layouts, features, shared components)
 * - Routing (file-based for Next.js/Nuxt, config-based for React Router)
 * - State management (Redux, Zustand, Context, etc.)
 * - API client usage (fetch, axios, React Query, SWR)
 */
export class FrontendAnalyzer {
	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly context: GraphWorkspaceContext
	) { }

	/**
	 * Analyze the workspace for frontend architecture
	 */
	async analyze(framework: string): Promise<FrontendArchPayload> {
		this.logService.info(`[FrontendAnalyzer] Starting analysis for ${framework}...`);

		const components = await this.extractComponents(framework);
		const routes = await this.extractRoutes(framework);
		const stateInfo = await this.extractStateManagement();

		this.logService.info(`[FrontendAnalyzer] Extracted: ${components.length} components, ${routes.length} routes, ${stateInfo.length} state stores`);

		// Convert to nodes and edges
		const { nodes, edges } = this.buildGraph(components, routes, stateInfo);

		// Organize into layers
		const layers = this.organizeLayers(nodes);

		// Detect routing type
		const routingType = this.detectRoutingType(framework, routes);

		// Build state management info
		const stateManagement = this.buildStateManagementInfo(stateInfo);

		const payload: FrontendArchPayload = {
			type: 'frontend',
			framework,
			nodes,
			edges,
			layers,
			routing: {
				type: routingType,
				routes: routes.map(r => ({
					path: r.path,
					component: r.component,
					layout: r.layout
				}))
			},
			stateManagement,
			summary: this.generateSummary(components, routes, stateInfo, framework)
		};

		this.logService.info(`[FrontendAnalyzer] Analysis complete: ${nodes.length} nodes, ${edges.length} edges`);

		return payload;
	}

	/**
	 * Extract component information from the codebase
	 */
	private async extractComponents(framework: string): Promise<ComponentInfo[]> {
		const components: ComponentInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		this.logService.info(`[FrontendAnalyzer] extractComponents: Found ${workspaceFolders.length} workspace folders`);

		if (workspaceFolders.length === 0) {
			this.logService.warn('[FrontendAnalyzer] No workspace folders found!');
			return components;
		}

		// Search for component files
		const folderQueries = workspaceFolders.map(folder => {
			this.logService.info(`[FrontendAnalyzer] Will search folder: ${folder.uri.toString()}`);
			return { folder: folder.uri };
		});

		// Define valid component extensions
		const validExtensions = ['.tsx', '.jsx', '.vue', '.svelte'];

		try {
			this.logService.info('[FrontendAnalyzer] Starting file search for components...');
			// Don't use brace expansion - it's not supported by VS Code search API
			// Instead, search for all files and filter by extension
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined, // Get all files, filter later
				excludePattern: {
					...GRAPH_DEFAULT_EXCLUDE_GLOBS,
					'**/node_modules/**': true,
					'**/.next/**': true,
					'**/dist/**': true,
					'**/build/**': true
				},
				maxResults: 2000
			});

			this.logService.info(`[FrontendAnalyzer] File search found ${searchResult.results.length} total files`);

			// Filter by extension
			const componentFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				return validExtensions.some(ext => lowerPath.endsWith(ext));
			});

			this.logService.info(`[FrontendAnalyzer] Filtered to ${componentFiles.length} component files`);

			for (const match of componentFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				this.logService.debug(`[FrontendAnalyzer] Analyzing file: ${fileUri.path}`);
				const componentInfo = await this.analyzeComponentFile(fileUri, framework);
				if (componentInfo) {
					this.logService.debug(`[FrontendAnalyzer] Found component: ${componentInfo.name}`);
					components.push(componentInfo);
				} else {
					this.logService.debug(`[FrontendAnalyzer] No component extracted from: ${fileUri.path}`);
				}
			}

			this.logService.info(`[FrontendAnalyzer] Extracted ${components.length} components total`);
		} catch (error) {
			this.logService.warn('[FrontendAnalyzer] Error searching for components:', error);
		}

		return components;
	}

	/**
	 * Analyze a single component file
	 */
	private async analyzeComponentFile(fileUri: URI, framework: string): Promise<ComponentInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const filePath = fileUri.path;
			const fileName = this.context.extUri.basename(fileUri);

			// Determine component type based on path and content
			const type = this.determineComponentType(filePath, text, framework);

			// Extract component name
			const name = this.extractComponentName(fileName, filePath, text);
			if (!name) {
				return null;
			}

			// Extract hooks used
			const hooks = this.extractHooks(text);

			// Extract props
			const props = this.extractProps(text);

			// Extract imports
			const imports = this.extractImports(text);

			// Check if exported
			const isExported = /export\s+(default\s+)?/.test(text);

			// Check if root component
			const isRoot = this.isRootComponent(fileName, filePath);

			// Extract child components
			const children = this.extractChildComponents(text);

			return {
				name,
				filePath,
				type,
				isExported,
				isRoot,
				props,
				hooks,
				imports,
				children
			};
		} catch (error) {
			this.logService.debug(`[FrontendAnalyzer] Error analyzing ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Determine the type of component based on file path and content
	 */
	private determineComponentType(
		filePath: string,
		content: string,
		framework: string
	): 'page' | 'layout' | 'component' | 'hook' | 'context' {
		const lowerPath = filePath.toLowerCase();
		const fileName = lowerPath.split('/').pop() || '';

		// Check for hooks - file is in /hooks/ directory OR filename starts with 'use'
		const isInHooksDir = /\/hooks\//.test(lowerPath);
		const fileNameStartsWithUse = /^use[A-Z]/i.test(fileName.replace(/\.[^.]+$/, '')); // Check filename without extension
		const contentHasHookExport = /export\s+(default\s+)?function\s+use[A-Z]/.test(content) ||
			/export\s+const\s+use[A-Z]/.test(content);

		if (isInHooksDir || (fileNameStartsWithUse && contentHasHookExport)) {
			return 'hook';
		}

		// Check for context - file is in /context/ directory OR contains createContext
		const isInContextDir = /\/contexts?\//.test(lowerPath);
		const hasCreateContext = /createContext\s*[<(]/.test(content);

		if (isInContextDir || hasCreateContext) {
			return 'context';
		}

		// Check for layouts - file is in layouts directory or is a layout file
		if (/\/layouts?\//.test(lowerPath) || /^layout\./i.test(fileName) || lowerPath.includes('_layout')) {
			return 'layout';
		}

		// Next.js / Nuxt page detection
		if (framework === 'Next.js' || framework === 'Nuxt.js') {
			if (lowerPath.includes('/pages/') || lowerPath.includes('/app/')) {
				// Check if it's a page (page.tsx) or layout (layout.tsx)
				if (lowerPath.endsWith('page.tsx') || lowerPath.endsWith('page.jsx')) {
					return 'page';
				}
				if (lowerPath.endsWith('layout.tsx') || lowerPath.endsWith('layout.jsx')) {
					return 'layout';
				}
				// Old pages directory
				if (lowerPath.includes('/pages/') && !lowerPath.includes('/_') && !lowerPath.includes('/api/')) {
					return 'page';
				}
			}
		}

		// React Router page detection
		if (lowerPath.includes('/pages/') || lowerPath.includes('/views/') || lowerPath.includes('/screens/')) {
			return 'page';
		}

		return 'component';
	}

	/**
	 * Extract component name from file or content
	 */
	private extractComponentName(fileName: string, filePath: string, content: string): string | null {
		// Try to extract from export
		const defaultExportMatch = content.match(/export\s+default\s+(?:function\s+)?(\w+)/);
		if (defaultExportMatch && defaultExportMatch[1] !== 'function') {
			return defaultExportMatch[1];
		}

		// Try named export
		const namedExportMatch = content.match(/export\s+(?:const|function)\s+(\w+)/);
		if (namedExportMatch) {
			return namedExportMatch[1];
		}

		// Fall back to file name
		const name = fileName.replace(/\.(tsx?|jsx?|vue|svelte)$/, '');

		// For index files, use parent directory name
		if (name === 'index') {
			const parts = filePath.split('/');
			const parentDir = parts[parts.length - 2];
			if (parentDir && !['src', 'components', 'pages', 'views'].includes(parentDir.toLowerCase())) {
				return parentDir;
			}
			return null;
		}

		return name;
	}

	/**
	 * Check if a component is a root component
	 */
	private isRootComponent(fileName: string, filePath: string): boolean {
		const lowerName = fileName.toLowerCase();
		const lowerPath = filePath.toLowerCase();

		// Common root component names
		const rootNames = ['app.tsx', 'app.jsx', 'main.tsx', 'main.jsx', 'root.tsx', 'root.jsx'];
		if (rootNames.includes(lowerName)) {
			return true;
		}

		// Check for src/App.tsx pattern
		if (lowerPath.includes('/src/app.') || lowerPath.includes('/src/main.')) {
			return true;
		}

		return false;
	}

	/**
	 * Extract React hooks used in the component
	 */
	private extractHooks(content: string): string[] {
		const hookPattern = /\b(use[A-Z]\w+)\s*\(/g;
		const hooks = new Set<string>();
		let match;

		while ((match = hookPattern.exec(content)) !== null) {
			hooks.add(match[1]);
		}

		return Array.from(hooks);
	}

	/**
	 * Extract props from component definition
	 */
	private extractProps(content: string): string[] {
		const props: string[] = [];

		// TypeScript interface/type props
		const propsInterfaceMatch = content.match(/interface\s+\w*Props\s*\{([^}]+)\}/);
		if (propsInterfaceMatch) {
			const propsBlock = propsInterfaceMatch[1];
			const propPattern = /(\w+)\s*[?:]?\s*:/g;
			let propMatch;
			while ((propMatch = propPattern.exec(propsBlock)) !== null) {
				props.push(propMatch[1]);
			}
		}

		// Destructured props
		const destructuredMatch = content.match(/\(\s*\{\s*([^}]+)\s*\}\s*(?::\s*\w+)?\s*\)/);
		if (destructuredMatch) {
			const propsStr = destructuredMatch[1];
			const propNames = propsStr.split(',').map(p => p.trim().split(/[=:]/)[0].trim()).filter(Boolean);
			props.push(...propNames);
		}

		return Array.from(new Set(props));
	}

	/**
	 * Extract import statements
	 */
	private extractImports(content: string): string[] {
		const imports: string[] = [];
		const importPattern = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
		let match;

		while ((match = importPattern.exec(content)) !== null) {
			const importPath = match[1];
			// Filter out external packages
			if (importPath.startsWith('.') || importPath.startsWith('@/') || importPath.startsWith('~/')) {
				imports.push(importPath);
			}
		}

		return imports;
	}

	/**
	 * Extract child component usage
	 */
	private extractChildComponents(content: string): string[] {
		const children = new Set<string>();
		// Match JSX component usage
		const jsxPattern = /<([A-Z][a-zA-Z0-9]*)/g;
		let match;

		while ((match = jsxPattern.exec(content)) !== null) {
			children.add(match[1]);
		}

		return Array.from(children);
	}

	/**
	 * Extract route information
	 */
	private async extractRoutes(framework: string): Promise<RouteInfo[]> {
		const routes: RouteInfo[] = [];

		if (framework === 'Next.js') {
			routes.push(...await this.extractNextJsRoutes());
		} else if (framework === 'Nuxt.js') {
			routes.push(...await this.extractNuxtRoutes());
		} else {
			routes.push(...await this.extractReactRouterRoutes());
		}

		return routes;
	}

	/**
	 * Extract Next.js file-based routes
	 */
	private async extractNextJsRoutes(): Promise<RouteInfo[]> {
		const routes: RouteInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return routes;
		}

		const rootUri = workspaceFolders[0].uri;

		// Check for app directory (Next.js 13+)
		const appDir = this.context.extUri.joinPath(rootUri, 'app');
		const pagesDir = this.context.extUri.joinPath(rootUri, 'pages');
		const srcAppDir = this.context.extUri.joinPath(rootUri, 'src', 'app');
		const srcPagesDir = this.context.extUri.joinPath(rootUri, 'src', 'pages');

		// Try each directory
		for (const dir of [appDir, srcAppDir, pagesDir, srcPagesDir]) {
			try {
				const stat = await this.fileService.stat(dir);
				if (stat.isDirectory) {
					const isAppRouter = dir.path.includes('/app');
					const extractedRoutes = await this.extractRoutesFromDirectory(dir, '', isAppRouter);
					routes.push(...extractedRoutes);
					break; // Use first found
				}
			} catch { /* Directory doesn't exist */ }
		}

		return routes;
	}

	/**
	 * Recursively extract routes from a directory
	 */
	private async extractRoutesFromDirectory(
		dirUri: URI,
		basePath: string,
		isAppRouter: boolean
	): Promise<RouteInfo[]> {
		const routes: RouteInfo[] = [];

		try {
			// Use resolve with metadata to get directory contents
			const resolved = await this.fileService.resolve(dirUri, { resolveMetadata: true });

			if (!resolved.children) {
				return routes;
			}

			for (const child of resolved.children) {
				const name = this.context.extUri.basename(child.resource);
				const entryUri = child.resource;

				if (child.isDirectory) {
					// Skip special directories
					if (name.startsWith('_') || name.startsWith('.') || name === 'api' || name === 'components') {
						continue;
					}

					// Handle dynamic routes
					let routeSegment = name;

					if (name.startsWith('[') && name.endsWith(']')) {
						routeSegment = `:${name.slice(1, -1)}`;
					}

					const newPath = `${basePath}/${routeSegment}`;
					const subRoutes = await this.extractRoutesFromDirectory(entryUri, newPath, isAppRouter);
					routes.push(...subRoutes);
				} else if (!child.isDirectory) {
					// Check for page files
					if (isAppRouter) {
						if (name === 'page.tsx' || name === 'page.jsx' || name === 'page.ts' || name === 'page.js') {
							routes.push({
								path: basePath || '/',
								component: `${basePath}/page`,
								filePath: entryUri.path,
								isDynamic: basePath.includes(':')
							});
						}
					} else {
						// Pages router
						const ext = name.match(/\.(tsx?|jsx?)$/);
						if (ext && !name.startsWith('_')) {
							const routeName = name.replace(/\.(tsx?|jsx?)$/, '');
							const routePath = routeName === 'index'
								? basePath || '/'
								: `${basePath}/${routeName}`;

							routes.push({
								path: routePath,
								component: routePath,
								filePath: entryUri.path,
								isDynamic: routePath.includes('[')
							});
						}
					}
				}
			}
		} catch (error) {
			this.logService.debug(`[FrontendAnalyzer] Error reading directory ${dirUri.path}:`, error);
		}

		return routes;
	}

	/**
	 * Extract Nuxt.js routes (similar to Next.js pages router)
	 */
	private async extractNuxtRoutes(): Promise<RouteInfo[]> {
		// Similar implementation to Next.js pages router
		return this.extractNextJsRoutes();
	}

	/**
	 * Extract React Router routes from configuration
	 */
	private async extractReactRouterRoutes(): Promise<RouteInfo[]> {
		const routes: RouteInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return routes;
		}

		// Search for router configuration files
		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const routerKeywords = ['router', 'routes', 'routing'];
		const validExtensions = ['.ts', '.tsx', '.js', '.jsx'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 500
			});

			// Filter for router files
			const routerFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = routerKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of routerFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const extractedRoutes = await this.parseRouterConfig(fileUri);
				routes.push(...extractedRoutes);
			}
		} catch (error) {
			this.logService.debug('[FrontendAnalyzer] Error searching for router config:', error);
		}

		return routes;
	}

	/**
	 * Parse a React Router configuration file
	 */
	private async parseRouterConfig(fileUri: URI): Promise<RouteInfo[]> {
		const routes: RouteInfo[] = [];

		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();

			// Match Route components
			const routePattern = /<Route\s+[^>]*path=["']([^"']+)["'][^>]*(?:element|component)=\{?([^}>]+)\}?[^>]*\/?>/g;
			let match;

			while ((match = routePattern.exec(text)) !== null) {
				routes.push({
					path: match[1],
					component: match[2].trim(),
					filePath: fileUri.path,
					isDynamic: match[1].includes(':')
				});
			}

			// Also check for route objects
			const routeObjPattern = /\{\s*path:\s*["']([^"']+)["'][^}]*(?:element|component):\s*([^,}]+)/g;

			while ((match = routeObjPattern.exec(text)) !== null) {
				routes.push({
					path: match[1],
					component: match[2].trim(),
					filePath: fileUri.path,
					isDynamic: match[1].includes(':')
				});
			}
		} catch (error) {
			this.logService.debug(`[FrontendAnalyzer] Error parsing router config ${fileUri.path}:`, error);
		}

		return routes;
	}

	/**
	 * Extract state management information
	 */
	private async extractStateManagement(): Promise<StateInfo[]> {
		const stateStores: StateInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return stateStores;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));

		// Search for state management files
		// Keywords to look for in file names
		const stateKeywords = ['store', 'slice', 'context', 'atom', 'reducer', 'state'];
		const validExtensions = ['.ts', '.tsx', '.js', '.jsx'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 1000
			});

			// Filter for state management files
			const stateFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = stateKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of stateFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const storeInfo = await this.analyzeStateFile(fileUri);
				if (storeInfo) {
					stateStores.push(storeInfo);
				}
			}
		} catch (error) {
			this.logService.debug('[FrontendAnalyzer] Error searching for state files:', error);
		}

		return stateStores;
	}

	/**
	 * Analyze a state management file
	 */
	private async analyzeStateFile(fileUri: URI): Promise<StateInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const fileName = this.context.extUri.basename(fileUri);

			// Detect state management type
			let type: StateInfo['type'] | null = null;

			if (text.includes('createSlice') || text.includes('@reduxjs/toolkit')) {
				type = 'redux';
			} else if (text.includes('create(') && text.includes('zustand')) {
				type = 'zustand';
			} else if (text.includes('createContext')) {
				type = 'context';
			} else if (text.includes('atom(') && text.includes('jotai')) {
				type = 'jotai';
			} else if (text.includes('atom(') && text.includes('recoil')) {
				type = 'recoil';
			} else if (text.includes('makeAutoObservable') || text.includes('mobx')) {
				type = 'mobx';
			} else if (text.includes('defineStore') && text.includes('pinia')) {
				type = 'pinia';
			} else if (text.includes('createStore') && text.includes('vuex')) {
				type = 'vuex';
			}

			if (!type) {
				return null;
			}

			// Extract store name
			const nameMatch = fileName.match(/^(\w+)(?:Store|Slice|Context|Atom)/i);
			const name = nameMatch ? nameMatch[1] : fileName.replace(/\.(ts|tsx|js|jsx)$/, '');

			// Extract actions (simplified)
			const actions: string[] = [];
			const actionPattern = /(\w+):\s*\([^)]*\)\s*=>/g;
			let match;
			while ((match = actionPattern.exec(text)) !== null) {
				actions.push(match[1]);
			}

			return {
				name,
				type,
				filePath: fileUri.path,
				actions
			};
		} catch (error) {
			this.logService.debug(`[FrontendAnalyzer] Error analyzing state file ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Build graph nodes and edges from extracted information
	 */
	private buildGraph(
		components: ComponentInfo[],
		routes: RouteInfo[],
		stateStores: StateInfo[]
	): { nodes: ArchNode[]; edges: ArchEdge[] } {
		this.logService.info(`[FrontendAnalyzer] buildGraph called with: ${components.length} components, ${routes.length} routes, ${stateStores.length} stores`);

		const nodes: ArchNode[] = [];
		const edges: ArchEdge[] = [];
		const nodeMap = new Map<string, ArchNode>();

		// Define group containers for compound node visualization
		const groupDefs: { id: string; label: string; layer: ArchLayer; types: string[] }[] = [
			{ id: 'group-pages', label: 'Pages', layer: 'pages', types: ['page'] },
			{ id: 'group-layouts', label: 'Layouts', layer: 'features', types: ['layout'] },
			{ id: 'group-components', label: 'Components', layer: 'components', types: ['component'] },
			{ id: 'group-hooks', label: 'Hooks', layer: 'shared', types: ['hook'] },
			{ id: 'group-contexts', label: 'Contexts', layer: 'state', types: ['context'] },
			{ id: 'group-state', label: 'State Management', layer: 'state', types: ['store'] },
		];

		// Create group container nodes
		for (const group of groupDefs) {
			const groupNode: ArchNode = {
				id: group.id,
				type: 'component', // Groups use component type for styling fallback
				label: group.label,
				layer: group.layer,
				isGroup: true,
				metadata: {}
			};
			nodes.push(groupNode);
		}

		// Helper to get group ID for a component type
		const getGroupId = (type: string): string | undefined => {
			const group = groupDefs.find(g => g.types.includes(type));
			return group?.id;
		};

		// Create nodes for components
		for (const comp of components) {
			// For root components, always use 'page' layer so they appear at top
			const layer = comp.isRoot ? 'pages' : this.getLayerForType(comp.type);
			const effectiveType = comp.isRoot ? 'page' : comp.type;
			const parentId = getGroupId(effectiveType);

			const node: ArchNode = {
				id: `comp-${comp.name}`,
				type: effectiveType as any, // Root gets page type for styling
				label: comp.isRoot ? `${comp.name} (Root)` : comp.name,
				layer,
				filePath: comp.filePath,
				parent: parentId, // Assign to group container
				metadata: {
					props: comp.props,
					hooks: comp.hooks,
					imports: comp.imports,
					isRoot: comp.isRoot
				},
				style: comp.isRoot
					? { backgroundColor: '#EF4444', iconName: 'home' } // Red for root
					: this.getStyleForType(comp.type)
			};
			nodes.push(node);
			nodeMap.set(comp.name, node);
		}

		// Create nodes for state stores
		for (const store of stateStores) {
			// Contexts get their own group, other state management goes to State Management group
			const isContext = store.type === 'context';
			const nodeType = isContext ? 'context' : 'store';
			const parentGroup = isContext ? 'group-contexts' : 'group-state';

			const node: ArchNode = {
				id: `store-${store.name}`,
				type: nodeType as any,
				label: `${store.name} (${store.type})`,
				layer: 'state',
				filePath: store.filePath,
				parent: parentGroup, // Assign to appropriate group
				metadata: {
					exports: store.actions
				},
				style: this.getStyleForType(nodeType)
			};
			nodes.push(node);
			nodeMap.set(store.name, node);
		}

		// Create edges for component relationships
		for (const comp of components) {
			// Edges for child component usage
			for (const child of comp.children) {
				const childNode = nodeMap.get(child);
				if (childNode) {
					edges.push({
						id: `edge-${comp.name}-${child}`,
						source: `comp-${comp.name}`,
						target: childNode.id,
						type: 'renders',
						label: 'renders'
					});
				}
			}

			// Edges for state usage (based on hooks)
			for (const hook of comp.hooks) {
				// Check if hook name matches a store
				const storeMatch = stateStores.find(s =>
					hook.toLowerCase().includes(s.name.toLowerCase())
				);
				if (storeMatch) {
					edges.push({
						id: `edge-${comp.name}-${storeMatch.name}`,
						source: `comp-${comp.name}`,
						target: `store-${storeMatch.name}`,
						type: 'uses-state',
						label: 'uses'
					});
				}
			}
		}

		// Filter out empty groups (groups with no children)
		this.logService.info(`[FrontendAnalyzer] Before filtering: ${nodes.length} nodes, ${edges.length} edges`);
		const usedGroupIds = new Set(nodes.filter(n => n.parent).map(n => n.parent!));
		this.logService.info(`[FrontendAnalyzer] Used group IDs: ${Array.from(usedGroupIds).join(', ')}`);
		const filteredNodes = nodes.filter(n => !n.isGroup || usedGroupIds.has(n.id));
		this.logService.info(`[FrontendAnalyzer] After filtering: ${filteredNodes.length} nodes`);

		return { nodes: filteredNodes, edges };
	}

	/**
	 * Get the layer for a component type
	 */
	private getLayerForType(type: ComponentInfo['type']): ArchLayer {
		switch (type) {
			case 'page':
				return 'pages';
			case 'layout':
				return 'pages';
			case 'hook':
			case 'context':
				return 'state';
			case 'component':
			default:
				return 'components';
		}
	}

	/**
	 * Get style for a component type
	 */
	private getStyleForType(type: ArchNodeType): ArchNode['style'] {
		const styles: Record<string, ArchNode['style']> = {
			page: { backgroundColor: '#3B82F6', iconName: 'file' },
			layout: { backgroundColor: '#8B5CF6', iconName: 'layout' },
			component: { backgroundColor: '#10B981', iconName: 'component' },
			hook: { backgroundColor: '#F59E0B', iconName: 'hook' },
			context: { backgroundColor: '#EC4899', iconName: 'context' },
			store: { backgroundColor: '#6366F1', iconName: 'database' }
		};
		return styles[type] ?? { backgroundColor: '#6B7280' };
	}

	/**
	 * Organize nodes into layers
	 */
	private organizeLayers(nodes: ArchNode[]): FrontendArchPayload['layers'] {
		return {
			pages: nodes.filter(n => n.layer === 'pages'),
			features: nodes.filter(n => n.layer === 'features'),
			components: nodes.filter(n => n.layer === 'components'),
			state: nodes.filter(n => n.layer === 'state'),
			apiClient: nodes.filter(n => n.layer === 'api-client')
		};
	}

	/**
	 * Detect routing type
	 */
	private detectRoutingType(
		framework: string,
		routes: RouteInfo[]
	): 'file-based' | 'config-based' | 'none' {
		if (framework === 'Next.js' || framework === 'Nuxt.js') {
			return 'file-based';
		}

		if (routes.length > 0) {
			return 'config-based';
		}

		return 'none';
	}

	/**
	 * Build state management info
	 */
	private buildStateManagementInfo(stateStores: StateInfo[]): FrontendArchPayload['stateManagement'] {
		if (stateStores.length === 0) {
			return { type: null, stores: [] };
		}

		// Use the most common type
		const typeCounts = new Map<string, number>();
		for (const store of stateStores) {
			typeCounts.set(store.type, (typeCounts.get(store.type) ?? 0) + 1);
		}

		let primaryType: string | null = null;
		let maxCount = 0;
		const typeCountEntries = Array.from(typeCounts.entries());
		for (const [type, count] of typeCountEntries) {
			if (count > maxCount) {
				maxCount = count;
				primaryType = type;
			}
		}

		return {
			type: primaryType,
			stores: stateStores.map(s => s.name)
		};
	}

	/**
	 * Generate summary
	 */
	private generateSummary(
		components: ComponentInfo[],
		routes: RouteInfo[],
		stateStores: StateInfo[],
		framework: string
	): string[] {
		const summary: string[] = [];

		summary.push(`Frontend built with ${framework}`);

		const pageCount = components.filter(c => c.type === 'page').length;
		const componentCount = components.filter(c => c.type === 'component').length;
		const hookCount = components.filter(c => c.type === 'hook').length;

		if (pageCount > 0) {
			summary.push(`${pageCount} pages detected`);
		}

		if (componentCount > 0) {
			summary.push(`${componentCount} components found`);
		}

		if (hookCount > 0) {
			summary.push(`${hookCount} custom hooks`);
		}

		if (routes.length > 0) {
			summary.push(`${routes.length} routes configured`);
		}

		if (stateStores.length > 0) {
			const type = stateStores[0].type;
			summary.push(`State managed with ${type}`);
		}

		return summary;
	}
}
