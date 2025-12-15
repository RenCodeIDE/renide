/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';

export type GraphNodeKind = 'root' | 'relative' | 'external';

export interface GraphNodePayload {
	id: string;
	label: string;
	path: string;
	kind: GraphNodeKind;
	weight: number;
	fanIn: number;
	fanOut: number;
	openable: boolean;
	description?: string;
	category?: string;
	confidence?: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
	evidence?: string[];
}

export type GraphEdgeKind = 'relative' | 'external' | 'sideEffect';

export interface GraphEdgePayload {
	id: string;
	source: string;
	target: string;
	label: string;
	specifier: string;
	kind: GraphEdgeKind;
	sourcePath?: string;
	targetPath?: string;
	symbols?: string[];
	confidence?: number;
	metadata?: Record<string, unknown>;
	evidence?: string[];
	category?: string;
}

export type GitHeatmapGranularity = 'topLevel' | 'twoLevel' | 'file';

export interface GitHeatmapCommitFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface GitHeatmapCommitSummary {
	hash: string;
	message: string;
	author: string;
	authorEmail?: string;
	timestamp: number;
	modules: string[];
	churn: number;
	files: GitHeatmapCommitFile[];
}

export interface GitHeatmapCell {
	row: number;
	column: number;
	weight: number;
	normalizedWeight: number;
	commitCount: number;
	commits: GitHeatmapCommitSummary[];
}

export interface GitHeatmapScale {
	min: number;
	median: number;
	max: number;
}

export interface GitHeatmapPayload {
	modules: string[];
	granularity: GitHeatmapGranularity;
	windowDays: number;
	totalCommits: number;
	consideredCommits: number;
	generationStartedAt: number;
	churn: number[];
	cells: GitHeatmapCell[];
	colorScale: GitHeatmapScale;
	summary: string[];
	description: string;
	normalization: string;
	filters: string[];
}

export interface GraphWebviewPayload {
	nodes: GraphNodePayload[];
	edges: GraphEdgePayload[];
	mode?: GraphMode;
	summary?: string[];
	warnings?: string[];
	generatedAt?: number;
	metadata?: Record<string, unknown>;
	heatmap?: GitHeatmapPayload;
}

export interface ImportDescriptor {
	specifier: string;
	defaultImport?: { name: string; isTypeOnly: boolean };
	namespaceImport?: { name: string; isTypeOnly: boolean };
	namedImports: Array<{ name: string; propertyName?: string; isTypeOnly: boolean }>;
	isSideEffectOnly: boolean;
}

export type GraphMode =
	| 'file'
	| 'folder'
	| 'workspace'
	| 'architecture'      // Existing generic architecture view
	| 'frontendArch'      // NEW: Frontend-specific view (components, state, routes)
	| 'backendArch'       // NEW: Backend-specific view (routes, controllers, services, DB)
	| 'fullstackArch'     // NEW: Split view showing FE/BE with API boundary
	| 'smartArch'         // NEW: Auto-detect and show the most appropriate view
	| 'gitHeatmap'
	| 'dataFlow'
	| 'evolution'
	| 'changeImpact';

export interface TimelineEvent {
	id: string;
	timestamp: number;
	label: string;
	description?: string;
	author: string;
	type: 'commit';
	affectedNodes: string[];
	metadata: {
		additions: number;
		deletions: number;
	};
}

export interface GraphTimelinePayload {
	events: TimelineEvent[];
	windowDays: number;
	nodeStates: Map<string, { [timestamp: number]: { weight: number; status: GraphStatusLevel } }>;
}

export interface ImpactPayload {
	draftId: string;
	affectedNodes: string[];
	impactedNodes: string[];
	deprecatedDocs: string[];
	breakingChangesScore: number;
}

export type GraphStatusLevel = 'info' | 'warning' | 'error' | 'loading' | 'success';

export interface GraphScopeOptions {
	scopeRoots: Set<string>;
	scopeMode: GraphMode;
}

export interface GraphBuildContext {
	initialFiles: URI[];
	options: GraphScopeOptions;
}

export interface FunctionDefinition {
	id: string; // Unique identifier: `${fileUri}:${functionName}:${line}:${column}`
	name: string;
	fileUri: URI;
	range: Range;
	signature?: string;
	isExported: boolean;
	kind: 'function' | 'method' | 'constructor' | 'arrow' | 'async';
}

export interface FunctionCall {
	caller: FunctionDefinition;
	callee: FunctionDefinition;
	callSite: Range; // Location where the call is made
	callType: 'direct' | 'indirect'; // direct = explicit call, indirect = callback/promise
}

export interface DataFlowGraphOptions {
	maxDepth?: number; // Maximum depth to traverse (default: 10)
	includeUpstream: boolean; // Include callers (default: true)
	includeDownstream: boolean; // Include callees (default: true)
	includeExternal: boolean; // Include external/imported functions (default: false)
}

// ============================================================================
// Context-Aware Architecture Types (Comprehensive)
// ============================================================================

/**
 * Frontend node types for architecture visualization
 */
