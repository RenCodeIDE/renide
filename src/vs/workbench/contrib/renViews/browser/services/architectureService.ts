/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";

export const IArchitectureService = createDecorator<IArchitectureService>("ren.architectureService");

// ============================================================================
// Comprehensive Architecture Node Types
// ============================================================================

/**
 * Frontend component types
 */
export type FrontendNodeType =
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
 * Backend component types
 */
export type BackendNodeType =
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
 * Shared component types
 */
export type SharedNodeType =
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
 * All architecture node types
 */
export type ArchNodeType = FrontendNodeType | BackendNodeType | SharedNodeType;

// ============================================================================
// Architecture Layers
// ============================================================================

/**
 * Frontend layers for visualization
 */
export type FrontendLayer =
	| 'pages'             // Page components
	| 'layouts'           // Layout components
	| 'features'          // Feature modules
	| 'components'        // Reusable components
	| 'hooks'             // Custom hooks
	| 'state'             // State management
	| 'routing'           // Routing configuration
	| 'api-client';       // API client layer

/**
 * Backend layers for visualization
 */
export type BackendLayer =
	| 'routes'            // Route definitions
	| 'controllers'       // Controllers
	| 'resolvers'         // GraphQL resolvers
	| 'services'          // Business logic
	| 'repositories'      // Data access
	| 'models'            // Data models
	| 'middleware'        // Middleware
	| 'infrastructure'    // Infrastructure (queues, cron, etc.)
	| 'jobs';             // Background jobs

/**
 * Shared layers
 */
export type SharedLayer =
	| 'shared'            // Shared utilities
	| 'config'            // Configuration
	| 'types'             // Type definitions
	| 'external'          // External dependencies
	| 'tests';            // Test files

/**
 * All architecture layers
 */
export type ArchLayer = FrontendLayer | BackendLayer | SharedLayer;

// ============================================================================
// Edge Types
// ============================================================================

/**
 * Types of relationships between architecture nodes
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

// ============================================================================
// Architecture Analysis Types
// ============================================================================

/**
 * A layer container in the architecture visualization
 */
export interface ArchitectureLayer {
	id: string;                    // Unique layer ID (e.g., 'pages', 'components')
	label: string;                 // Display label (e.g., 'Pages', 'Components')
	order: number;                 // Vertical position (0 = top)
	color: string;                 // Container background color
	borderColor: string;           // Container border color
	nodeCount: number;             // Number of nodes in this layer
}

/**
 * A node in the architecture graph
 */
export interface ArchitectureNode {
	id: string;                    // Unique node ID
	type: ArchNodeType;            // Node type from comprehensive types
	label: string;                 // Full name (e.g., 'Button.tsx')
	conciseLabel: string;          // Short name for display (e.g., 'Button')
	layerId: string;               // Which layer container this belongs to
	filePath: string;              // Full file path
	description?: string;          // AI-generated description
	metadata: {
		imports: string[];         // Files this node imports
		exports: string[];         // Exported symbols
		dependencies: string[];    // External package dependencies
		linesOfCode?: number;      // File size
		// Frontend-specific
		props?: string[];          // Component props
		hooks?: string[];          // React hooks used
		stateConnections?: string[]; // State stores used
		isRootComponent?: boolean; // Is this the root component?
		// Backend-specific
		httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		routePath?: string;        // API route path
		middlewares?: string[];    // Applied middleware
	};
}

/**
 * An edge connecting two nodes in the architecture graph
 */
export interface ArchitectureEdge {
	id: string;                    // Unique edge ID
	source: string;                // Source node ID
	target: string;                // Target node ID
	type: ArchEdgeType;            // Edge type
	label?: string;                // Optional edge label
	animated?: boolean;            // Whether to animate the edge
}

/**
 * Codebase type classification
 */
export type CodebaseType = 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli' | 'monorepo' | 'unknown';

/**
 * Complete architecture analysis result
 */
export interface ArchitectureAnalysis {
	workspaceUri: URI;             // Workspace URI
	merkleRootHash: string;        // Merkle tree root hash for cache validation
	codebaseType: CodebaseType;    // Detected codebase type
	primaryFramework?: string;     // Primary framework (React, Next.js, Express, etc.)
	layers: ArchitectureLayer[];   // Layer containers
	nodes: ArchitectureNode[];     // All nodes
	edges: ArchitectureEdge[];     // All edges
	summary: string[];             // AI-generated summary points
	recommendations?: string[];    // Architecture recommendations
	generatedAt: number;           // Timestamp
	aiGenerated: boolean;          // Whether AI was used for analysis
	analysisVersion: string;       // Version for cache compatibility
}

/**
 * Progress update during analysis
 */
export interface ArchitectureProgress {
	message: string;               // Progress message
	progress: number;              // 0-100 percentage
	phase: 'collecting' | 'analyzing' | 'building' | 'complete' | 'error';
}

/**
 * Cached architecture analysis
 */
export interface CachedArchitectureAnalysis {
	analysis: ArchitectureAnalysis;
	merkleRootHash: string;
	timestamp: number;
	ttl: number;                   // Time-to-live in milliseconds
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Architecture analysis service interface
 */
export interface IArchitectureService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when architecture analysis is updated
	 */
	readonly onDidUpdateAnalysis: Event<ArchitectureAnalysis>;

	/**
	 * Fired during analysis progress
	 */
	readonly onAnalysisProgress: Event<ArchitectureProgress>;

	/**
	 * Get the current cached architecture analysis
	 * Returns undefined if no analysis is available
	 */
	getArchitectureAnalysis(): ArchitectureAnalysis | undefined;

	/**
	 * Analyze the workspace architecture
	 * @param mode - Analysis mode: 'auto' detects type, or force specific type
	 * @returns Promise resolving to the analysis result
	 */
	analyzeWorkspace(mode?: 'auto' | 'frontend' | 'backend' | 'fullstack'): Promise<ArchitectureAnalysis>;

	/**
	 * Invalidate the cached analysis
	 * Forces re-analysis on next request
	 */
	invalidateCache(): Promise<void>;

	/**
	 * Check if analysis is currently in progress
	 */
	isAnalyzing(): boolean;

	/**
	 * Get analysis for a specific file
	 * @param uri - File URI
	 * @returns The node for this file, if found
	 */
	getNodeForFile(uri: URI): ArchitectureNode | undefined;

	/**
	 * Get all nodes in a specific layer
	 * @param layerId - Layer ID
	 * @returns Array of nodes in the layer
	 */
	getNodesInLayer(layerId: string): ArchitectureNode[];

	/**
	 * Get edges connected to a specific node
	 * @param nodeId - Node ID
	 * @returns Object with incoming and outgoing edges
	 */
	getEdgesForNode(nodeId: string): { incoming: ArchitectureEdge[]; outgoing: ArchitectureEdge[] };
}


