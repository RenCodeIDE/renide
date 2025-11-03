/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage } from '../../common/languageModels.js';
import type { ChatGPTContentPart } from './types.js';

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

export function extractTextFromParts(parts: ChatGPTContentPart[], trim = true): string {
	const segments: string[] = [];
	for (const part of parts) {
		if (part.text !== undefined) {
			segments.push(part.text);
		}
	}
	const text = segments.join('');
	return trim ? text.trim() : text;
}

