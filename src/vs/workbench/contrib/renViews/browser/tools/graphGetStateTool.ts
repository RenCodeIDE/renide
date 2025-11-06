/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { localize } from "../../../../../nls.js";
import {
	CountTokensCallback,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from "../../../chat/common/languageModelToolsService.js";
import { IGraphService } from "../services/graphService.js";

export class GraphGetStateTool implements IToolImpl {
	static readonly ID = "graph.getState";
	static readonly DEFINITION: IToolData = {
		id: GraphGetStateTool.ID,
		toolReferenceName: "graph.getState",
		displayName: localize("graphGetStateTool.displayName", "Get Graph State"),
		modelDescription: localize(
			"graphGetStateTool.modelDescription",
			"Returns the current state of the graph view including all nodes, edges, and metadata. Use this to understand the codebase structure visualized in the graph."
		),
		userDescription: localize(
			"graphGetStateTool.userDescription",
			"Get current graph state"
		),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: "object",
			properties: {},
		},
		canBeReferencedInPrompt: true,
	};

	constructor(@IGraphService private readonly graphService: IGraphService) {}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		_token: CancellationToken
	): Promise<IToolResult> {
		try {
			const state = this.graphService.getCurrentGraphState();

			if (!state) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"graphGetStateTool.noGraph",
								"No graph is currently loaded. Please generate a graph first using the graph view."
							),
						},
					],
				};
			}

			// Format state for agent consumption
			const summary = [
				`Graph Mode: ${state.mode || "unknown"}`,
				`Nodes: ${state.nodes.length}`,
				`Edges: ${state.edges.length}`,
				...(state.summary || []),
			].join("\n");

			// Create a map of node IDs to labels for quick lookup
			const nodeLabelMap = new Map<string, string>();
			state.nodes.forEach((node) => {
				nodeLabelMap.set(node.id, node.label);
			});

			// Helper to get a short readable path from a full path
			const getShortPath = (path: string): string => {
				// If it's an absolute path, try to extract just the filename or relative portion
				if (path.includes("/")) {
					const parts = path.split("/");
					// If it's a very long path, just show last 2-3 parts
					if (parts.length > 3) {
						return parts.slice(-2).join("/");
					}
					return path;
				}
				return path;
			};

			// Create lightweight summaries with concise descriptions
			const nodesList = state.nodes.map((node) => {
				const shortPath = getShortPath(node.path);
				const description = node.category
					? `${node.kind} '${node.label}'${
							shortPath ? ` (${shortPath})` : ""
					  } [${node.category}]`
					: `${node.kind} '${node.label}'${shortPath ? ` (${shortPath})` : ""}`;

				return {
					label: node.label,
					kind: node.kind,
					path: shortPath,
					fanIn: node.fanIn,
					fanOut: node.fanOut,
					description: description,
				};
			});

			const edgesList = state.edges.map((edge) => {
				// Resolve source and target IDs to their labels
				const sourceLabel = nodeLabelMap.get(edge.source) || edge.source;
				const targetLabel = nodeLabelMap.get(edge.target) || edge.target;

				const description = edge.category
					? `${edge.kind}: ${sourceLabel} → ${targetLabel} [${edge.category}]`
					: `${edge.kind}: ${sourceLabel} → ${targetLabel}`;

				return {
					source: sourceLabel,
					target: targetLabel,
					kind: edge.kind,
					label: edge.label || "",
					description: description,
				};
			});

			// Format output concisely (no pretty-printing to reduce token count)
			return {
				content: [
					{
						kind: "text",
						value: `${summary}\n\nNodes (${nodesList.length}):\n${nodesList
							.map((n) => `  ${n.description}`)
							.join("\n")}\n\nEdges (${edgesList.length}):\n${edgesList
							.map((e) => `  ${e.description}`)
							.join(
								"\n"
							)}\n\nNote: Use node labels (e.g., 'index.ts') or label+path from above to select nodes with graph_selectNodes.`,
					},
				],
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				content: [
					{
						kind: "text",
						value: localize(
							"graphGetStateTool.error",
							"Failed to get graph state: {0}",
							errorMessage
						),
					},
				],
				toolResultError: errorMessage,
			};
		}
	}
}
