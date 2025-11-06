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

export type GraphMode = 'file' | 'folder' | 'workspace' | 'architecture' | 'gitHeatmap' | 'dataFlow';

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

