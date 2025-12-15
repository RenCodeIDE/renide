/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { ContextKeyExpr } from "../../../../../platform/contextkey/common/contextkey.js";
import { localize } from "../../../../../nls.js";
import { IRenViewManager } from "../../../renViews/browser/managers/renViewManager.js";
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from "../languageModelToolsService.js";

export const SwitchViewToolId = "vscode_switchView";

export const SwitchViewToolData: IToolData = {
	id: SwitchViewToolId,
	toolReferenceName: "switchView",
	displayName: localize("switchViewTool.displayName", "Switch View"),
	modelDescription: localize(
		"switchViewTool.modelDescription",
		"Switches the IDE view between code view and graph view. When switching to graph view, you can optionally specify a targetPath and targetType to show the dependency graph for a specific file, folder, or the entire workspace. Use this when explaining code architecture or showing the user how files relate to each other."
	),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	tags: ["ask-mode"],
	when: ContextKeyExpr.equals("chatAgentKind", "ask"),
	inputSchema: {
		type: "object",
		properties: {
			viewMode: {
				type: "string",
				enum: ["code", "graph"],
				description: localize(
					"switchViewTool.viewMode",
					"Optional: The view mode to switch to. If omitted, toggles between code and graph view."
				),
			},
			targetPath: {
				type: "string",
				description: localize(
					"switchViewTool.targetPath",
					"Required when viewMode is \"graph\": The absolute path to the file or folder to show in the graph view."
				),
			},
			targetType: {
				type: "string",
				enum: ["file", "folder", "workspace"],
				description: localize(
					"switchViewTool.targetType",
					"Required when viewMode is \"graph\": The type of target - \"file\" for a single file's dependencies, \"folder\" for a folder's structure, or \"workspace\" for the entire workspace."
				),
			},
		},
		additionalProperties: false,
	},
};

export interface ISwitchViewToolParams {
	viewMode?: "code" | "graph";
	targetPath?: string;
	targetType?: "file" | "folder" | "workspace";
}

export class SwitchViewTool implements IToolImpl {
	constructor(
		@IRenViewManager private readonly renViewManager: IRenViewManager
	) { }

	async prepareToolInvocation(
		context: IToolInvocationPreparationContext,
		token: CancellationToken
	): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as ISwitchViewToolParams;

		let targetView = parameters.viewMode;
		if (!targetView) {
			const currentView = this.renViewManager.getCurrentView();
			targetView = currentView === "code" ? "graph" : "code";
		}

		const viewLabel =
			targetView === "code"
				? localize("switchViewTool.codeView", "Code View")
				: localize("switchViewTool.graphView", "Graph View");

		return {
			invocationMessage: localize(
				"switchViewTool.invocationMessage",
				"Switching to {0}...",
				viewLabel
			),
			pastTenseMessage: localize(
				"switchViewTool.pastTenseMessage",
				"Switched to {0}",
				viewLabel
			),
		};
	}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		token: CancellationToken
	): Promise<IToolResult> {
		const args = invocation.parameters as ISwitchViewToolParams;

		// Normalize and validate
		const inputMode = args.viewMode?.trim().toLowerCase();
		let viewMode =
			inputMode === "code" || inputMode === "graph" ? inputMode : undefined;

		// If no valid mode provided, toggle based on current view
		if (!viewMode) {
			const currentView = this.renViewManager.getCurrentView();
			viewMode = currentView === "code" ? "graph" : "code";
		}

		if (viewMode !== "code" && viewMode !== "graph") {
			return {
				content: [
					{
						kind: "text",
						value: localize(
							"switchViewTool.invalidMode",
							'Invalid view mode. Must be "code" or "graph".'
						),
					},
				],
				toolResultMessage: localize(
					"switchViewTool.error",
					"Failed to switch view: invalid mode. Received: {0}",
					JSON.stringify(args)
				),
			};
		}

		try {
			// Switch to the requested view, passing target options for graph view
			if (viewMode === "graph" && args.targetPath && args.targetType) {
				this.renViewManager.switchToView(viewMode, {
					targetPath: args.targetPath,
					targetType: args.targetType,
				});
			} else {
				this.renViewManager.switchToView(viewMode);
			}

			const viewLabel =
				viewMode === "code"
					? localize("switchViewTool.codeView", "Code View")
					: localize("switchViewTool.graphView", "Graph View");

			// Build success message with target info if applicable
			let message: string;
			if (viewMode === "graph" && args.targetPath) {
				message = localize(
					"switchViewTool.successWithTarget",
					"Switched to {0} showing {1}: {2}",
					viewLabel,
					args.targetType || "target",
					args.targetPath
				);
			} else {
				message = localize("switchViewTool.success", "Switched to {0}", viewLabel);
			}

			return {
				content: [
					{
						kind: "text",
						value: message,
					},
				],
				toolResultMessage: message,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				content: [
					{
						kind: "text",
						value: localize(
							"switchViewTool.error",
							"Error switching view: {0}",
							errorMessage
						),
					},
				],
				toolResultMessage: localize(
					"switchViewTool.error",
					"Error switching view: {0}",
					errorMessage
				),
			};
		}
	}
}
