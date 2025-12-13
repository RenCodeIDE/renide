/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const CloseDocsToolId = 'vscode_closeDocs';
const DOCS_VIEW_ID = 'workbench.view.renDocs.main';

export const CloseDocsToolData: IToolData = {
	id: CloseDocsToolId,
	toolReferenceName: 'closeDocs',
	displayName: localize('closeDocsTool.displayName', 'Close Documentation'),
	modelDescription: localize('closeDocsTool.modelDescription', 'Closes the documentation panel if it is open. Use this to clean up the workspace after showing documentation.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false
	}
};

export class CloseDocsTool implements IToolImpl {
	constructor(
		@IViewsService private readonly viewsService: IViewsService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('closeDocsTool.invocationMessage', 'Closing documentation panel...'),
			pastTenseMessage: localize('closeDocsTool.pastTenseMessage', 'Closed documentation panel'),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			// Close the docs view
			await this.viewsService.closeView(DOCS_VIEW_ID);

			const message = localize('closeDocsTool.success', 'Documentation panel closed');

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
					value: localize('closeDocsTool.error', 'Error closing documentation: {0}', errorMessage)
				}],
				toolResultMessage: localize('closeDocsTool.error', 'Error closing documentation: {0}', errorMessage)
			};
		}
	}
}
