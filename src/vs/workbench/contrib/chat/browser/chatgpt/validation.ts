/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage } from '../../common/languageModels.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/**
 * Validates IDE format before sending to server.
 */
export function validateIDEFormatStatic(messages: IChatMessage[], logService?: ILogService): void {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (typeof msg.role !== 'number' || msg.role < 0 || msg.role > 2) {
			const err = `Invalid message[${i}]: role must be number (0-2), got ${msg.role}`;
			logService?.error(`[chatgpt-server] ${err}`);
			throw new Error(`[chatgpt-server] ${err}`);
		}

		if (!Array.isArray(msg.content) || msg.content.length === 0) {
			const err = `Invalid message[${i}]: content must be non-empty array`;
			logService?.error(`[chatgpt-server] ${err}`);
			throw new Error(`[chatgpt-server] ${err}`);
		}

		const msgWithToolCalls = msg as IChatMessage & { tool_calls?: unknown };
		if (Object.prototype.hasOwnProperty.call(msgWithToolCalls, 'tool_calls') && msgWithToolCalls.tool_calls !== undefined) {
			const err = `Invalid message[${i}]: tool_calls at message level (should be in content array)`;
			logService?.error(`[chatgpt-server] ${err}`);
			throw new Error(`[chatgpt-server] ${err}`);
		}

		for (let j = 0; j < msg.content.length; j++) {
			const part = msg.content[j];
			if (part.type === 'tool_use' && (typeof part.parameters !== 'object' || part.parameters === null || Array.isArray(part.parameters))) {
				const err = `Invalid message[${i}].content[${j}]: tool_use.parameters must be object`;
				logService?.error(`[chatgpt-server] ${err}`);
				throw new Error(`[chatgpt-server] ${err}`);
			}
		}
	}
}

/**
 * Validates IDE format before sending.
 */
export function validateIDEFormat(messages: IChatMessage[]): void {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (typeof msg.role !== 'number' || msg.role < 0 || msg.role > 2) {
			throw new Error(`[chatgpt-server] Invalid message[${i}]: role must be number (0-2), got ${msg.role}`);
		}

		if (!Array.isArray(msg.content) || msg.content.length === 0) {
			throw new Error(`[chatgpt-server] Invalid message[${i}]: content must be non-empty array`);
		}

		const msgWithToolCalls = msg as IChatMessage & { tool_calls?: unknown };
		if (Object.prototype.hasOwnProperty.call(msgWithToolCalls, 'tool_calls') && msgWithToolCalls.tool_calls !== undefined) {
			throw new Error(`[chatgpt-server] Invalid message[${i}]: tool_calls at message level (should be in content array)`);
		}

		for (let j = 0; j < msg.content.length; j++) {
			const part = msg.content[j];
			if (part.type === 'tool_use' && (typeof part.parameters !== 'object' || part.parameters === null || Array.isArray(part.parameters))) {
				throw new Error(`[chatgpt-server] Invalid message[${i}].content[${j}]: tool_use.parameters must be object`);
			}
		}
	}
}

