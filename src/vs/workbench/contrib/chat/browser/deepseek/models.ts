/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DeepSeekModelConfig {
	readonly id: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault: boolean;
}

/**
 * DeepSeek V3.2 models (December 2025)
 * - deepseek-chat: Non-thinking mode, general purpose
 * - deepseek-reasoner: Thinking mode with step-by-step reasoning
 */
export const DEEPSEEK_MODELS: DeepSeekModelConfig[] = [
	{
		id: 'deepseek-chat',
		identifier: 'deepseek/deepseek-chat',
		name: 'DeepSeek V3.2 Chat',
		description: 'DeepSeek V3.2 - general purpose model, fast and efficient.',
		maxInputTokens: 64000,
		maxOutputTokens: 8192,
		isDefault: true
	},
	{
		id: 'deepseek-reasoner',
		identifier: 'deepseek/deepseek-reasoner',
		name: 'DeepSeek V3.2 Reasoner',
		description: 'DeepSeek V3.2 Reasoner - advanced thinking mode with step-by-step reasoning.',
		maxInputTokens: 64000,
		maxOutputTokens: 8192,
		isDefault: false
	}
];

