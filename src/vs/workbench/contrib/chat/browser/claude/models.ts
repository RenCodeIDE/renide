/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ClaudeModelConfig {
	readonly id: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault: boolean;
}

export const CLAUDE_MODELS: ClaudeModelConfig[] = [
	{
		id: 'claude-sonnet-4-20250514',
		identifier: 'anthropic/claude-sonnet-4-20250514',
		name: 'Claude Sonnet 4',
		description: 'Anthropic Claude Sonnet 4 - latest balanced model with enhanced capabilities.',
		maxInputTokens: 200000,
		maxOutputTokens: 16384,
		isDefault: true
	},
	{
		id: 'claude-3-5-sonnet-latest',
		identifier: 'anthropic/claude-3-5-sonnet-latest',
		name: 'Claude 3.5 Sonnet',
		description: 'Anthropic Claude 3.5 Sonnet - balanced performance.',
		maxInputTokens: 200000,
		maxOutputTokens: 8192,
		isDefault: false
	},
	{
		id: 'claude-3-5-haiku-20241022',
		identifier: 'anthropic/claude-3-5-haiku-20241022',
		name: 'Claude 3.5 Haiku',
		description: 'Anthropic Claude 3.5 Haiku - fast and efficient.',
		maxInputTokens: 200000,
		maxOutputTokens: 8192,
		isDefault: false
	},
	{
		id: 'claude-3-opus-20240229',
		identifier: 'anthropic/claude-3-opus-20240229',
		name: 'Claude 3 Opus',
		description: 'Anthropic Claude 3 Opus - most capable option.',
		maxInputTokens: 200000,
		maxOutputTokens: 4096,
		isDefault: false
	},
	{
		id: 'claude-3-haiku-20240307',
		identifier: 'anthropic/claude-3-haiku-20240307',
		name: 'Claude 3 Haiku',
		description: 'Anthropic Claude 3 Haiku - fastest legacy option.',
		maxInputTokens: 200000,
		maxOutputTokens: 4096,
		isDefault: false
	}
];

