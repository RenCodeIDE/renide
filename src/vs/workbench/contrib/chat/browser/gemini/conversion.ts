/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage, IChatResponseTextPart, ChatMessageRole } from '../../common/languageModels.js';
import type { GeminiContent, GeminiContentPart, GeminiRole } from './types.js';

export function normalizeFunctionCallArgs(args: unknown): Record<string, unknown> {
	if (args && typeof args === 'object') {
		return args as Record<string, unknown>;
	}
	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			if (parsed && typeof parsed === 'object') {
				return parsed as Record<string, unknown>;
			}
		} catch (error) {
			console.warn('[gemini] Failed to parse function call arguments', error);
		}
	}
	return {};
}

export function reduceMessageParts(message: IChatMessage): string {
	const parts = message.content ?? [];
	const segments: string[] = [];
	for (const part of parts) {
		if (part.type === 'text') {
			segments.push(part.value);
		}
	}
	return segments.join('\n');
}

export function toGeminiContents(messages: IChatMessage[]): GeminiContent[] {
	return messages.map(entry => {
		const role: GeminiRole = entry.role === ChatMessageRole.Assistant ? 'model' : 'user';
		const parts: GeminiContentPart[] = [];
		const callIdToName = new Map<string, string>();

		for (const part of entry.content ?? []) {
			switch (part.type) {
				case 'text': {
					if (part.value.length) {
						parts.push({ text: part.value });
					}
					break;
				}
				case 'tool_use': {
					const parameters = typeof part.parameters === 'object' && part.parameters !== null ? part.parameters as Record<string, unknown> : { value: part.parameters };
					parts.push({ functionCall: { name: part.name, args: parameters } });
					callIdToName.set(part.toolCallId, part.name);
					break;
				}
				case 'tool_result': {
					const toolName = callIdToName.get(part.toolCallId) ?? part.toolCallId;
					const response: Record<string, unknown> = {};
					const textOutputs = part.value
						.filter((valuePart): valuePart is IChatResponseTextPart => valuePart.type === 'text')
						.map(valuePart => valuePart.value)
						.join('\n');
					if (textOutputs.length) {
						response['text'] = textOutputs;
					}
					if (part.isError) {
						response['isError'] = true;
					}
					if (!Object.keys(response).length) {
						response['text'] = '';
					}
					parts.push({ functionResponse: { name: toolName, response } });
					break;
				}
				default:
					break;
			}
		}

		if (!parts.length) {
			const text = reduceMessageParts(entry);
			if (text.length) {
				parts.push({ text });
			}
		}

		return { role, parts };
	}).filter(message => message.parts.length > 0);
}

