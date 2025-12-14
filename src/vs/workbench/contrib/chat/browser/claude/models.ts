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
		id: "claude-sonnet-4-20250514",
		identifier: "anthropic/claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		description: "",
		maxInputTokens: 200000,
		maxOutputTokens: 16384,
		isDefault: true,
	},
];
