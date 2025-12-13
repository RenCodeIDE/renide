/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolInvocationPresentation, ToolProgress } from '../languageModelToolsService.js';

export const AskConfirmationToolId = 'vscode_askConfirmation';

export const AskConfirmationToolData: IToolData = {
	id: AskConfirmationToolId,
	toolReferenceName: 'askConfirmation',
	displayName: localize('askConfirmationTool.displayName', 'Ask Confirmation'),
	modelDescription: localize('askConfirmationTool.modelDescription', 'Asks the user for confirmation about their understanding via a chat popup. Use this to check if the user understood your explanation or to give them options to continue. The user will see clickable buttons in the chat to respond.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			question: {
				type: 'string',
				description: localize('askConfirmationTool.question', 'The question to ask the user. Should be clear and concise.')
			},
			options: {
				type: 'array',
				items: {
					type: 'string'
				},
				description: localize('askConfirmationTool.options', 'Optional: Array of response options for the user. Default: ["Yes, I understand", "No, explain more"]')
			}
		},
		required: ['question'],
		additionalProperties: false
	}
};

export interface IAskConfirmationToolParams {
	question: string;
	options?: string[];
}

export class AskConfirmationTool implements IToolImpl {
	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IAskConfirmationToolParams;

		if (!parameters.question) {
			throw new Error('Question is required for AskConfirmationTool');
		}

		// Use default options if not provided
		const options = parameters.options && parameters.options.length > 0
			? parameters.options
			: [
				localize('askConfirmationTool.defaultYes', 'Yes, I understand'),
				localize('askConfirmationTool.defaultNo', 'No, explain more')
			];

		// Create the confirmation message
		const title = parameters.question;
		
		// Create tool actions for each option
		// We use terminalCustomActions to pass these buttons to the UI
		const customActions = options.map(option => ({
			label: option,
			data: option
		}));

		// We don't need markdown list anymore as we have real buttons
		// Just show the question
		const message = new MarkdownString(parameters.question);

		return {
			confirmationMessages: {
				title,
				message,
				allowAutoConfirm: false, // Always require user interaction
				terminalCustomActions: customActions // These will be rendered as primary buttons
			},
			presentation: ToolInvocationPresentation.HiddenAfterComplete
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		// Get the user's response from toolSpecificData
		let answer = 'User confirmed execution but no specific option was selected.';
		
		if (invocation.toolSpecificData?.kind === 'input' && invocation.toolSpecificData.rawInput?.answer) {
			answer = invocation.toolSpecificData.rawInput.answer;
		}

		return {
			content: [{
				kind: 'text',
				value: answer
			}],
			toolResultMessage: localize('askConfirmationTool.answered', 'User answered: {0}', answer)
		};
	}
}
