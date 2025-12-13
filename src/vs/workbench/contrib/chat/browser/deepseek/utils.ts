/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IChatProgressHistoryResponseContent } from '../../common/chatModel.js';
import { IChatTaskDto } from '../../common/chatService.js';

export function extractResponseContent(part: IChatProgressHistoryResponseContent | IChatTaskDto): string | undefined {
	switch (part.kind) {
		case 'markdownContent':
		case 'progressMessage':
		case 'warning':
			return (part.content as MarkdownString).value;
		default:
			return undefined;
	}
}

export function extractThinkingContent(part: IChatProgressHistoryResponseContent | IChatTaskDto): string | undefined {
	if (part.kind === 'thinking') {
		// thinking parts have 'value' which can be string or array
		const thinkingPart = part as { kind: 'thinking'; value?: string | string[] };
		if (typeof thinkingPart.value === 'string') {
			return thinkingPart.value;
		} else if (Array.isArray(thinkingPart.value)) {
			return thinkingPart.value.join('\n');
		}
	}
	return undefined;
}

interface ContentPart {
	text?: string;
	functionCall?: {
		name: string;
		args: Record<string, unknown>;
	};
}

export function extractTextFromParts(parts: ContentPart[], trim = true): string {
	const segments: string[] = [];
	for (const part of parts) {
		if ('text' in part && typeof part.text === 'string') {
			segments.push(part.text);
		}
	}
	const text = segments.join('\n');
	return trim ? text.trim() : text;
}

