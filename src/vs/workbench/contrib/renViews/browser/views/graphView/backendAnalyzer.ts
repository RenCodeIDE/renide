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
	BackendArchPayload
} from './graphTypes.js';

/**
 * HTTP method types (matching BackendArchPayload)
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Extracted endpoint information
 */
interface EndpointInfo {
	method: HttpMethod;
	path: string;
	handler: string;
	filePath: string;
	middlewares: string[];
	controller?: string;
}

/**
 * Controller information
 */
interface ControllerInfo {
	name: string;
	filePath: string;
	basePath?: string;
	methods: {
		name: string;
		httpMethod: HttpMethod;
		path: string;
	}[];
	dependencies: string[];
}

/**
 * Service information
 */
interface ServiceInfo {
	name: string;
	filePath: string;
	methods: string[];
	dependencies: string[];
	isInjectable: boolean;
}

/**
 * Repository/Data Access information
 */
interface RepositoryInfo {
	name: string;
	filePath: string;
	entity?: string;
	methods: string[];
	orm?: string;
}

/**
 * Middleware information
 */
interface MiddlewareInfo {
	name: string;
	filePath: string;
	type: 'global' | 'route' | 'error';
}

/**
 * Backend Analyzer
 *
 * Extracts backend-specific architecture information:
 * - API routes and endpoints (Express, Fastify, NestJS, Koa)
 * - Controllers and route handlers
 * - Services and business logic
 * - Repositories and data access patterns
 * - Middleware chains
 * - Database connections
 */
