/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ChatGPTModelConfig {
	readonly id: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault: boolean;
}

export const CHATGPT_MODELS: ChatGPTModelConfig[] = [
	{
		id: 'gpt-5-2025-08-07',
		identifier: 'openai/gpt-5-2025-08-07',
		name: 'GPT-5',
		description: 'OpenAI GPT-5 - most advanced model.',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
	{
		id: 'gpt-5-nano-2025-08-07',
		identifier: 'openai/gpt-5-nano-2025-08-07',
		name: 'GPT-5 Nano',
		description: 'OpenAI GPT-5 Nano - fastest and most efficient.',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: true,
	},
	{
		id: 'gpt-4.1-2025-04-14',
		identifier: 'openai/gpt-4.1-2025-04-14',
		name: 'GPT-4.1',
		description: 'OpenAI GPT-4.1 - balanced performance.',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
	{
		id: 'chatgpt-4o-latest',
		identifier: 'openai/chatgpt-4o-latest',
		name: 'GPT-4o',
		description: 'OpenAI GPT-4o - optimized for chat.',
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
];

