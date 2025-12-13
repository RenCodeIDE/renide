/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from "../../../../platform/log/common/log.js";
import { localize } from "../../../../nls.js";
import { ChatErrorLevel, IChatProgress } from "./chatService.js";
import { IChatAgentResult } from "./chatAgents.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";

/**
 * Result from tool execution that can be sent to the server
 */
export interface ServerToolResult {
	toolCallId: string;
	content: Array<{ type: "text"; value: string }>;
}

/**
 * Centralized error handling for chat agents.
 * Provides consistent error messages, logging, and result formatting.
 */
export class ChatErrorHandler {
	constructor(
		private readonly logService: ILogService,
		private readonly agentContext: string
	) { }

	/**
	 * Handle tool execution errors and return a formatted ServerToolResult
	 */
	handleToolExecutionError(
		error: unknown,
		toolName: string,
		callId: string,
		taskTime?: number
	): ServerToolResult {
		const message = this.extractErrorMessage(error);
		const timeInfo = taskTime !== undefined ? ` after ${taskTime}ms` : "";

		this.logService.error(
			`[${this.agentContext}] tool ${toolName} (callId: ${callId}) failed${timeInfo}: ${message}`
		);

		return {
			toolCallId: callId,
			content: [{ type: "text" as const, value: message || "Tool execution failed" }],
		};
	}

	/**
	 * Handle access token retrieval errors
	 */
	handleAccessTokenError(error: unknown): undefined {
		this.logService.error(
			`[${this.agentContext}] Error retrieving access token: ${this.extractErrorMessage(error)}`
		);
		return undefined;
	}

	/**
	 * Handle stream processing errors
	 */
	handleStreamError(error: unknown, isCancelled: boolean): void {
		if (!isCancelled) {
			this.logService.error(
				`[${this.agentContext}] Error in stream: ${this.extractErrorMessage(error)}`
			);
		}
	}

	/**
	 * Handle request/API errors and return formatted agent result
	 */
	handleRequestError(
		error: unknown,
		progress: (parts: IChatProgress[]) => void
	): IChatAgentResult {
		const message = this.extractErrorMessage(error);
		this.logService.error(`[${this.agentContext}] ${message}`);

		const markdown = new MarkdownString(
			localize("chat.error", "{0} request failed: {1}", this.agentContext, message)
		);
		markdown.isTrusted = true;
		progress([{ kind: "markdownContent", content: markdown }]);

		return {
			errorDetails: {
				message,
				level: ChatErrorLevel.Error,
			},
			details: message,
		};
	}

	/**
	 * Create an error result for invalid tool call IDs
	 */
	createInvalidCallIdResult(toolName: string, index: number): ServerToolResult {
		this.logService.error(
			`[${this.agentContext}] CRITICAL: Tool call has empty or missing callId for tool ${toolName}.`
		);
		return {
			toolCallId: `invalid_call_id_${index}`,
			content: [{ type: "text" as const, value: `Invalid callId for tool ${toolName}` }],
		};
	}

	/**
	 * Create an error result for unknown tool requests
	 */
	createUnknownToolResult(
		toolName: string,
		callId: string,
		availableNames: string[]
	): ServerToolResult {
		this.logService.error(
			`[${this.agentContext}] model requested unknown tool name '${toolName}'. Available names: ${availableNames.join(", ")}`
		);
		return {
			toolCallId: callId,
			content: [
				{
					type: "text" as const,
					value: localize(
						"chat.unknownToolCall",
						"{0} requested unknown tool {1}.",
						this.agentContext,
						toolName
					),
				},
			],
		};
	}

	/**
	 * Create an error result for tool call ID mismatch
	 */
	createCallIdMismatchResult(
		toolName: string,
		expectedCallId: string,
		actualCallId: string
	): ServerToolResult {
		this.logService.error(
			`[${this.agentContext}] CRITICAL: callId mismatch! Expected ${expectedCallId}, but invocation has ${actualCallId}`
		);
		return {
			toolCallId: expectedCallId,
			content: [{ type: "text" as const, value: `callId mismatch for ${toolName}` }],
		};
	}

	/**
	 * Log successful tool execution
	 */
	logToolSuccess(toolName: string, callId: string, taskTime: number, resultPreview?: string): void {
		this.logService.info(
			`[Tool Execution] Completed: ${toolName} (CallID: ${callId}) in ${taskTime}ms${resultPreview ? ` - Result: ${resultPreview}` : ""
			}`
		);
	}

	/**
	 * Log tool execution start
	 */
	logToolStart(toolName: string, toolId: string, callId: string): void {
		this.logService.info(
			`[Tool Execution] Starting: ${toolName} (ID: ${toolId}, CallID: ${callId})`
		);
	}

	/**
	 * Extract a human-readable message from an error
	 */
	private extractErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}
}

/**
 * Factory function to create a ChatErrorHandler for a specific agent
 */
export function createChatErrorHandler(
	logService: ILogService,
	agentContext: string
): ChatErrorHandler {
	return new ChatErrorHandler(logService, agentContext);
}
