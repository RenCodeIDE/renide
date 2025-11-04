/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { hasKey } from '../../../../../base/common/types.js';
import { IChatProgressHistoryResponseContent } from '../../common/chatModel.js';
import { IChatTaskDto } from '../../common/chatService.js';
import type { GeminiContentPart } from './types.js';

export function extractTextFromParts(parts: GeminiContentPart[], trim = true): string {
	const segments: string[] = [];
	for (const part of parts) {
		if (hasKey(part, { text: true }) && typeof part.text === 'string') {
			segments.push(part.text);
		}
	}
	const text = segments.join('\n');
	return trim ? text.trim() : text;
}

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

