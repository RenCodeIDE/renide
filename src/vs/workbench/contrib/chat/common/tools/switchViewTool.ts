/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IRenViewManager } from '../../../renViews/browser/managers/renViewManager.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const SwitchViewToolId = 'vscode_switchView';

export const SwitchViewToolData: IToolData = {
	id: SwitchViewToolId,
	toolReferenceName: 'switchView',
	displayName: localize('switchViewTool.displayName', 'Switch View'),
	modelDescription: localize('switchViewTool.modelDescription', 'Switches the IDE view between code view (for showing code files) and graph view (for showing dependency graphs and visualizations). Use this when you want to show the user different types of information - code in code view, visualizations in graph view.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			viewMode: {
				type: 'string',
				enum: ['code', 'graph'],
				description: localize('switchViewTool.viewMode', 'Optional: The view mode to switch to. If omitted, toggles between code and graph view.')
			}
		},
		additionalProperties: false
	}
};

export interface ISwitchViewToolParams {
	viewMode?: 'code' | 'graph';
}

export class SwitchViewTool implements IToolImpl {
	constructor(
		@IRenViewManager private readonly renViewManager: IRenViewManager
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as ISwitchViewToolParams;
		
		let targetView = parameters.viewMode;
		if (!targetView) {
			const currentView = this.renViewManager.getCurrentView();
			targetView = currentView === 'code' ? 'graph' : 'code';
		}

		const viewLabel = targetView === 'code' 
			? localize('switchViewTool.codeView', 'Code View')
			: localize('switchViewTool.graphView', 'Graph View');

		return {
			invocationMessage: localize('switchViewTool.invocationMessage', 'Switching to {0}...', viewLabel),
			pastTenseMessage: localize('switchViewTool.pastTenseMessage', 'Switched to {0}', viewLabel),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ISwitchViewToolParams;
		console.log('[SwitchViewTool] invoke called with args:', JSON.stringify(args));

		let viewMode = args.viewMode?.toLowerCase?.() as 'code' | 'graph' | undefined;
		
		// If no mode provided, toggle based on current view
		if (!viewMode) {
			const currentView = this.renViewManager.getCurrentView();
			viewMode = currentView === 'code' ? 'graph' : 'code';
			console.log('[SwitchViewTool] No mode provided, toggling from', currentView, 'to', viewMode);
		}

		if (viewMode !== 'code' && viewMode !== 'graph') {
			return {
				content: [{
					kind: 'text',
					value: localize('switchViewTool.invalidMode', 'Invalid view mode. Must be "code" or "graph".')
				}],
				toolResultMessage: localize('switchViewTool.error', 'Failed to switch view: invalid mode. Received: {0}', JSON.stringify(args))
			};
		}

		try {
			// Switch to the requested view
			this.renViewManager.switchToView(viewMode);
			
			const viewLabel = viewMode === 'code' 
				? localize('switchViewTool.codeView', 'Code View')
				: localize('switchViewTool.graphView', 'Graph View');

			// Even if already in view, we return success so the model knows it's in the correct state
			const message = localize('switchViewTool.success', 'Switched to {0}', viewLabel);

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
					value: localize('switchViewTool.error', 'Error switching view: {0}', errorMessage)
				}],
				toolResultMessage: localize('switchViewTool.error', 'Error switching view: {0}', errorMessage)
			};
		}
	}
}
