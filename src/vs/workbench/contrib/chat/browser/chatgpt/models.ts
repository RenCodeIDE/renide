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
		id: "gpt-5-2025-08-07",
		identifier: "openai/gpt-5-2025-08-07",
		name: "GPT-5",
		description: "",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
	{
		id: "gpt-5-nano-2025-08-07",
		identifier: "openai/gpt-5-nano-2025-08-07",
		name: "GPT-5 Nano",
		description: "",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: true,
	},
];