export type FrontendArchNodeType =
	// UI Layer
	| 'page'              // Route-level components (pages/, app/, routes/)
	| 'layout'            // Layout wrappers (layout.tsx, _layout.tsx)
	| 'component'         // Reusable UI components
	| 'ui-component'      // UI library primitives (shadcn, MUI, Chakra)
	| 'form'              // Form components (useForm, Formik)
	| 'modal'             // Modal/dialog components
	// Logic Layer
	| 'hook'              // Custom React hooks (use*.ts)
	| 'hoc'               // Higher-order components (with*.tsx)
	| 'context'           // React Context providers
	| 'store'             // State stores (Zustand, Redux, MobX)
	| 'reducer'           // Redux reducers
	| 'selector'          // Redux selectors
	| 'provider'          // Provider components
	// Routing
	| 'route'             // Route definitions
	| 'guard'             // Route guards (auth guards)
	| 'loader'            // Data loaders (React Router loaders)
	| 'error-boundary';   // Error boundaries

/**
 * Backend node types for architecture visualization
 */
export type BackendArchNodeType =
	// API Layer
	| 'endpoint'          // API endpoints
	| 'controller'        // Controllers (@Controller)
	| 'router'            // Route definitions (Express Router)
	| 'resolver'          // GraphQL resolvers
	| 'websocket-gateway' // WebSocket handlers
	| 'grpc-service'      // gRPC services
	// Business Logic
	| 'service'           // Business logic (@Injectable)
	| 'use-case'          // Use cases (Clean Architecture)
	| 'handler'           // Command/event handlers (CQRS)
	| 'factory'           // Factory patterns
	// Data Layer
	| 'repository'        // Data access (@Repository)
	| 'entity'            // ORM entities (@Entity)
	| 'model'             // Data models (Mongoose)
	| 'dto'               // Data transfer objects
	| 'schema'            // Validation schemas (Zod, Joi)
	| 'migration'         // DB migrations
	| 'seed'              // DB seeders
	| 'validator'         // Custom validators
	// Infrastructure
	| 'middleware'        // Middleware
	| 'interceptor'       // Request interceptors
	| 'filter'            // Exception filters
	| 'pipe'              // NestJS pipes
	| 'queue'             // Job queues (Bull, RabbitMQ)
	| 'job'               // Background jobs
	| 'cron'              // Scheduled tasks
	| 'event-listener'    // Event handlers
	| 'cache'             // Cache layers
	| 'database'          // DB connections
	| 'storage';          // File storage

/**
 * Shared node types for architecture visualization
 */
export type SharedArchNodeType =
	| 'utility'           // Utility functions
	| 'helper'            // Helper functions
	| 'constant'          // Constants
	| 'type'              // TypeScript types
	| 'interface'         // Interfaces
	| 'config'            // Configuration
	| 'env'               // Environment
	| 'test'              // Test files
	| 'mock'              // Mocks/fixtures
	| 'api-client'        // API clients (tRPC, SDK)
	| 'external'          // External deps
	| 'package'           // Monorepo packages
	| 'unknown';          // Unclassified

/**
 * All node types for context-aware architecture visualization
 */
export type ArchNodeType = FrontendArchNodeType | BackendArchNodeType | SharedArchNodeType;

/**
 * Frontend layers for architecture visualization
 */
export type FrontendArchLayer =
	| 'pages'             // Page components
	| 'layouts'           // Layout components
	| 'features'          // Feature modules
	| 'components'        // Reusable components
	| 'hooks'             // Custom hooks
	| 'state'             // State management
	| 'routing'           // Routing configuration
	| 'api-client';       // API client layer

/**
 * Backend layers for architecture visualization
 */
export type BackendArchLayer =
	| 'routes'            // Route definitions
	| 'controllers'       // Controllers
	| 'resolvers'         // GraphQL resolvers
	| 'services'          // Business logic
	| 'repositories'      // Data access
	| 'models'            // Data models
	| 'middleware'        // Middleware
	| 'infrastructure'    // Infrastructure (queues, cron, etc.)
	| 'jobs'              // Background jobs
	| 'data';             // Data layer (legacy)

/**
 * Shared layers for architecture visualization
 */
export type SharedArchLayer =
	| 'shared'            // Shared utilities
	| 'config'            // Configuration
	| 'types'             // Type definitions
	| 'external'          // External dependencies
	| 'tests';            // Test files

/**
 * All layers in the architecture visualization
 */
export type ArchLayer = FrontendArchLayer | BackendArchLayer | SharedArchLayer;

/**
 * Edge types for architecture relationships
 */
export type ArchEdgeType =
	| 'imports'           // File imports another file
	| 'renders'           // Component renders another component
	| 'calls'             // Function/method calls
	| 'uses-state'        // Component uses state from store/context
	| 'fetches'           // Makes API request
	| 'queries'           // Database query
	| 'middleware-chain'  // Middleware chain
	| 'depends-on'        // Generic dependency
	| 'extends'           // Class extension
	| 'implements';       // Interface implementation

/**
 * Layer container definition for Cytoscape compound nodes
 */
