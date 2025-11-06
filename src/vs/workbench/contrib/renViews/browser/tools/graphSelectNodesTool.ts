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

export class GraphSelectNodesTool implements IToolImpl {
	static readonly ID = "graph.selectNodes";
	static readonly DEFINITION: IToolData = {
		id: GraphSelectNodesTool.ID,
		toolReferenceName: "graph.selectNodes",
		displayName: localize(
			"graphSelectNodesTool.displayName",
			"Select Graph Nodes"
		),
		modelDescription: localize(
			"graphSelectNodesTool.modelDescription",
			"Selects and highlights specific nodes in the graph by their labels or label+path combination from graph_getState output. Use this to draw attention to specific parts of the codebase structure. The nodes will be highlighted and their connections shown."
		),
		userDescription: localize(
			"graphSelectNodesTool.userDescription",
			"Select nodes in graph"
		),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: "object",
			required: ["selectors"],
			properties: {
				selectors: {
					type: "array",
					items: {
						oneOf: [
							{ type: "string" },
							{
								type: "object",
								properties: {
									label: { type: "string" },
									path: { type: "string" },
								},
								required: ["label"],
							},
						],
					},
					description: localize(
						"graphSelectNodesTool.selectors",
						"Array of node selectors. Can be node labels (e.g., 'index.ts') or objects with label and optional path from graph_getState output."
					),
				},
				clearPrevious: {
					type: "boolean",
					description: localize(
						"graphSelectNodesTool.clearPrevious",
						"Whether to clear previous selection before selecting new nodes. Default: true"
					),
				},
			},
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
			const params = invocation.parameters as {
				selectors?: Array<string | { label: string; path?: string }>;
				clearPrevious?: boolean;
			};

			const selectors = Array.isArray(params?.selectors)
				? params.selectors
				: [];

			if (selectors.length === 0) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"graphSelectNodesTool.noSelectors",
								"No node selectors provided. Please provide at least one node label or selector from graph_getState output."
							),
						},
					],
					toolResultError: localize(
						"graphSelectNodesTool.noSelectors.error",
						"Missing required parameter: selectors"
					),
				};
			}

			// Get current graph state to resolve selectors to node IDs
			const graphState = this.graphService.getCurrentGraphState();
			if (!graphState) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"graphSelectNodesTool.noGraph",
								"No graph is currently loaded. Please generate a graph first."
							),
						},
					],
					toolResultError: "No graph state available",
				};
			}

			// Resolve selectors to node IDs
			const nodeIds: string[] = [];
			const resolvedNodes: string[] = [];
			const notFound: string[] = [];

			for (const selector of selectors) {
				let label: string;
				let path: string | undefined;

				if (typeof selector === "string") {
					label = selector;
				} else {
					label = selector.label;
					path = selector.path;
				}

				// Find matching node
				const matchingNode = graphState.nodes.find((node) => {
					const labelMatch = node.label === label;
					if (!path) {
						return labelMatch;
					}
					// Match path (handle both full and short paths)
					const nodePath = node.path;
					const pathMatch =
						nodePath === path ||
						nodePath.endsWith(path) ||
						nodePath.includes(path);
					return labelMatch && pathMatch;
				});

				if (matchingNode) {
					nodeIds.push(matchingNode.id);
					resolvedNodes.push(
						`${label}${path ? ` (${path})` : ""}`
					);
				} else {
					notFound.push(`${label}${path ? ` (${path})` : ""}`);
				}
			}

			if (nodeIds.length === 0) {
				return {
					content: [
						{
							kind: "text",
							value: `Could not find any matching nodes. Not found: ${notFound.join(", ")}. Available nodes have labels like those shown in graph_getState output.`,
						},
					],
					toolResultError: `No matching nodes found: ${notFound.join(", ")}`,
				};
			}

			const clearPrevious = params?.clearPrevious !== false;
			if (clearPrevious) {
				await this.graphService.clearSelection();
			}

			await this.graphService.selectNodes(nodeIds);

			const message =
				notFound.length > 0
					? `Selected ${nodeIds.length} node(s): ${resolvedNodes.join(", ")}. Could not find: ${notFound.join(", ")}.`
					: `Selected ${nodeIds.length} node(s): ${resolvedNodes.join(", ")}.`;

			return {
				content: [
					{
						kind: "text",
						value: localize(
							"graphSelectNodesTool.success",
							message
						),
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
							"graphSelectNodesTool.error",
							"Failed to select nodes: {0}",
							errorMessage
						),
					},
				],
				toolResultError: errorMessage,
			};
		}
	}
}
