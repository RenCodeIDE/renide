/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import {
	GraphMode,
	GraphNodePayload,
	GraphEdgePayload,
} from "../views/graphView/graphTypes.js";
import { IRenViewManager } from "../managers/renViewManager.js";

export const IGraphService = createDecorator<IGraphService>("IGraphService");

export interface GraphState {
	mode?: GraphMode;
	nodes: GraphNodePayload[];
	edges: GraphEdgePayload[];
	summary?: string[];
	metadata?: Record<string, unknown>;
	generatedAt?: number;
}

export interface IGraphService {
	readonly _serviceBrand: undefined;
	getCurrentGraphState(): GraphState | null;
	selectNodes(nodeIds: string[]): Promise<void>;
	clearSelection(): Promise<void>;
}

export class GraphService implements IGraphService {
	readonly _serviceBrand: undefined;

	constructor(
		@IRenViewManager private readonly renViewManager: IRenViewManager
	) {}

	getCurrentGraphState(): GraphState | null {
		const graphView = this.renViewManager.getGraphView();
		return graphView?.getCurrentGraphState() ?? null;
	}

	async selectNodes(nodeIds: string[]): Promise<void> {
		const graphView = this.renViewManager.getGraphView();
		if (graphView) {
			await graphView.selectNodes(nodeIds);
		}
	}

	async clearSelection(): Promise<void> {
		const graphView = this.renViewManager.getGraphView();
		if (graphView) {
			await graphView.clearSelection();
		}
	}
}
