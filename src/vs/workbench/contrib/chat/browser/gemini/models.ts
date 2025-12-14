/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface GeminiModelConfig {
	readonly id: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault: boolean;
}

export const GEMINI_MODELS: GeminiModelConfig[] = [
	{
		id: "gemini-2.5-flash",
		identifier: "google/gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		description: "",
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		isDefault: true,
	},
	{
		id: "gemini-2.5-pro",
		identifier: "google/gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		description: "",
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		isDefault: false,
	},
];