export class BackendAnalyzer {
	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly context: GraphWorkspaceContext
	) { }

	/**
	 * Analyze the workspace for backend architecture
	 */
	async analyze(framework: string): Promise<BackendArchPayload> {
		this.logService.info(`[BackendAnalyzer] Starting analysis for ${framework}...`);

		const endpoints = await this.extractEndpoints(framework);
		const controllers = await this.extractControllers(framework);
		const services = await this.extractServices();
		const repositories = await this.extractRepositories();
		const middlewares = await this.extractMiddlewares(framework);
		const databases = await this.extractDatabaseInfo();

		// Build graph from extracted info
		const { nodes, edges } = this.buildGraph(
			endpoints, controllers, services, repositories, middlewares, databases
		);

		// Organize into layers
		const layers = this.organizeLayers(nodes);

		const payload: BackendArchPayload = {
			type: 'backend',
			framework,
			nodes,
			edges,
			layers,
			endpoints: endpoints.map(e => ({
				method: e.method,
				path: e.path,
				handler: e.handler,
				middlewares: e.middlewares
			})),
			databases,
			summary: this.generateSummary(endpoints, controllers, services, repositories, framework)
		};

		this.logService.info(`[BackendAnalyzer] Analysis complete: ${nodes.length} nodes, ${edges.length} edges`);

		return payload;
	}

	/**
	 * Extract API endpoints
	 */
	private async extractEndpoints(framework: string): Promise<EndpointInfo[]> {
		const endpoints: EndpointInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return endpoints;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const validExtensions = ['.ts', '.js'];

		// Search for route files
		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: {
					...GRAPH_DEFAULT_EXCLUDE_GLOBS,
					'**/node_modules/**': true,
					'**/dist/**': true,
					'**/build/**': true,
					'**/*.test.*': true,
					'**/*.spec.*': true
				},
				maxResults: 1000
			});

			// Filter by extension
			const tsJsFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				return validExtensions.some(ext => lowerPath.endsWith(ext));
			});

			for (const match of tsJsFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const fileEndpoints = await this.analyzeRouteFile(fileUri, framework);
				endpoints.push(...fileEndpoints);
			}
		} catch (error) {
			this.logService.warn('[BackendAnalyzer] Error searching for endpoints:', error);
		}

		return endpoints;
	}

	/**
	 * Analyze a file for route definitions
	 */
	private async analyzeRouteFile(fileUri: URI, framework: string): Promise<EndpointInfo[]> {
		const endpoints: EndpointInfo[] = [];

		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const filePath = fileUri.path;

			// Check if this file contains route definitions
			if (!this.isRouteFile(text, framework)) {
				return endpoints;
			}

			if (framework === 'Express.js' || framework === 'Koa') {
				endpoints.push(...this.extractExpressRoutes(text, filePath));
			} else if (framework === 'Fastify') {
				endpoints.push(...this.extractFastifyRoutes(text, filePath));
			} else if (framework === 'NestJS') {
				endpoints.push(...this.extractNestJSRoutes(text, filePath));
			} else if (framework === 'Hono') {
				endpoints.push(...this.extractHonoRoutes(text, filePath));
			} else {
				// Generic extraction
				endpoints.push(...this.extractGenericRoutes(text, filePath));
			}
		} catch (error) {
			this.logService.debug(`[BackendAnalyzer] Error analyzing ${fileUri.path}:`, error);
		}

		return endpoints;
	}

	/**
	 * Check if a file contains route definitions
	 */
	private isRouteFile(content: string, framework: string): boolean {
		if (framework === 'Express.js' || framework === 'Koa') {
			return /\.(get|post|put|delete|patch|use)\s*\(/.test(content) ||
				/Router\s*\(\)/.test(content);
		}

		if (framework === 'Fastify') {
			return /\.route\s*\(/.test(content) ||
				/\.(get|post|put|delete|patch)\s*\(/.test(content);
		}

		if (framework === 'NestJS') {
			return /@(Get|Post|Put|Delete|Patch|Controller)\s*\(/.test(content);
		}

		if (framework === 'Hono') {
			return /\.(get|post|put|delete|patch)\s*\(/.test(content) ||
				/new\s+Hono\s*\(/.test(content);
		}

		// Generic check
		return /\.(get|post|put|delete|patch)\s*\(['"\/]/.test(content);
	}

	/**
	 * Extract Express.js style routes
	 */
	private extractExpressRoutes(content: string, filePath: string): EndpointInfo[] {
		const endpoints: EndpointInfo[] = [];
		const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

		for (const method of methods) {
			const methodLower = method.toLowerCase();
			// Match patterns like: app.get('/path', handler) or router.get('/path', ...middlewares, handler)
			const pattern = new RegExp(
				`\\.(${methodLower})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,([^)]+)\\)`,
				'gi'
			);

			let match;
			while ((match = pattern.exec(content)) !== null) {
				const path = match[2];
				const handlerPart = match[3].trim();

				// Extract handler and middlewares
				const parts = handlerPart.split(',').map(p => p.trim());
				const handler = parts[parts.length - 1] || 'anonymous';
				const middlewares = parts.slice(0, -1);

				endpoints.push({
					method,
					path,
					handler: this.cleanHandlerName(handler),
					filePath,
					middlewares: middlewares.map(m => this.cleanHandlerName(m))
				});
			}
		}

		return endpoints;
	}

	/**
	 * Extract Fastify routes
	 */
	private extractFastifyRoutes(content: string, filePath: string): EndpointInfo[] {
		const endpoints: EndpointInfo[] = [];

		// Match fastify.route({ method, url, handler })
		const routePattern = /\.route\s*\(\s*\{[^}]*method:\s*['"](\w+)['"][^}]*url:\s*['"]([^'"]+)['"][^}]*\}/gi;
		let match;

		while ((match = routePattern.exec(content)) !== null) {
			const methodUpper = match[1].toUpperCase();
			if (methodUpper === 'GET' || methodUpper === 'POST' || methodUpper === 'PUT' || methodUpper === 'DELETE' || methodUpper === 'PATCH') {
				endpoints.push({
					method: methodUpper,
					path: match[2],
					handler: 'routeHandler',
					filePath,
					middlewares: []
				});
			}
		}

		// Also check for shorthand methods
		endpoints.push(...this.extractExpressRoutes(content, filePath));

		return endpoints;
	}

	/**
	 * Extract NestJS routes from decorators
	 */
	private extractNestJSRoutes(content: string, filePath: string): EndpointInfo[] {
		const endpoints: EndpointInfo[] = [];

		// Extract controller base path
		const controllerMatch = content.match(/@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/);
		const basePath = controllerMatch ? controllerMatch[1] : '';

		// Extract method decorators
		const methods: Array<[string, HttpMethod]> = [
			['Get', 'GET'],
			['Post', 'POST'],
			['Put', 'PUT'],
			['Delete', 'DELETE'],
			['Patch', 'PATCH']
		];

		for (const [decorator, method] of methods) {
			const pattern = new RegExp(
				`@${decorator}\\s*\\(\\s*['"]?([^'"\\)]*)?['"]?\\s*\\)[\\s\\S]*?(\\w+)\\s*\\([^)]*\\)\\s*(?::\\s*\\w+)?\\s*\\{`,
				'gi'
			);

			let match;
			while ((match = pattern.exec(content)) !== null) {
				const subPath = match[1] || '';
				const handlerName = match[2];
				const fullPath = this.combinePaths(basePath, subPath);

				endpoints.push({
					method,
					path: fullPath,
					handler: handlerName,
					filePath,
					middlewares: [],
					controller: this.extractControllerName(content)
				});
			}
		}

		return endpoints;
	}

	/**
	 * Extract Hono routes
	 */
	private extractHonoRoutes(content: string, filePath: string): EndpointInfo[] {
		// Hono uses similar syntax to Express
		return this.extractExpressRoutes(content, filePath);
	}

	/**
	 * Extract generic route patterns
	 */
	private extractGenericRoutes(content: string, filePath: string): EndpointInfo[] {
		return this.extractExpressRoutes(content, filePath);
	}

	/**
	 * Extract controllers
	 */
	private async extractControllers(framework: string): Promise<ControllerInfo[]> {
		const controllers: ControllerInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return controllers;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const validExtensions = ['.ts', '.js'];
		const controllerKeywords = ['controller'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 500
			});

			// Filter for controller files
			const controllerFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = controllerKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of controllerFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const controllerInfo = await this.analyzeControllerFile(fileUri, framework);
				if (controllerInfo) {
					controllers.push(controllerInfo);
				}
			}
		} catch (error) {
			this.logService.debug('[BackendAnalyzer] Error searching for controllers:', error);
		}

		return controllers;
	}

	/**
	 * Analyze a controller file
	 */
	private async analyzeControllerFile(fileUri: URI, framework: string): Promise<ControllerInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();

			// Extract controller name
			let name: string | null = null;
			let basePath: string | undefined;

			if (framework === 'NestJS') {
				const controllerMatch = text.match(/@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/);
				basePath = controllerMatch ? controllerMatch[1] : '';

				const classMatch = text.match(/class\s+(\w+Controller)/);
				name = classMatch ? classMatch[1] : null;
			} else {
				const classMatch = text.match(/class\s+(\w+)/);
				name = classMatch ? classMatch[1] : null;
			}

			if (!name) {
				return null;
			}

			// Extract methods
			const methods: ControllerInfo['methods'] = [];
			const methodPattern = /(?:@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]?([^'")\s]*)?['"]?\s*\)\s*)?(async\s+)?(\w+)\s*\([^)]*\)/g;
			let match;

			while ((match = methodPattern.exec(text)) !== null) {
				if (match[1]) {
					methods.push({
						name: match[4],
						httpMethod: match[1].toUpperCase() as HttpMethod,
						path: match[2] || ''
					});
				}
			}

			// Extract dependencies (constructor injection)
			const dependencies: string[] = [];
			const constructorMatch = text.match(/constructor\s*\(([^)]+)\)/);
			if (constructorMatch) {
				const params = constructorMatch[1].split(',');
				for (const param of params) {
					const typeMatch = param.match(/:\s*(\w+)/);
					if (typeMatch) {
						dependencies.push(typeMatch[1]);
					}
				}
			}

			return {
				name,
				filePath: fileUri.path,
				basePath,
				methods,
				dependencies
			};
		} catch (error) {
			this.logService.debug(`[BackendAnalyzer] Error analyzing controller ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Extract services
	 */
	private async extractServices(): Promise<ServiceInfo[]> {
		const services: ServiceInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return services;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const validExtensions = ['.ts', '.js'];
		const serviceKeywords = ['service', 'services'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 500
			});

			// Filter for service files
			const serviceFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = serviceKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of serviceFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const serviceInfo = await this.analyzeServiceFile(fileUri);
				if (serviceInfo) {
					services.push(serviceInfo);
				}
			}
		} catch (error) {
			this.logService.debug('[BackendAnalyzer] Error searching for services:', error);
		}

		return services;
	}

	/**
	 * Analyze a service file
	 */
	private async analyzeServiceFile(fileUri: URI): Promise<ServiceInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();

			// Check for Injectable decorator (NestJS)
			const isInjectable = /@Injectable\s*\(/.test(text);

			// Extract class name
			const classMatch = text.match(/class\s+(\w+)/);
			if (!classMatch) {
				return null;
			}

			const name = classMatch[1];

			// Extract methods
			const methods: string[] = [];
			const methodPattern = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g;
			let match;

			while ((match = methodPattern.exec(text)) !== null) {
				const methodName = match[1];
				if (methodName !== 'constructor' && !methodName.startsWith('_')) {
					methods.push(methodName);
				}
			}

			// Extract dependencies
			const dependencies: string[] = [];
			const constructorMatch = text.match(/constructor\s*\(([^)]+)\)/);
			if (constructorMatch) {
				const params = constructorMatch[1].split(',');
				for (const param of params) {
					const typeMatch = param.match(/:\s*(\w+)/);
					if (typeMatch) {
						dependencies.push(typeMatch[1]);
					}
				}
			}

			return {
				name,
				filePath: fileUri.path,
				methods,
				dependencies,
				isInjectable
			};
		} catch (error) {
			this.logService.debug(`[BackendAnalyzer] Error analyzing service ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Extract repositories
	 */
	private async extractRepositories(): Promise<RepositoryInfo[]> {
		const repositories: RepositoryInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return repositories;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const validExtensions = ['.ts', '.js'];
		const repoKeywords = ['repository', 'repositories', 'repo'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 500
			});

			// Filter for repository files
			const repoFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = repoKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of repoFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const repoInfo = await this.analyzeRepositoryFile(fileUri);
				if (repoInfo) {
					repositories.push(repoInfo);
				}
			}
		} catch (error) {
			this.logService.debug('[BackendAnalyzer] Error searching for repositories:', error);
		}

		return repositories;
	}

	/**
	 * Analyze a repository file
	 */
	private async analyzeRepositoryFile(fileUri: URI): Promise<RepositoryInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();

			// Extract class name
			const classMatch = text.match(/class\s+(\w+)/);
			if (!classMatch) {
				return null;
			}

			const name = classMatch[1];

			// Detect ORM
			let orm: string | undefined;
			if (text.includes('prisma') || text.includes('@prisma/client')) {
				orm = 'Prisma';
			} else if (text.includes('TypeORM') || text.includes('Repository')) {
				orm = 'TypeORM';
			} else if (text.includes('mongoose')) {
				orm = 'Mongoose';
			} else if (text.includes('drizzle')) {
				orm = 'Drizzle';
			} else if (text.includes('sequelize')) {
				orm = 'Sequelize';
			}

			// Extract entity
			const entityMatch = text.match(/(?:Repository|Model|Entity)\s*<\s*(\w+)\s*>/);
			const entity = entityMatch ? entityMatch[1] : undefined;

			// Extract methods
			const methods: string[] = [];
			const methodPattern = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g;
			let match;

			while ((match = methodPattern.exec(text)) !== null) {
				const methodName = match[1];
				if (methodName !== 'constructor' && !methodName.startsWith('_')) {
					methods.push(methodName);
				}
			}

			return {
				name,
				filePath: fileUri.path,
				entity,
				methods,
				orm
			};
		} catch (error) {
			this.logService.debug(`[BackendAnalyzer] Error analyzing repository ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Extract middleware information
	 */
	private async extractMiddlewares(framework: string): Promise<MiddlewareInfo[]> {
		const middlewares: MiddlewareInfo[] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return middlewares;
		}

		const folderQueries = workspaceFolders.map(folder => ({ folder: folder.uri }));
		const validExtensions = ['.ts', '.js'];
		const middlewareKeywords = ['middleware', 'middlewares'];

		try {
			const searchResult = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries,
				filePattern: undefined,
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 500
			});

			// Filter for middleware files
			const middlewareFiles = searchResult.results.filter(match => {
				const resource = (match as IFileMatch).resource;
				if (!resource) return false;
				const lowerPath = resource.path.toLowerCase();
				const hasValidExt = validExtensions.some(ext => lowerPath.endsWith(ext));
				const hasKeyword = middlewareKeywords.some(kw => lowerPath.includes(kw));
				return hasValidExt && hasKeyword;
			});

			for (const match of middlewareFiles) {
				const fileUri = (match as IFileMatch).resource;
				if (!fileUri) continue;

				const middlewareInfo = await this.analyzeMiddlewareFile(fileUri);
				if (middlewareInfo) {
					middlewares.push(middlewareInfo);
				}
			}
		} catch (error) {
			this.logService.debug('[BackendAnalyzer] Error searching for middlewares:', error);
		}

		return middlewares;
	}

	/**
	 * Analyze a middleware file
	 */
	private async analyzeMiddlewareFile(fileUri: URI): Promise<MiddlewareInfo | null> {
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const fileName = this.context.extUri.basename(fileUri);

			// Extract name
			const name = fileName.replace(/\.(ts|js)$/, '');

			// Determine type
			let type: MiddlewareInfo['type'] = 'route';

			if (text.includes('err') && text.includes('next')) {
				type = 'error';
			} else if (fileName.includes('global') || text.includes('app.use')) {
				type = 'global';
			}

			return {
				name,
				filePath: fileUri.path,
				type
			};
		} catch (error) {
			this.logService.debug(`[BackendAnalyzer] Error analyzing middleware ${fileUri.path}:`, error);
			return null;
		}
	}

	/**
	 * Extract database information from the architecture
	 */
	private async extractDatabaseInfo(): Promise<BackendArchPayload['databases']> {
		const databases: BackendArchPayload['databases'] = [];
		const workspaceFolders = this.context.getWorkspaceFolders();

		if (workspaceFolders.length === 0) {
			return databases;
		}

		const rootUri = workspaceFolders[0].uri;

		// Check for Prisma schema
		try {
			const prismaUri = this.context.extUri.joinPath(rootUri, 'prisma', 'schema.prisma');
			const prismaContent = await this.fileService.readFile(prismaUri);
			const text = prismaContent.value.toString();

			// Extract provider
			const providerMatch = text.match(/provider\s*=\s*"(\w+)"/);
			const provider = providerMatch ? providerMatch[1] : 'unknown';

			// Extract model names
			const tables: string[] = [];
			const modelPattern = /model\s+(\w+)\s*\{/g;
			let match;
			while ((match = modelPattern.exec(text)) !== null) {
				tables.push(match[1]);
			}

			databases.push({
				type: provider,
				name: 'Database (Prisma)',
				tables
			});
		} catch { /* No Prisma schema */ }

		return databases;
	}

	/**
	 * Build graph nodes and edges
	 */
	private buildGraph(
		endpoints: EndpointInfo[],
		controllers: ControllerInfo[],
		services: ServiceInfo[],
		repositories: RepositoryInfo[],
		middlewares: MiddlewareInfo[],
		databases: BackendArchPayload['databases']
	): { nodes: ArchNode[]; edges: ArchEdge[] } {
		const nodes: ArchNode[] = [];
		const edges: ArchEdge[] = [];

		// Create endpoint nodes
		for (const endpoint of endpoints) {
			nodes.push({
				id: `endpoint-${endpoint.method}-${endpoint.path}`,
				type: 'endpoint',
				label: `${endpoint.method} ${endpoint.path}`,
				layer: 'routes',
				filePath: endpoint.filePath,
				metadata: {
					httpMethod: endpoint.method,
					routePath: endpoint.path,
					middlewares: endpoint.middlewares
				},
				style: this.getStyleForHttpMethod(endpoint.method)
			});
		}

		// Create controller nodes
		for (const controller of controllers) {
			const node: ArchNode = {
				id: `controller-${controller.name}`,
				type: 'controller',
				label: controller.name,
				layer: 'controllers',
				filePath: controller.filePath,
				metadata: {
					routePath: controller.basePath
				},
				style: { backgroundColor: '#10B981', iconName: 'controller' }
			};
			nodes.push(node);

			// Connect to endpoints
			for (const endpoint of endpoints) {
				if (endpoint.controller === controller.name) {
					edges.push({
						id: `edge-${controller.name}-${endpoint.method}-${endpoint.path}`,
						source: `endpoint-${endpoint.method}-${endpoint.path}`,
						target: `controller-${controller.name}`,
						type: 'calls'
					});
				}
			}

			// Connect to services (via dependencies)
			for (const dep of controller.dependencies) {
				const service = services.find(s => s.name === dep);
				if (service) {
					edges.push({
						id: `edge-${controller.name}-${dep}`,
						source: `controller-${controller.name}`,
						target: `service-${dep}`,
						type: 'calls',
						label: 'uses'
					});
				}
			}
		}

		// Create service nodes
		for (const service of services) {
			const node: ArchNode = {
				id: `service-${service.name}`,
				type: 'service',
				label: service.name,
				layer: 'services',
				filePath: service.filePath,
				metadata: {
					exports: service.methods
				},
				style: { backgroundColor: '#F59E0B', iconName: 'service' }
			};
			nodes.push(node);

			// Connect to repositories
			for (const dep of service.dependencies) {
				const repo = repositories.find(r => r.name === dep);
				if (repo) {
					edges.push({
						id: `edge-${service.name}-${dep}`,
						source: `service-${service.name}`,
						target: `repository-${dep}`,
						type: 'calls',
						label: 'uses'
					});
				}
			}
		}

		// Create repository nodes
		for (const repo of repositories) {
			const node: ArchNode = {
				id: `repository-${repo.name}`,
				type: 'repository',
				label: repo.name,
				layer: 'repositories',
				filePath: repo.filePath,
				description: repo.orm ? `Uses ${repo.orm}` : undefined,
				metadata: {
					exports: repo.methods
				},
				style: { backgroundColor: '#8B5CF6', iconName: 'repository' }
			};
			nodes.push(node);
		}

		// Create database nodes
		for (const db of databases) {
			const node: ArchNode = {
				id: `database-${db.name}`,
				type: 'database',
				label: db.name,
				layer: 'data',
				metadata: {},
				style: { backgroundColor: '#EF4444', iconName: 'database' }
			};
			nodes.push(node);

			// Connect repositories to database
			for (const repo of repositories) {
				edges.push({
					id: `edge-${repo.name}-${db.name}`,
					source: `repository-${repo.name}`,
					target: `database-${db.name}`,
					type: 'queries',
					label: 'queries'
				});
			}
		}

		// Create middleware nodes
		for (const middleware of middlewares) {
			const node: ArchNode = {
				id: `middleware-${middleware.name}`,
				type: 'middleware',
				label: middleware.name,
				layer: 'routes',
				filePath: middleware.filePath,
				metadata: {},
				style: { backgroundColor: '#6B7280', iconName: 'middleware' }
			};
			nodes.push(node);
		}

		return { nodes, edges };
	}

	/**
	 * Get style for HTTP method
	 */
	private getStyleForHttpMethod(method: HttpMethod): ArchNode['style'] {
		const colors: Record<string, string> = {
			GET: '#22C55E',
			POST: '#3B82F6',
			PUT: '#F59E0B',
			DELETE: '#EF4444',
			PATCH: '#8B5CF6'
		};

		return {
			backgroundColor: colors[method] ?? '#6B7280',
			iconName: 'api'
		};
	}

	/**
	 * Organize nodes into layers
	 */
	private organizeLayers(nodes: ArchNode[]): BackendArchPayload['layers'] {
		return {
			routes: nodes.filter(n => n.layer === 'routes'),
			controllers: nodes.filter(n => n.layer === 'controllers'),
			services: nodes.filter(n => n.layer === 'services'),
			repositories: nodes.filter(n => n.layer === 'repositories'),
			data: nodes.filter(n => n.layer === 'data')
		};
	}

	/**
	 * Helper: Clean handler name
	 */
	private cleanHandlerName(handler: string): string {
		return handler
			.replace(/^\s*async\s*/, '')
			.replace(/\s*=>\s*.*$/, '')
			.replace(/[^\w]/g, '')
			.trim();
	}

	/**
	 * Helper: Combine paths
	 */
	private combinePaths(base: string, sub: string): string {
		const basePath = base.replace(/\/$/, '');
		const subPath = sub.replace(/^\//, '');

		if (!basePath && !subPath) {
			return '/';
		}

		if (!basePath) {
			return '/' + subPath;
		}

		if (!subPath) {
			return '/' + basePath;
		}

		return '/' + basePath + '/' + subPath;
	}

	/**
	 * Helper: Extract controller name from NestJS file
	 */
	private extractControllerName(content: string): string | undefined {
		const match = content.match(/class\s+(\w+Controller)/);
		return match ? match[1] : undefined;
	}

	/**
	 * Generate summary
	 */
	private generateSummary(
		endpoints: EndpointInfo[],
		controllers: ControllerInfo[],
		services: ServiceInfo[],
		repositories: RepositoryInfo[],
		framework: string
	): string[] {
		const summary: string[] = [];

		summary.push(`Backend built with ${framework}`);

		if (endpoints.length > 0) {
			summary.push(`${endpoints.length} API endpoints`);

			// Count by method
			const methodCounts = new Map<string, number>();
			for (const ep of endpoints) {
				methodCounts.set(ep.method, (methodCounts.get(ep.method) ?? 0) + 1);
			}

			const parts: string[] = [];
			const methodCountEntries = Array.from(methodCounts.entries());
			for (const [method, count] of methodCountEntries) {
				parts.push(`${count} ${method}`);
			}
			summary.push(`Methods: ${parts.join(', ')}`);
		}

		if (controllers.length > 0) {
			summary.push(`${controllers.length} controllers`);
		}

		if (services.length > 0) {
			summary.push(`${services.length} services`);
		}

		if (repositories.length > 0) {
			summary.push(`${repositories.length} repositories`);
		}

		return summary;
	}
}
