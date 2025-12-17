/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage } from '../../common/languageModels.js';

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