export interface ArchLayerContainer {
	id: string;           // Layer ID (e.g., 'layer-pages')
	label: string;        // Display label (e.g., 'Pages')
	layer: ArchLayer;     // Layer type
	order: number;        // Vertical order (0 = top)
	color: string;        // Background color
	borderColor: string;  // Border color
}

/**
 * Node payload for architecture visualization (Cytoscape compound nodes)
 */
export interface ArchNode {
	id: string;
	type: ArchNodeType;
	label: string;                    // Full label (e.g., 'Button.tsx')
	conciseLabel?: string;            // Short label for display (e.g., 'Button')
	layer: ArchLayer;
	filePath?: string;
	description?: string;
	aiDescription?: string;           // AI-generated description
	parent?: string;                  // Parent node ID for compound nodes (Cytoscape)
	isGroup?: boolean;                // True if this is a container/group node
	metadata: {
		// Frontend-specific
		props?: string[];
		hooks?: string[];
		stateConnections?: string[];
		isRoot?: boolean;             // Is this a root component (App.tsx, main.tsx)

		// Backend-specific
		httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		routePath?: string;
		middlewares?: string[];

		// Shared
		exports?: string[];
		imports?: string[];
		dependencies?: string[];      // External package dependencies
		linesOfCode?: number;
		complexity?: number;

		// Layer container specific
		type?: ArchNodeType;          // Original type for containers
		layer?: ArchLayer;            // Layer for containers
		isGroup?: boolean;            // Is group node
	};
	position?: { x: number; y: number }; // For layout positioning
	style?: {
		backgroundColor?: string;
		borderColor?: string;
		iconName?: string;
	};
}

/**
 * Edge payload for React Flow-based architecture visualization
 */
export interface ArchEdge {
	id: string;
	source: string;
	target: string;
	type: ArchEdgeType;
	label?: string;
	animated?: boolean;
	style?: {
		stroke?: string;
		strokeDasharray?: string;
	};
}

/**
 * Frontend architecture payload
 */
export interface FrontendArchPayload {
	type: 'frontend';
	framework: string;
	nodes: ArchNode[];
	edges: ArchEdge[];
	layers: {
		pages: ArchNode[];
		features: ArchNode[];
		components: ArchNode[];
		state: ArchNode[];
		apiClient: ArchNode[];
	};
	routing: {
		type: 'file-based' | 'config-based' | 'none';
		routes: Array<{
			path: string;
			component: string;
			layout?: string;
		}>;
	};
	stateManagement: {
		type: string | null; // 'redux', 'zustand', 'context', etc.
		stores: string[];
	};
	summary: string[];
}

/**
 * Backend architecture payload
 */
export interface BackendArchPayload {
	type: 'backend';
	framework: string;
	nodes: ArchNode[];
	edges: ArchEdge[];
	layers: {
		routes: ArchNode[];
		controllers: ArchNode[];
		services: ArchNode[];
		repositories: ArchNode[];
		data: ArchNode[];
	};
	endpoints: Array<{
		method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		path: string;
		handler: string;
		middlewares: string[];
	}>;
	databases: Array<{
		type: string;
		name: string;
		tables?: string[];
	}>;
	summary: string[];
}

/**
 * Full-stack architecture payload with split view
 */
export interface FullstackArchPayload {
	type: 'fullstack';
	frontend: FrontendArchPayload;
	backend: BackendArchPayload;
	apiConnections: Array<{
		frontendNode: string;
		backendEndpoint: string;
		method: string;
		path: string;
	}>;
	sharedPackages: ArchNode[];
	summary: string[];
}

/**
 * Smart architecture payload (auto-detected)
 */
export type SmartArchPayload =
	| FrontendArchPayload
	| BackendArchPayload
	| FullstackArchPayload;

/**
 * Context-aware architecture webview payload
 */
export interface ContextAwareArchPayload {
	codebaseType: 'frontend' | 'backend' | 'fullstack' | 'monorepo' | 'unknown';
	confidence: number;
	primaryFramework: string | null;
	data: SmartArchPayload;
	aiEnhanced: boolean;
	generatedAt: number;
}

/**
 * Type guard to check if payload is frontend
 */
export function isFrontendPayload(payload: SmartArchPayload): payload is FrontendArchPayload {
	return payload.type === 'frontend';
}

/**
 * Type guard to check if payload is backend
 */
export function isBackendPayload(payload: SmartArchPayload): payload is BackendArchPayload {
	return payload.type === 'backend';
}

/**
 * Type guard to check if payload is fullstack
 */
export function isFullstackPayload(payload: SmartArchPayload): payload is FullstackArchPayload {
	return payload.type === 'fullstack';
}

/**
 * Get nodes from any SmartArchPayload
 */
export function getPayloadNodes(payload: SmartArchPayload): ArchNode[] {
	if (isFullstackPayload(payload)) {
		return [...payload.frontend.nodes, ...payload.backend.nodes, ...payload.sharedPackages];
	}
	return payload.nodes;
}

/**
 * Get edges from any SmartArchPayload
 */
export function getPayloadEdges(payload: SmartArchPayload): ArchEdge[] {
	if (isFullstackPayload(payload)) {
		return [...payload.frontend.edges, ...payload.backend.edges];
	}
	return payload.edges;
}
