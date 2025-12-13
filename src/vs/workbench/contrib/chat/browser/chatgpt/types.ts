/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';

export type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAIMessage {
	readonly role: OpenAIRole;
	readonly content: string | null;
	readonly tool_calls?: OpenAIToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}

export interface OpenAIToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

export interface OpenAIFunction {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description?: string;
		readonly parameters?: unknown;
	};
}

export interface ChatGPTContentPart {
	readonly text?: string;
	readonly toolCall?: {
		readonly id: string;
		readonly name: string;
		readonly args: Record<string, unknown>;
	};
	readonly toolResponse?: {
		readonly id: string;
		readonly result: unknown;
	};
}

export interface ChatGPTResponse {
	readonly parts: ChatGPTContentPart[];
	readonly finishReason?: string | null;
	readonly usage?: unknown;
}

export interface ChatGPTStreamingResponse {
	readonly stream: AsyncIterable<ChatGPTContentPart[]>;
	readonly result: Promise<ChatGPTResponse>;
}

export interface IContextBlockMetadata {
	readonly label: string;
	readonly uri: URI;
	readonly range: Range | undefined;
	readonly language: string;
	readonly content: string;
}

export interface IContextPromptResult {
	readonly prompt: string;
	readonly entries: IContextBlockMetadata[];
}

export interface IParsedCodeBlock {
	readonly language: string;
	readonly content: string;
}

export interface ServerToolResult {
	readonly toolCallId: string;
	readonly content: Array<{ type: 'text'; value: string }>;
}

/**
 * Options for server requests.
 *
 * NOTE: The server is responsible for transforming this IDE format to the target API format:
 * - For Claude API: `parameters` must be renamed to `input_schema`
 * - For Claude API: Numeric roles (0=System, 1=User, 2=Assistant) must be converted to strings
 * - For Claude API: System messages must be extracted to the separate `system` parameter
 * - For Claude API: `toolResults` must be converted to `tool_result` content blocks in user messages
 * - For Claude API: `max_tokens` is required and must be added if not provided
 */
export interface ServerRequestOptions {
	readonly context?: string;
	readonly modelName?: string;
	readonly mode?: string;
	readonly tools?: Array<{
		name: string;
		description?: string;
		/** Note: For Claude API, the server must rename this to `input_schema` */
		parameters?: unknown;
	}>;
	readonly toolResults?: ServerToolResult[];
	/** Maximum output tokens for the model response */
	readonly maxOutputTokens?: number;
	/** Chat session ID for metrics tracking */
	readonly sessionId?: string;
	/** Project ID for metrics tracking */
	readonly projectId?: string;
}

export interface IDEStreamPart {
	readonly type: 'text' | 'finish' | 'tool_use' | 'error';
	readonly value?: string;
	readonly finishReason?: string;
	readonly name?: string;
	readonly toolCallId?: string;
	readonly parameters?: Record<string, unknown>;
	readonly message?: string;
}

