/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';

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

export interface GraphWebviewPayload {
	nodes: GraphNodePayload[];
	edges: GraphEdgePayload[];
	mode?: GraphMode;
	summary?: string[];
	warnings?: string[];
	generatedAt?: number;
	metadata?: Record<string, unknown>;
}

export interface ImportDescriptor {
	specifier: string;
	defaultImport?: { name: string; isTypeOnly: boolean };
	namespaceImport?: { name: string; isTypeOnly: boolean };
	namedImports: Array<{ name: string; propertyName?: string; isTypeOnly: boolean }>;
	isSideEffectOnly: boolean;
}

export type GraphMode = 'file' | 'folder' | 'workspace' | 'architecture';

export type GraphStatusLevel = 'info' | 'warning' | 'error' | 'loading' | 'success';

export interface GraphScopeOptions {
	scopeRoots: Set<string>;
	scopeMode: GraphMode;
}

export interface GraphBuildContext {
	initialFiles: URI[];
	options: GraphScopeOptions;
}

