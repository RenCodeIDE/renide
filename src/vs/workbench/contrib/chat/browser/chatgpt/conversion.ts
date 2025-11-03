/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage, IChatMessagePart, ChatMessageRole } from '../../common/languageModels.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import type { OpenAIMessage } from './types.js';

/**
 * Converts messages from OpenAI format to IDE format.
 */
export function convertOpenAIMessagesToIDE(messages: OpenAIMessage[], logService: ILogService): IChatMessage[] {
	logService.debug(
		`[chatgpt-server] Converting ${messages.length} messages from OpenAI format to IDE format`,
	);

	const ideMessages: IChatMessage[] = [];
	for (const msg of messages) {
		let role: ChatMessageRole;
		switch (msg.role) {
			case 'system':
				role = ChatMessageRole.System;
				break;
			case 'user':
				role = ChatMessageRole.User;
				break;
			case 'assistant':
				role = ChatMessageRole.Assistant;
				break;
			case 'tool':
				continue;
			default:
				continue;
		}

		const content: IChatMessagePart[] = [];

		if (msg.content !== null && msg.content !== undefined && msg.content.trim().length > 0) {
			content.push({ type: 'text', value: msg.content });
		}

		if (msg.tool_calls && msg.tool_calls.length > 0) {
			logService.debug(
				`[chatgpt-server] Converting ${msg.tool_calls.length} tool_calls to tool_use parts for role=${msg.role}`,
			);
			for (const toolCall of msg.tool_calls) {
				try {
					const args = JSON.parse(toolCall.function.arguments || '{}');
					content.push({
						type: 'tool_use',
						name: toolCall.function.name,
						toolCallId: toolCall.id,
						parameters: args,
					});
				} catch (error) {
					logService.warn(
						`[chatgpt-server] Failed to parse tool call arguments for ${toolCall.function.name}: ${error instanceof Error ? error.message : String(error)}`,
					);
					content.push({
						type: 'tool_use',
						name: toolCall.function.name,
						toolCallId: toolCall.id,
						parameters: {},
					});
				}
			}
		}

		if (content.length > 0) {
			ideMessages.push({ role, content });
		}
	}

	logService.debug(
		`[chatgpt-server] Conversion complete: ${ideMessages.length} messages in IDE format`,
	);

	return ideMessages;
}

