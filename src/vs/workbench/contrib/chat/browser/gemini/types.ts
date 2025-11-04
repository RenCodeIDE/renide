/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';

export type GeminiRole = 'user' | 'model';

export type GeminiContentPart =
	| { text: string }
	| { functionCall: { name: string; args: Record<string, unknown> } }
	| { functionResponse: { name: string; response: unknown } };

export interface GeminiApiChunk {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
				functionCall?: {
					name: string;
					args?: unknown;
				};
				functionResponse?: {
					name: string;
					response: unknown;
				};
			}>;
		};
		finishReason?: string;
	}>;
	usageMetadata?: unknown;
	error?: { message?: string };
}

export interface GeminiContent {
	readonly role: GeminiRole;
	readonly parts: GeminiContentPart[];
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

export interface GeminiFunctionDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: unknown;
}

export interface GeminiToolConfig {
	readonly functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiRequestOptions {
	readonly tools?: GeminiToolConfig[];
}

export interface GeminiResponse {
	readonly parts: GeminiContentPart[];
	readonly finishReason?: string;
	readonly usageMetadata?: unknown;
}

export interface GeminiStreamingResponse {
	readonly stream: AsyncIterable<GeminiContentPart[]>;
	readonly result: Promise<GeminiResponse>;
}

