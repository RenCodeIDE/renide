/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRenViewManager } from '../../../renViews/browser/managers/renViewManager.js';
import { GraphView } from '../../../renViews/browser/views/graphView/graphView.js';
import { GraphMode } from '../../../renViews/browser/views/graphView/graphTypes.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const GraphControlToolId = 'vscode_graphControl';

export const GraphControlToolData: IToolData = {
	id: GraphControlToolId,
	toolReferenceName: 'graphControl',
	displayName: localize('graphControlTool.displayName', 'Graph Control'),
	modelDescription: localize('graphControlTool.modelDescription', 'Controls the graph view to display different types of visualizations. Can change graph type (file dependencies, folder structure, workspace overview, git heatmap, data flow analysis, evolution timeline, or change impact) and optionally specify a target file or folder to visualize. Automatically switches to graph view if not already active.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	tags: ['ask-mode'],
	when: ContextKeyExpr.equals('chatAgentKind', 'ask'),
	inputSchema: {
		type: 'object',
		properties: {
			graphType: {
				type: 'string',
				enum: ['file', 'folder', 'workspace', 'architecture', 'gitHeatmap', 'dataFlow', 'evolution', 'changeImpact'],
				description: localize('graphControlTool.graphType', 'The type of graph to display: "file" for file dependencies, "folder" for folder dependencies, "workspace" for workspace overview, "gitHeatmap" for git commit coupling, "dataFlow" for function call flow, "evolution" for timeline view, "changeImpact" for change impact analysis')
			},
			targetPath: {
				type: 'string',
				description: localize('graphControlTool.targetPath', 'Optional: The file or folder path to visualize. Required for "file" and "folder" modes. Can be absolute or workspace-relative path.')
			}
		},
		required: [],
		additionalProperties: false
	},
	// Smart default: default to workspace overview, use active file as target
	resolveDefaults: (ctx) => {
		const defaults: Partial<Record<string, unknown>> = {};
		// Default to workspace overview (most useful general view)
		defaults.graphType = 'workspace';
		// If user has a file open, use that as target for file/folder modes
		if (ctx.activeFile) {
			defaults.targetPath = ctx.activeFile.fsPath;
		}
		return defaults;
	}
};

export interface IGraphControlToolParams {
	graphType?: GraphMode;
	targetPath?: string;
}

export class GraphControlTool implements IToolImpl {
	constructor(
		@IRenViewManager private readonly renViewManager: IRenViewManager,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IGraphControlToolParams;
		
		const graphType = parameters.graphType || 'workspace';
		const graphTypeLabel = this.getGraphTypeLabel(graphType);
		const targetInfo = parameters.targetPath ? ` for ${parameters.targetPath}` : '';

		return {
			invocationMessage: localize('graphControlTool.invocationMessage', 'Loading {0}{1}...', graphTypeLabel, targetInfo),
			pastTenseMessage: localize('graphControlTool.pastTenseMessage', 'Loaded {0}{1}', graphTypeLabel, targetInfo),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IGraphControlToolParams;
		console.log('[GraphControlTool] invoke called with args:', JSON.stringify(args));

		// Default to workspace if not provided and normalize
		const graphType = (args.graphType || 'workspace').trim().toLowerCase() as GraphMode;

		// Validate graph type
		const validGraphTypes: GraphMode[] = ['file', 'folder', 'workspace', 'architecture', 'gitHeatmap', 'dataFlow', 'evolution', 'changeImpact'];
		if (!validGraphTypes.includes(graphType)) {
			return {
				content: [{
					kind: 'text',
					value: localize('graphControlTool.invalidType', 'Invalid graph type "{0}". Must be one of: {1}', graphType, validGraphTypes.join(', '))
				}],
				toolResultMessage: localize('graphControlTool.error', 'Failed to control graph: invalid type "{0}". Must be one of: {1}', graphType, validGraphTypes.join(', '))
			};
		}

		// Check if target path is required but missing
		if ((graphType === 'file' || graphType === 'folder') && !args.targetPath) {
			return {
				content: [{
					kind: 'text',
					value: localize('graphControlTool.missingTarget', 'Graph type "{0}" requires a targetPath parameter', graphType)
				}],
				toolResultMessage: localize('graphControlTool.error', 'Failed to control graph: missing target path')
			};
		}

		try {
			// Ensure we're in graph view
			const currentView = this.renViewManager.getCurrentView();
			if (currentView !== 'graph') {
				this.renViewManager.switchToView('graph');
			}

			// Get the graph view instance
			const graphView = this.renViewManager.getGraphView();
			if (!graphView) {
				return {
					content: [{
						kind: 'text',
						value: localize('graphControlTool.noGraphView', 'Graph view is not available')
					}],
					toolResultMessage: localize('graphControlTool.error', 'Graph view not available')
				};
			}

			// Parse target path if provided
			let targetUri: URI | undefined;
			if (args.targetPath) {
				targetUri = this.parseTargetPath(args.targetPath);
			}

			// Use the programmatic APIs to render the graph directly
			// This bypasses file pickers and renders immediately
			await this.triggerRender(graphView, graphType, targetUri);

			const graphTypeLabel = this.getGraphTypeLabel(graphType);
			const targetInfo = args.targetPath ? ` for ${args.targetPath}` : '';
			const message = localize('graphControlTool.success', 'Graph view showing {0}{1}', graphTypeLabel, targetInfo);

			return {
				content: [{
					kind: 'text',
					value: message
				}],
				toolResultMessage: message
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('graphControlTool.error', 'Error controlling graph: {0}', errorMessage)
				}],
				toolResultMessage: localize('graphControlTool.error', 'Error controlling graph: {0}', errorMessage)
			};
		}
	}


	private parseTargetPath(path: string): URI {
		// Check if it's already a URI
		if (path.includes('://') || path.startsWith('file://')) {
			return URI.parse(path);
		}

		// Check if it's an absolute path
		if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
			return URI.file(path);
		}

		// Treat as workspace-relative path
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length > 0) {
			return URI.joinPath(workspace.folders[0].uri, path);
		}

		// Fallback to file URI
		return URI.file(path);
	}

	private async triggerRender(graphView: GraphView, graphType: GraphMode, targetUri?: URI): Promise<void> {
		// Use the public programmatic APIs to render graphs directly
		// This bypasses file pickers and renders immediately
		switch (graphType) {
			case 'file':
				if (targetUri) {
					await graphView.renderFileGraphProgrammatically(targetUri);
				}
				break;
			case 'folder':
				if (targetUri) {
					await graphView.renderFolderGraphProgrammatically(targetUri);
				}
				break;
			case 'workspace':
				await graphView.renderWorkspaceGraphProgrammatically();
				break;
			case 'gitHeatmap':
				await graphView.renderGitHeatmapProgrammatically();
				break;
			case 'architecture':
				await graphView.renderArchitectureGraphProgrammatically();
				break;
			case 'dataFlow':
			case 'evolution':
			case 'changeImpact':
				// These modes require additional user input (function selection, etc.)
				// Just set the mode without triggering a render
				graphView.setModeProgrammatically(graphType);
				break;
		}
	}

	private getGraphTypeLabel(graphType: GraphMode): string {
		switch (graphType) {
			case 'file':
				return localize('graphControlTool.fileGraph', 'File Dependency Graph');
			case 'folder':
				return localize('graphControlTool.folderGraph', 'Folder Dependency Graph');
			case 'workspace':
				return localize('graphControlTool.workspaceGraph', 'Workspace Overview Graph');
			case 'gitHeatmap':
				return localize('graphControlTool.gitHeatmap', 'Git Commit Coupling Heatmap');
			case 'dataFlow':
				return localize('graphControlTool.dataFlow', 'Data Flow Graph');
			case 'architecture':
				return localize('graphControlTool.architecture', 'Architecture Analysis');
			case 'evolution':
				return localize('graphControlTool.evolution', 'Evolution Timeline');
			case 'changeImpact':
				return localize('graphControlTool.changeImpact', 'Change Impact Analysis');
			default:
				return graphType;
		}
	}
}
