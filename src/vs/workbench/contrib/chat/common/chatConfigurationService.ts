/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";

/**
 * Chat configuration interface with typed access to all chat settings
 */
export interface IChatConfiguration {
	/** Maximum number of tool call iterations (default: unlimited) */
	readonly maxIterations: number;
	/** Maximum concurrent tool executions (default: 10) */
	readonly toolCallMaxConcurrency: number;
	/** Timeout for individual tool calls in milliseconds (default: 30000) */
	readonly toolCallTimeoutMs: number;
	/** Whether metrics/telemetry is enabled */
	readonly enableMetrics: boolean;
	/** Whether planning features are enabled */
	readonly enablePlanning: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIGURATION: IChatConfiguration = {
	maxIterations: Number.MAX_SAFE_INTEGER,
	toolCallMaxConcurrency: 10,
	toolCallTimeoutMs: 30000,
	enableMetrics: true,
	enablePlanning: true,
};

/**
 * Configuration keys used in the configuration service
 */
const CONFIG_KEYS = {
	maxIterations: "chat.agent.maxIterations",
	toolCallMaxConcurrency: "chat.toolCalls.maxConcurrency",
	toolCallTimeoutMs: "chat.toolCalls.timeoutMs",
	enableMetrics: "chat.enableMetrics",
	enablePlanning: "chat.enablePlanning",
} as const;

/**
 * Centralized chat configuration service.
 * Provides type-safe access to all chat-related configuration with sensible defaults.
 */
export class ChatConfigurationService {
	constructor(private readonly configurationService: IConfigurationService) { }

	/**
	 * Get the complete chat configuration
	 */
	getConfiguration(): IChatConfiguration {
		return {
			maxIterations: this.getMaxIterations(),
			toolCallMaxConcurrency: this.getToolCallMaxConcurrency(),
			toolCallTimeoutMs: this.getToolCallTimeoutMs(),
			enableMetrics: this.getEnableMetrics(),
			enablePlanning: this.getEnablePlanning(),
		};
	}

	/**
	 * Get max iterations for tool call loops
	 */
	getMaxIterations(): number {
		return (
			this.configurationService.getValue<number>(CONFIG_KEYS.maxIterations) ??
			DEFAULT_CONFIGURATION.maxIterations
		);
	}

	/**
	 * Get max concurrency for parallel tool execution
	 */
	getToolCallMaxConcurrency(): number {
		return (
			this.configurationService.getValue<number>(CONFIG_KEYS.toolCallMaxConcurrency) ??
			DEFAULT_CONFIGURATION.toolCallMaxConcurrency
		);
	}

	/**
	 * Get timeout for individual tool calls
	 */
	getToolCallTimeoutMs(): number {
		return (
			this.configurationService.getValue<number>(CONFIG_KEYS.toolCallTimeoutMs) ??
			DEFAULT_CONFIGURATION.toolCallTimeoutMs
		);
	}

	/**
	 * Check if metrics/telemetry is enabled
	 */
	getEnableMetrics(): boolean {
		return (
			this.configurationService.getValue<boolean>(CONFIG_KEYS.enableMetrics) ??
			DEFAULT_CONFIGURATION.enableMetrics
		);
	}

	/**
	 * Check if planning features are enabled
	 */
	getEnablePlanning(): boolean {
		return (
			this.configurationService.getValue<boolean>(CONFIG_KEYS.enablePlanning) ??
			DEFAULT_CONFIGURATION.enablePlanning
		);
	}

	/**
	 * Check if iterations limit is effectively unlimited
	 */
	hasUnlimitedIterations(): boolean {
		return this.getMaxIterations() >= Number.MAX_SAFE_INTEGER;
	}
}

/**
 * Factory function to create a ChatConfigurationService
 */
export function createChatConfigurationService(
	configurationService: IConfigurationService
): ChatConfigurationService {
	return new ChatConfigurationService(configurationService);
}

/**
 * Export default configuration for reference
 */
export { DEFAULT_CONFIGURATION as CHAT_DEFAULT_CONFIG };
