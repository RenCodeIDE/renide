/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../base/common/cancellation.js";
import {
	AsyncIterableSource,
	DeferredPromise,
} from "../../../../base/common/async.js";
import { Event } from "../../../../base/common/event.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";
import {
	Disposable,
	IDisposable,
	IReference,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import { listenStream } from "../../../../base/common/stream.js";
import { localize } from "../../../../nls.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { ExtensionIdentifier } from "../../../../platform/extensions/common/extensions.js";
import {
	registerWorkbenchContribution2,
	IWorkbenchContribution,
	WorkbenchPhase,
} from "../../../common/contributions.js";
import {
	IChatAgentService,
	IChatAgentImplementation,
	IChatAgentHistoryEntry,
	IChatAgentRequest,
	IChatAgentResult,
	UserSelectedTools,
} from "../common/chatAgents.js";
import { ChatAgentLocation, ChatModeKind } from "../common/constants.js";
import { IChatProgressHistoryResponseContent } from "../common/chatModel.js";
import {
	ChatErrorLevel,
	IChatProgress,
	IChatTaskDto,
} from "../common/chatService.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { ChatContextKeys } from "../common/chatContextKeys.js";
import {
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelsService,
	IChatMessage,
	IChatResponsePart,
	IChatResponseTextPart,
	ChatMessageRole,
} from "../common/languageModels.js";
import {
	ILanguageModelToolsService,
	IToolData,
	CountTokensCallback,
	IToolInvocation,
	IToolResult,
	IToolResultTextPart,
} from "../common/languageModelToolsService.js";
import {
	ITextModelService,
	IResolvedTextEditorModel,
} from "../../../../editor/common/services/resolverService.js";
import {
	IChatRequestVariableEntry,
	isChatRequestFileEntry,
	isImplicitVariableEntry,
	isPasteVariableEntry,
} from "../common/chatVariableEntries.js";
import { basename } from "../../../../base/common/resources.js";
import {
	isLocation,
	Location,
	TextEdit,
} from "../../../../editor/common/languages.js";
import { Range, IRange } from "../../../../editor/common/core/range.js";
import { URI, UriComponents } from "../../../../base/common/uri.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { env } from "../../../../base/common/process.js";
import { SSEParser } from "../../../../base/common/sseParser.js";
import {
	IRequestService,
	isSuccess,
} from "../../../../platform/request/common/request.js";
import { streamToBuffer } from "../../../../base/common/buffer.js";

interface ChatGPTModelConfig {
	readonly id: string;
	readonly identifier: string;
	readonly name: string;
	readonly description: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault: boolean;
}

const CHATGPT_MODELS: ChatGPTModelConfig[] = [
	{
		id: "gpt-5-2025-08-07",
		identifier: "openai/gpt-5-2025-08-07",
		name: "GPT-5",
		description: "OpenAI GPT-5 - most advanced model.",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
	{
		id: "gpt-5-nano-2025-08-07",
		identifier: "openai/gpt-5-nano-2025-08-07",
		name: "GPT-5 Nano",
		description: "OpenAI GPT-5 Nano - fastest and most efficient.",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: true,
	},
	{
		id: "gpt-4.1-2025-04-14",
		identifier: "openai/gpt-4.1-2025-04-14",
		name: "GPT-4.1",
		description: "OpenAI GPT-4.1 - balanced performance.",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
	{
		id: "chatgpt-4o-latest",
		identifier: "openai/chatgpt-4o-latest",
		name: "GPT-4o",
		description: "OpenAI GPT-4o - optimized for chat.",
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
		isDefault: false,
	},
];

type OpenAIRole = "system" | "user" | "assistant" | "tool";

interface OpenAIMessage {
	readonly role: OpenAIRole;
	readonly content: string | null;
	readonly tool_calls?: OpenAIToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}

interface OpenAIToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

interface OpenAIFunction {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description?: string;
		readonly parameters?: unknown;
	};
}

interface OpenAIApiChunk {
	readonly id?: string;
	readonly object?: string;
	readonly created?: number;
	readonly model?: string;
	readonly choices?: Array<{
		readonly index?: number;
		readonly delta?: {
			readonly role?: OpenAIRole;
			readonly content?: string;
			readonly tool_calls?: Array<{
				readonly index?: number;
				readonly id?: string;
				readonly type?: "function";
				readonly function?: {
					readonly name?: string;
					readonly arguments?: string;
				};
			}>;
		};
		readonly finish_reason?: string | null;
	}>;
	readonly usage?: {
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
		readonly total_tokens?: number;
	};
	readonly error?: {
		readonly message?: string;
		readonly type?: string;
		readonly code?: string;
	};
}

interface ChatGPTContentPart {
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

interface ChatGPTResponse {
	readonly parts: ChatGPTContentPart[];
	readonly finishReason?: string | null;
	readonly usage?: unknown;
}

interface ChatGPTStreamingResponse {
	readonly stream: AsyncIterable<ChatGPTContentPart[]>;
	readonly result: Promise<ChatGPTResponse>;
}

interface IContextBlockMetadata {
	readonly label: string;
	readonly uri: URI;
	readonly range: Range | undefined;
	readonly language: string;
	readonly content: string;
}

interface IContextPromptResult {
	readonly prompt: string;
	readonly entries: IContextBlockMetadata[];
}

interface IParsedCodeBlock {
	readonly language: string;
	readonly content: string;
}

interface ChatGPTRequestOptions {
	readonly tools?: OpenAIFunction[];
	readonly tool_choice?:
		| "auto"
		| "none"
		| { type: "function"; function: { name: string } };
}

async function sendChatGPTRequest(
	requestService: IRequestService,
	apiKey: string,
	model: string,
	messages: OpenAIMessage[],
	token: CancellationToken,
	options?: ChatGPTRequestOptions,
): Promise<ChatGPTStreamingResponse> {
	const url = "https://api.openai.com/v1/chat/completions";
	const payload: Record<string, unknown> = {
		model,
		messages,
		stream: true,
	};
	if (options?.tools && options.tools.length > 0) {
		payload["tools"] = options.tools;
		payload["tool_choice"] = options.tool_choice ?? "auto";
	}

	const body = JSON.stringify(payload);

	const context = await requestService.request(
		{
			type: "POST",
			url,
			data: body,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				Accept: "text/event-stream",
			},
		},
		token,
	);

	if (!isSuccess(context)) {
		const buffer = await streamToBuffer(context.stream);
		const errorText = buffer.toString();
		let errorMessage = `ChatGPT API error: ${context.res.statusCode}`;
		try {
			const errorJson = JSON.parse(errorText);
			if (errorJson.error?.message) {
				errorMessage = errorJson.error.message;
			}
		} catch {
			errorMessage += ` - ${errorText || "Unknown error"}`;
		}
		throw new Error(errorMessage);
	}

	const stream = new AsyncIterableSource<ChatGPTContentPart[]>();
	const deferred = new DeferredPromise<ChatGPTResponse>();
	const aggregatedParts: ChatGPTContentPart[] = [];
	const textAccumulator: string[] = [];
	const toolCallsMap = new Map<string, OpenAIToolCall>();
	let finishReason: string | null | undefined;
	let usage: unknown;
	let streamCompleted = false;
	let toolCallsEmitted = false;
	let cancellationListener: IDisposable | undefined;

	const finalizeSuccess = () => {
		if (streamCompleted) {
			return;
		}
		streamCompleted = true;
		if (cancellationListener) {
			cancellationListener.dispose();
			cancellationListener = undefined;
		}

		if (!deferred.isSettled) {
			// Emit any remaining tool calls if finish_reason was set but they weren't emitted during streaming
			if (
				!toolCallsEmitted &&
				finishReason !== undefined &&
				finishReason !== null &&
				toolCallsMap.size > 0
			) {
				for (const [id, toolCall] of toolCallsMap) {
					let args: Record<string, unknown> = {};
					try {
						const argsStr = toolCall.function.arguments || "{}";
						args = JSON.parse(argsStr) as Record<string, unknown>;
					} catch {
						args = { raw: toolCall.function.arguments || "" };
					}
					aggregatedParts.push({
						toolCall: {
							id,
							name: toolCall.function.name || "",
							args,
						},
					});
				}
				toolCallsMap.clear();
			}

			if (
				!aggregatedParts.length &&
				textAccumulator.length === 0 &&
				toolCallsMap.size === 0
			) {
				const err = new Error(
					localize(
						"chatgpt.invalidResponse",
						"Model returned an empty response.",
					),
				);
				deferred.error(err);
				stream.reject(err);
				return;
			}
			// Flush any remaining text
			if (textAccumulator.length > 0) {
				const accumulatedText = textAccumulator.join("");
				if (accumulatedText.trim().length) {
					aggregatedParts.push({ text: accumulatedText });
				}
				textAccumulator.length = 0;
			}
			deferred.complete({ parts: aggregatedParts, finishReason, usage });
		}
		stream.resolve();
	};

	const finalizeError = (error: Error) => {
		if (streamCompleted) {
			return;
		}
		streamCompleted = true;
		if (cancellationListener) {
			cancellationListener.dispose();
			cancellationListener = undefined;
		}

		if (!deferred.isSettled) {
			deferred.error(error);
		}
		stream.reject(error);
	};

	cancellationListener = token.onCancellationRequested(() => {
		const err = new CancellationError();
		finalizeError(err);
		if (typeof context.stream.destroy === "function") {
			context.stream.destroy();
		}
	});

	const parser = new SSEParser((event) => {
		if (event.type !== "message") {
			return;
		}

		const rawData = event.data?.trim();
		if (!rawData) {
			return;
		}
		if (rawData === "[DONE]") {
			finalizeSuccess();
			return;
		}

		let parsed: OpenAIApiChunk;
		try {
			parsed = JSON.parse(rawData) as OpenAIApiChunk;
		} catch (error) {
			const err = new Error(
				`ChatGPT streaming chunk parse failure: ${error instanceof Error ? error.message : String(error)}`,
			);
			finalizeError(err);
			return;
		}

		if (parsed.error) {
			const err = new Error(parsed.error.message ?? "ChatGPT streaming error");
			finalizeError(err);
			return;
		}

		const choice = parsed.choices?.[0];
		if (!choice) {
			return;
		}

		if (choice.finish_reason !== undefined) {
			finishReason = finishReason ?? choice.finish_reason;
		}

		if (parsed.usage) {
			usage = parsed.usage;
		}

		const delta = choice.delta;
		if (!delta) {
			return;
		}

		const newParts: ChatGPTContentPart[] = [];

		// Handle text content
		if (delta.content !== undefined && delta.content.length > 0) {
			textAccumulator.push(delta.content);
			newParts.push({ text: delta.content });
		}

		// Handle tool calls
		if (delta.tool_calls) {
			for (const toolCallDelta of delta.tool_calls) {
				if (!toolCallDelta.id || !toolCallDelta.function) {
					// Skip incomplete tool call chunks (id and function should always be present)
					continue;
				}
				const existingCall = toolCallsMap.get(toolCallDelta.id);
				if (existingCall) {
					// Append to existing call's arguments (arguments are streamed as text chunks)
					// Create new object since properties are readonly
					const updatedArguments = toolCallDelta.function.arguments
						? (existingCall.function.arguments || "") +
							toolCallDelta.function.arguments
						: existingCall.function.arguments;
					const updatedName =
						toolCallDelta.function.name || existingCall.function.name;
					toolCallsMap.set(toolCallDelta.id, {
						id: toolCallDelta.id,
						type: "function",
						function: {
							name: updatedName,
							arguments: updatedArguments || "",
						},
					});
				} else {
					// New tool call - initialize with empty arguments if not provided
					toolCallsMap.set(toolCallDelta.id, {
						id: toolCallDelta.id,
						type: "function",
						function: {
							name: toolCallDelta.function.name || "",
							arguments: toolCallDelta.function.arguments || "",
						},
					});
				}
			}
		}

		// Emit tool calls when complete (after finish_reason is set and not null)
		if (
			!toolCallsEmitted &&
			finishReason !== undefined &&
			finishReason !== null &&
			toolCallsMap.size > 0
		) {
			for (const [id, toolCall] of toolCallsMap) {
				let args: Record<string, unknown> = {};
				try {
					const argsStr = toolCall.function.arguments || "{}";
					args = JSON.parse(argsStr) as Record<string, unknown>;
				} catch {
					// If parsing fails, try to create a simple object with the raw string
					args = { raw: toolCall.function.arguments || "" };
				}
				newParts.push({
					toolCall: {
						id,
						name: toolCall.function.name || "",
						args,
					},
				});
			}
			toolCallsEmitted = true;
			toolCallsMap.clear();
		}

		if (newParts.length) {
			aggregatedParts.push(...newParts);
			stream.emitOne(newParts);
		}
	});

	listenStream(
		context.stream,
		{
			onData: (chunk) => {
				try {
					parser.feed(chunk.buffer);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					finalizeError(err);
				}
			},
			onError: (error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				finalizeError(err);
			},
			onEnd: () => {
				finalizeSuccess();
			},
		},
		token,
	);

	return {
		stream: stream.asyncIterable,
		result: deferred.p,
	};
}

function reduceMessageParts(message: IChatMessage): string {
	const parts = message.content ?? [];
	const segments: string[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			segments.push(part.value);
		}
	}
	return segments.join("\n");
}

function toChatGPTMessages(messages: IChatMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	const callIdToName = new Map<string, string>();

	for (const entry of messages) {
		const contentParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		let toolCallId: string | undefined;
		let toolResult: unknown;

		for (const part of entry.content ?? []) {
			switch (part.type) {
				case "text": {
					if (part.value.length) {
						contentParts.push(part.value);
					}
					break;
				}
				case "tool_use": {
					// Assistant message with tool call
					const parameters =
						typeof part.parameters === "object" && part.parameters !== null
							? (part.parameters as Record<string, unknown>)
							: { value: part.parameters };
					toolCalls.push({
						id: part.toolCallId,
						type: "function",
						function: {
							name: part.name,
							arguments: JSON.stringify(parameters),
						},
					});
					callIdToName.set(part.toolCallId, part.name);
					break;
				}
				case "tool_result": {
					// Tool response message
					toolCallId = part.toolCallId;
					const textOutputs = part.value
						.filter(
							(valuePart): valuePart is IChatResponseTextPart =>
								valuePart.type === "text",
						)
						.map((valuePart) => valuePart.value)
						.join("\n");
					if (textOutputs.length) {
						toolResult = { text: textOutputs, isError: part.isError };
					} else {
						toolResult = { text: "", isError: part.isError };
					}
					break;
				}
				default:
					break;
			}
		}

		if (entry.role === ChatMessageRole.Assistant) {
			if (toolCalls.length > 0) {
				// Assistant message with tool calls
				const content =
					contentParts.length > 0 ? contentParts.join("\n") : null;
				result.push({
					role: "assistant",
					content: content,
					tool_calls: toolCalls,
				});
			} else if (contentParts.length > 0) {
				// Regular assistant message
				result.push({
					role: "assistant",
					content: contentParts.join("\n"),
				});
			}
		} else if (entry.role === ChatMessageRole.User) {
			if (toolCallId && toolResult !== undefined) {
				// Tool result message (OpenAI expects role 'tool')
				result.push({
					role: "tool",
					content:
						typeof toolResult === "string"
							? toolResult
							: JSON.stringify(toolResult),
					tool_call_id: toolCallId,
				});
			} else if (contentParts.length > 0) {
				// Regular user message
				result.push({
					role: "user",
					content: contentParts.join("\n"),
				});
			}
		} else if (
			entry.role === ChatMessageRole.System &&
			contentParts.length > 0
		) {
			// System message
			result.push({
				role: "system",
				content: contentParts.join("\n"),
			});
		}
	}

	return result.filter((msg) => {
		// Filter out invalid messages
		if (msg.role === "assistant" && msg.content === null && !msg.tool_calls) {
			return false;
		}
		if (
			(msg.role === "user" || msg.role === "system" || msg.role === "tool") &&
			(msg.content === null || msg.content === "")
		) {
			return false;
		}
		return true;
	});
}

class ChatGPTAgentImplementation implements IChatAgentImplementation {
	private readonly requestTools = new Map<string, UserSelectedTools>();
	private readonly fallbackCountTokens: CountTokensCallback = async (
		input: string,
		_token: CancellationToken,
	) => input.length;

	constructor(
		private readonly requestService: IRequestService,
		private readonly apiKey: string,
		private readonly logService: ILogService,
		private readonly textModelService: ITextModelService,
		private readonly languageModelToolsService: ILanguageModelToolsService,
		private readonly languageModelsService: ILanguageModelsService,
	) {}

	private resolveModelFromRequest(userSelectedModelId?: string): string {
		if (userSelectedModelId) {
			const selectedModelConfig = CHATGPT_MODELS.find(
				(m) => m.identifier === userSelectedModelId,
			);
			if (selectedModelConfig) {
				return selectedModelConfig.id;
			}
		}
		const defaultModel = CHATGPT_MODELS.find((m) => m.isDefault);
		return defaultModel?.id || "gpt-5-nano-2025-08-07";
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		if (token.isCancellationRequested) {
			return { details: "cancelled" };
		}

		// Check if user selected a model from a different vendor
		if (request.userSelectedModelId) {
			const selectedModelMetadata =
				this.languageModelsService.lookupLanguageModel(
					request.userSelectedModelId,
				);
			if (selectedModelMetadata && selectedModelMetadata.vendor !== "openai") {
				// Delegate to language models service for cross-vendor model
				return this.invokeViaLanguageModelsService(
					request,
					progress,
					history,
					token,
					request.userSelectedModelId,
				);
			}
		}

		// Resolve the model to use from request
		const modelToUse = this.resolveModelFromRequest(
			request.userSelectedModelId,
		);

		// Read tools from request object first (setRequestTools() may not be called for initial value)
		if (request.userSelectedTools) {
			this.logService.debug(
				`[chatgpt] reading tools from request object for request ${request.requestId}: ${JSON.stringify(request.userSelectedTools)}`,
			);
			this.requestTools.set(request.requestId, request.userSelectedTools);
		}

		const { messages, contextEntries } = await this.buildMessages(
			request,
			history,
			token,
		);
		const { tools: toolConfigs, nameToToolId } =
			this.buildChatGPTToolDeclarations(request.requestId);
		if (toolConfigs.length > 0) {
			// Add a system message about available tools
			const toolSummaries = Array.from(nameToToolId.keys())
				.map((name) => {
					const toolId = nameToToolId.get(name);
					const toolsArray = Array.from(
						this.languageModelToolsService.getTools(),
					);
					const tool = toolsArray.find((t: IToolData) => t.id === toolId);
					const desc = tool?.modelDescription || tool?.displayName || name;
					return `- ${name}: ${desc}`;
				})
				.join("\n");
			messages.unshift({
				role: "system",
				content: `You can call the following tools when they would help:\n${toolSummaries}\nOnly call a tool if it is necessary; otherwise respond normally.`,
			});
		}

		const maxIterations = 10;
		let iteration = 0;

		try {
			while (iteration < maxIterations) {
				if (token.isCancellationRequested) {
					return { details: "cancelled" };
				}

				const streamingResponse = await this.performRequest(
					messages,
					toolConfigs,
					token,
					modelToUse,
				);
				let streamedText = false;

				try {
					for await (const chunk of streamingResponse.stream) {
						if (token.isCancellationRequested) {
							break;
						}
						const delta = this.extractTextFromParts(chunk, false);
						if (delta.length) {
							const markdownChunk = new MarkdownString(delta);
							markdownChunk.supportThemeIcons = true;
							progress([{ kind: "markdownContent", content: markdownChunk }]);
							streamedText = true;
						}
					}
				} catch (error) {
					if (!token.isCancellationRequested) {
						throw error;
					}
				}

				if (token.isCancellationRequested) {
					return { details: "cancelled" };
				}

				const responseData = await streamingResponse.result;
				const responseParts = responseData.parts;

				// Extract text and tool calls from response
				const textParts = responseParts.filter(
					(part) => part.text !== undefined,
				);
				const toolCallParts = responseParts.filter(
					(part) => part.toolCall !== undefined,
				);

				// Add assistant message with text
				if (textParts.length > 0) {
					const textContent = textParts.map((part) => part.text || "").join("");
					if (textContent.trim().length) {
						messages.push({ role: "assistant", content: textContent });
					}
				}

				// Handle tool calls
				if (toolCallParts.length > 0) {
					// Add assistant message with tool calls
					const toolCalls: OpenAIToolCall[] = toolCallParts.map((part) => ({
						id: part.toolCall!.id,
						type: "function",
						function: {
							name: part.toolCall!.name,
							arguments: JSON.stringify(part.toolCall!.args),
						},
					}));
					messages.push({
						role: "assistant",
						content: null,
						tool_calls: toolCalls,
					});

					if (!toolConfigs.length) {
						const errorMessage = localize(
							"chatgpt.toolsNotAuthorized",
							"ChatGPT requested tool calls but none were authorized for this request.",
						);
						progress([
							{
								kind: "markdownContent",
								content: new MarkdownString(errorMessage),
							},
						]);
						return {
							errorDetails: {
								message: errorMessage,
								level: ChatErrorLevel.Error,
							},
							details: errorMessage,
						};
					}

					// Execute tool calls
					const toolResponseMessages: OpenAIMessage[] = [];
					for (const callPart of toolCallParts) {
						if (token.isCancellationRequested) {
							return { details: "cancelled" };
						}

						const toolName = callPart.toolCall!.name;
						const toolId = nameToToolId.get(toolName);
						if (!toolId) {
							this.logService.warn(
								`[chatgpt] model requested unknown tool name ${toolName}`,
							);
							toolResponseMessages.push({
								role: "tool",
								content: JSON.stringify({
									error: localize(
										"chatgpt.unknownToolCall",
										"ChatGPT requested unknown tool {0}.",
										toolName,
									),
								}),
								tool_call_id: callPart.toolCall!.id,
							});
							continue;
						}

						const parameters = callPart.toolCall!.args ?? {};
						const callId = callPart.toolCall!.id;
						const invocation = this.createToolInvocation(
							callId,
							toolId,
							parameters,
							request,
						);
						this.logService.debug(
							`[chatgpt] invoking tool ${toolId} (${toolName}) with params keys: ${Object.keys(parameters).join(", ")}`,
						);

						try {
							const result = await this.languageModelToolsService.invokeTool(
								invocation,
								this.fallbackCountTokens,
								token,
							);
							this.logService.debug(
								`[chatgpt] tool ${toolId} completed successfully`,
							);
							const toolResult = this.createToolResponse(result);
							toolResponseMessages.push({
								role: "tool",
								content: toolResult,
								tool_call_id: callId,
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							this.logService.warn(
								`[chatgpt] tool ${toolId} failed: ${message}`,
							);
							toolResponseMessages.push({
								role: "tool",
								content: JSON.stringify({ error: message }),
								tool_call_id: callId,
							});
						}
					}

					if (toolResponseMessages.length === 0) {
						throw new Error(
							localize(
								"chatgpt.noToolResponses",
								"ChatGPT requested tool calls but no responses were produced.",
							),
						);
					}

					// Add tool responses to messages
					messages.push(...toolResponseMessages);
					iteration++;
					continue;
				}

				// No tool calls, return the response
				const responseText =
					this.extractTextFromParts(responseParts) ||
					localize(
						"chatgpt.emptyTextResponse",
						"ChatGPT did not return any text.",
					);

				await this.tryAutoApplyEdits(
					responseText,
					contextEntries,
					progress,
					token,
				);

				if (!streamedText) {
					const markdown = new MarkdownString(responseText);
					markdown.supportThemeIcons = true;
					progress([{ kind: "markdownContent", content: markdown }]);
				}

				return {
					details: "chatgpt-response",
					metadata: { model: modelToUse },
				};
			}

			throw new Error(
				localize(
					"chatgpt.maxToolIterations",
					"Reached the maximum number of tool call iterations without producing an answer.",
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[chatgpt] ${message}`);

			const markdown = new MarkdownString(
				localize("chatgpt.error", "ChatGPT request failed: {0}", message),
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
		} finally {
			this.requestTools.delete(request.requestId);
			this.languageModelToolsService.cancelToolCallsForRequest(
				request.requestId,
			);
		}
	}

	private async invokeViaLanguageModelsService(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelId: string,
	): Promise<IChatAgentResult> {
		this.logService.info(
			`[chatgpt] Delegating request to language models service for model ${modelId} (cross-vendor)`,
		);

		const messages: IChatMessage[] = [];

		// Add context prompt if available
		const contextPrompt = await this.buildContextPrompt(request, token);
		if (contextPrompt) {
			messages.push({
				role: ChatMessageRole.User,
				content: [{ type: "text", value: contextPrompt.prompt }],
			});
		}

		// Convert history
		for (const entry of history) {
			if (!entry) {
				continue;
			}
			const userMessage = entry.request?.message;
			if (userMessage) {
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: "text", value: userMessage }],
				});
			}
			const assistantText = entry.response
				?.map((part) => this.extractResponseContent(part))
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
				.join("\n");
			if (assistantText) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: "text", value: assistantText }],
				});
			}
		}

		// Add current request
		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: "text", value: request.message }],
		});

		try {
			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				new ExtensionIdentifier("core.chatgpt"),
				messages,
				{},
				token,
			);

			for await (const chunk of response.stream) {
				if (token.isCancellationRequested) {
					break;
				}
				const parts = Array.isArray(chunk) ? chunk : [chunk];
				for (const part of parts) {
					if (part.type === "text") {
						const markdownChunk = new MarkdownString(part.value);
						markdownChunk.supportThemeIcons = true;
						progress([{ kind: "markdownContent", content: markdownChunk }]);
					}
				}
			}

			await response.result;

			return {
				details: "chatgpt-response",
				metadata: { model: modelId, delegated: true },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(
				`[chatgpt] Error in delegated request for model ${modelId}:`,
				error,
			);
			const markdown = new MarkdownString(
				localize("chatgpt.error", "ChatGPT request failed: {0}", message),
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
	}

	setRequestTools(requestId: string, tools: UserSelectedTools): void {
		if (!tools) {
			this.logService.debug(
				`[chatgpt] clearing tool selection for request ${requestId}`,
			);
			this.requestTools.delete(requestId);
			return;
		}
		this.logService.debug(
			`[chatgpt] received tool selection for request ${requestId}: ${JSON.stringify(tools)}`,
		);
		this.requestTools.set(requestId, tools);
	}

	private getAllowedToolData(requestId: string): IToolData[] {
		const selected = this.requestTools.get(requestId);
		if (!selected) {
			this.logService.debug(
				`[chatgpt] no tools selected for request ${requestId}`,
			);
			return [];
		}
		const allowedIds = Object.keys(selected).filter(
			(id) => selected[id] === true,
		);
		if (!allowedIds.length) {
			this.logService.debug(
				`[chatgpt] tool selection for request ${requestId} contained no enabled entries`,
			);
			return [];
		}
		const allowedSet = new Set(allowedIds);
		const allowedTools: IToolData[] = [];
		for (const tool of this.languageModelToolsService.getTools()) {
			if (allowedSet.has(tool.id)) {
				allowedTools.push(tool);
			}
		}
		this.logService.debug(
			`[chatgpt] resolved ${allowedTools.length} tools for request ${requestId}: ${allowedTools.map((tool) => tool.id).join(", ")}`,
		);
		return allowedTools;
	}

	private buildChatGPTToolDeclarations(requestId: string): {
		tools: OpenAIFunction[];
		nameToToolId: Map<string, string>;
	} {
		const allowedTools = this.getAllowedToolData(requestId);
		if (!allowedTools.length) {
			return { tools: [], nameToToolId: new Map() };
		}

		const usedNames = new Set<string>();
		const nameToToolId = new Map<string, string>();
		const functions: OpenAIFunction[] = [];

		for (let index = 0; index < allowedTools.length; index++) {
			const tool = allowedTools[index];
			const functionName = this.sanitizeToolName(tool, index, usedNames);
			usedNames.add(functionName);
			nameToToolId.set(functionName, tool.id);

			const descriptionParts: string[] = [];
			if (tool.displayName && tool.displayName !== tool.toolReferenceName) {
				descriptionParts.push(tool.displayName);
			}
			if (tool.modelDescription) {
				descriptionParts.push(tool.modelDescription);
			}
			if (tool.userDescription) {
				descriptionParts.push(tool.userDescription);
			}

			const description = descriptionParts.length
				? descriptionParts.join(" ")
				: undefined;
			const parameters = tool.inputSchema ?? { type: "object", properties: {} };

			functions.push({
				type: "function",
				function: {
					name: functionName,
					description,
					parameters,
				},
			});
		}

		return {
			tools: functions,
			nameToToolId,
		};
	}

	private sanitizeToolName(
		tool: IToolData,
		index: number,
		usedNames: Set<string>,
	): string {
		const rawBase = tool.toolReferenceName ?? tool.id;
		let base = rawBase
			.replace(/[^a-zA-Z0-9_]/g, "_")
			.replace(/_{2,}/g, "_")
			.replace(/^_+/, "")
			.slice(0, 64);
		if (!base || !/^[A-Za-z]/.test(base)) {
			base = `tool_${index + 1}`;
		}

		let attempt = base;
		let counter = 1;
		while (usedNames.has(attempt)) {
			counter++;
			const suffix = `_${counter}`;
			const baseLength = Math.max(1, 64 - suffix.length);
			attempt = `${base.slice(0, baseLength)}${suffix}`;
			if (!/^[A-Za-z]/.test(attempt)) {
				attempt = `tool_${index + counter}`;
			}
		}
		return attempt;
	}

	private extractResponseContent(
		part: IChatProgressHistoryResponseContent | IChatTaskDto,
	): string | undefined {
		switch (part.kind) {
			case "markdownContent":
			case "progressMessage":
			case "warning":
				return (part.content as MarkdownString).value;
			default:
				return undefined;
		}
	}

	private async performRequest(
		messages: OpenAIMessage[],
		tools: OpenAIFunction[],
		token: CancellationToken,
		model: string,
	): Promise<ChatGPTStreamingResponse> {
		const toolNames = tools.map((f) => f.function.name);
		this.logService.debug(
			`[chatgpt] invoking model ${model} with ${messages.length} messages and tools: ${toolNames.join(", ") || "none"}`,
		);
		const response = await sendChatGPTRequest(
			this.requestService,
			this.apiKey,
			model,
			messages,
			token,
			tools.length > 0 ? { tools } : undefined,
		);
		response.result.then(
			(result) => {
				this.logService.debug(
					`[chatgpt] model returned parts: ${JSON.stringify(result.parts.map((part) => (part.toolCall ? { toolCall: { name: part.toolCall.name, argsKeys: Object.keys(part.toolCall.args ?? {}) } } : { text: part.text ?? "" })))}`,
				);
			},
			(error) => {
				this.logService.warn(
					`[chatgpt] streaming request failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		);
		return response;
	}

	private extractTextFromParts(
		parts: ChatGPTContentPart[],
		trim = true,
	): string {
		const segments: string[] = [];
		for (const part of parts) {
			if (part.text !== undefined) {
				segments.push(part.text);
			}
		}
		const text = segments.join("");
		return trim ? text.trim() : text;
	}

	private createToolInvocation(
		callId: string,
		toolId: string,
		parameters: Record<string, unknown>,
		request: IChatAgentRequest,
	): IToolInvocation {
		return {
			callId,
			toolId,
			parameters,
			context: { sessionId: request.sessionId },
			chatRequestId: request.requestId,
		};
	}

	private createToolResponse(result?: IToolResult): string {
		if (!result) {
			return JSON.stringify({
				error: localize(
					"chatgpt.toolNoResult",
					"Tool call produced no result.",
				),
			});
		}

		const response: Record<string, unknown> = {};
		const textOutput = (result.content ?? [])
			.filter((part): part is IToolResultTextPart => part.kind === "text")
			.map((part) => part.value)
			.join("\n")
			.trim();
		if (textOutput.length) {
			response["text"] = textOutput;
		}
		if (result.toolResultError) {
			response["error"] = result.toolResultError;
		}
		if (result.toolMetadata !== undefined) {
			response["metadata"] = result.toolMetadata;
		}
		if (!Object.keys(response).length) {
			response["text"] = "";
		}
		return JSON.stringify(response);
	}

	private async buildMessages(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<{
		messages: OpenAIMessage[];
		contextEntries: IContextBlockMetadata[];
	}> {
		const messages: OpenAIMessage[] = [];
		const contextPrompt = await this.buildContextPrompt(request, token);
		const contextEntries = contextPrompt?.entries ?? [];
		if (contextPrompt) {
			messages.push({ role: "user", content: contextPrompt.prompt });
		}

		for (const entry of history) {
			if (!entry) {
				continue;
			}
			const userMessage = entry.request?.message;
			if (userMessage) {
				messages.push({ role: "user", content: userMessage });
			}
			const assistantText = entry.response
				?.map((part) => this.extractResponseContent(part))
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
				.join("\n");
			if (assistantText) {
				messages.push({ role: "assistant", content: assistantText });
			}
		}

		messages.push({ role: "user", content: request.message });

		return { messages, contextEntries };
	}

	private async buildContextPrompt(
		request: IChatAgentRequest,
		token: CancellationToken,
	): Promise<IContextPromptResult | undefined> {
		const variables = request.variables?.variables ?? [];
		this.logService.debug(
			`[chatgpt] preparing context: ${variables.length} entries`,
		);
		if (!variables.length) {
			return undefined;
		}

		const blocks: string[] = [];
		const metadata: IContextBlockMetadata[] = [];
		const seen = new Set<string>();

		for (const entry of variables) {
			if (token.isCancellationRequested) {
				break;
			}
			if (seen.has(entry.id)) {
				continue;
			}
			seen.add(entry.id);

			if (isPasteVariableEntry(entry)) {
				const snippet = this.truncate(entry.code);
				if (snippet.trim().length) {
					const lang = entry.language?.toLowerCase() ?? "";
					blocks.push(
						this.formatCodeBlock(entry.name || "pasted-snippet", snippet, lang),
					);
				}
				continue;
			}

			if (isImplicitVariableEntry(entry) && entry.enabled === false) {
				continue;
			}

			if (isImplicitVariableEntry(entry) || isChatRequestFileEntry(entry)) {
				const contextBlock = await this.loadEntryContent(entry, token);
				if (contextBlock) {
					blocks.push(contextBlock.block);
					if (contextBlock.metadata) {
						metadata.push(contextBlock.metadata);
					}
				}
			}
		}

		if (!blocks.length) {
			return undefined;
		}

		this.logService.debug(
			`[chatgpt] including ${blocks.length} context blocks`,
		);
		const prompt = [
			'You are an expert coding assistant embedded in the IDE. The code blocks below are the exact context the user means -- even if they refer to them with vague terms like "this", "the file", or "the function".',
			"Ground every response in those blocks: explain behaviour, data structures, and error cases using only the provided code. Mention the relevant file or block when helpful, and if the answer cannot be derived from this context, say so explicitly before offering any speculation.",
			...blocks,
		].join("\n\n");
		return { prompt, entries: metadata };
	}

	private async loadEntryContent(
		entry: IChatRequestVariableEntry,
		token: CancellationToken,
	): Promise<{ block: string; metadata?: IContextBlockMetadata } | undefined> {
		const location = this.getLocation(entry);
		const uri = location?.uri ?? this.getUri(entry);
		if (!uri) {
			return undefined;
		}

		let reference: IReference<IResolvedTextEditorModel> | undefined;
		try {
			reference = await this.textModelService.createModelReference(uri);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const model = reference.object.textEditorModel;
			const range = location?.range ? Range.lift(location.range) : undefined;
			let text = range ? model.getValueInRange(range) : model.getValue();
			text = this.truncate(text);
			if (!text.trim().length) {
				return undefined;
			}
			const language = model.getLanguageId() ?? "";
			const label = this.getContextLabel(uri, range, entry);
			return {
				block: this.formatCodeBlock(label, text, language),
				metadata: {
					label,
					uri,
					range,
					language,
					content: text,
				},
			};
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			this.logService.warn(
				`[chatgpt] Failed to load context for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		} finally {
			reference?.dispose();
		}
	}

	private getUri(entry: IChatRequestVariableEntry): URI | undefined {
		try {
			const direct = IChatRequestVariableEntry.toUri(entry);
			if (direct) {
				return URI.isUri(direct) ? direct : URI.revive(direct as UriComponents);
			}
			const rawValue = (entry as { value?: unknown }).value;
			if (rawValue && typeof rawValue === "object") {
				const valueRecord = rawValue as Record<string, unknown>;
				const schemeValue = valueRecord["scheme"];
				if (typeof schemeValue === "string") {
					return URI.revive(valueRecord as unknown as UriComponents);
				}
				const candidate = valueRecord["uri"];
				if (candidate) {
					return URI.isUri(candidate as unknown)
						? (candidate as URI)
						: URI.revive(candidate as UriComponents);
				}
			}
		} catch (error) {
			this.logService.warn(
				`[chatgpt] Unable to resolve URI for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	}

	private getLocation(entry: IChatRequestVariableEntry): Location | undefined {
		const value = (entry as { value?: unknown }).value;
		if (value && isLocation(value)) {
			const loc = value as Location;
			const revivedUri = URI.isUri(loc.uri)
				? loc.uri
				: URI.revive(loc.uri as UriComponents);
			return {
				uri: revivedUri,
				range: Range.lift(loc.range),
			};
		}
		if (value && typeof value === "object") {
			const recordValue = value as Record<string, unknown>;
			const candidateUri = recordValue["uri"];
			const candidateRange = recordValue["range"];
			if (candidateUri && candidateRange) {
				const revivedUri = URI.isUri(candidateUri as unknown)
					? (candidateUri as URI)
					: URI.revive(candidateUri as UriComponents);
				return {
					uri: revivedUri,
					range: Range.lift(candidateRange as IRange),
				};
			}
		}
		return undefined;
	}

	private getContextLabel(
		uri: URI,
		range: Range | undefined,
		entry: IChatRequestVariableEntry,
	): string {
		const fileName = basename(uri);
		const locationText = range
			? `${range.startLineNumber}-${range.endLineNumber}`
			: undefined;
		const qualifier =
			entry.name && entry.name !== fileName ? entry.name : undefined;
		return [fileName, locationText, qualifier].filter(Boolean).join(" ");
	}

	private formatCodeBlock(
		label: string,
		content: string,
		language: string,
	): string {
		const lang = language || "";
		return `${label}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
	}

	private truncate(text: string, maxLength = 4000): string {
		if (text.length <= maxLength) {
			return text.trimEnd();
		}
		return `${text.slice(0, maxLength)}\n...[truncated]`;
	}

	private parseCodeBlocks(markdown: string): IParsedCodeBlock[] {
		const blocks: IParsedCodeBlock[] = [];
		const regex = /```([^\n]*)\n([\s\S]*?)```/g;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(markdown)) !== null) {
			const language = match[1]?.trim() ?? "";
			const content = match[2] ?? "";
			blocks.push({ language, content });
		}
		return blocks;
	}

	private findMatchingCodeBlock(
		entry: IContextBlockMetadata,
		blocks: IParsedCodeBlock[],
		used: Set<number>,
	): { block: IParsedCodeBlock; index: number } | undefined {
		let bestScore = 0;
		let bestIndex = -1;

		const anchor =
			entry.content
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "";

		for (let i = 0; i < blocks.length; i++) {
			if (used.has(i)) {
				continue;
			}
			const candidate = blocks[i];
			const candidateContent = candidate.content.trim();
			if (!candidateContent.length) {
				continue;
			}
			let score = 0;
			if (
				!entry.language ||
				!candidate.language ||
				entry.language === candidate.language
			) {
				score += 2;
			}
			if (anchor && candidateContent.includes(anchor)) {
				score += 5;
			}
			const entryFirstLine = entry.content.split("\n")[0]?.trim() ?? "";
			if (entryFirstLine && candidateContent.startsWith(entryFirstLine)) {
				score += 3;
			}
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}

		if (bestIndex === -1 && blocks.length === 1 && !used.has(0)) {
			bestIndex = 0;
		}

		if (bestIndex === -1) {
			return undefined;
		}

		used.add(bestIndex);
		return { block: blocks[bestIndex], index: bestIndex };
	}

	private async tryAutoApplyEdits(
		responseText: string,
		contextEntries: IContextBlockMetadata[],
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		if (!contextEntries.length || token.isCancellationRequested) {
			return;
		}

		const codeBlocks = this.parseCodeBlocks(responseText);
		if (!codeBlocks.length) {
			return;
		}

		const usedBlocks = new Set<number>();

		for (const entry of contextEntries) {
			if (token.isCancellationRequested) {
				return;
			}

			try {
				const match = this.findMatchingCodeBlock(entry, codeBlocks, usedBlocks);
				if (!match) {
					continue;
				}

				const newTextRaw = match.block.content;
				if (!newTextRaw.trim().length) {
					continue;
				}

				const originalTrimmed = entry.content.trim();
				const newTrimmed = newTextRaw.trim();
				if (originalTrimmed === newTrimmed) {
					continue;
				}

				const reference = await this.textModelService.createModelReference(
					entry.uri,
				);
				try {
					const model = reference.object.textEditorModel;
					const editRange = entry.range ?? model.getFullModelRange();
					const edit: TextEdit = { range: editRange, text: newTextRaw };
					progress([
						{ kind: "textEdit", uri: entry.uri, edits: [edit], done: false },
					]);
					progress([
						{ kind: "textEdit", uri: entry.uri, edits: [], done: true },
					]);
				} finally {
					reference.dispose();
				}
			} catch (error) {
				this.logService.warn(
					`[chatgpt] Failed to auto-apply edit for ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

class ChatGPTAgentContribution
	extends Disposable
	implements IWorkbenchContribution
{
	static readonly ID = "workbench.contrib.chatGPTAgent";

	// Log when class is loaded
	static {
		console.log("[chatgpt] ChatGPTAgentContribution class definition loaded");
	}

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageModelToolsService
		languageModelToolsService: ILanguageModelToolsService,
	) {
		super();

		logService.info(
			`[chatgpt] ===== ChatGPTAgentContribution constructor START =====`,
		);

		// Read API key from env (which gets userEnv from preload script)
		const apiKey = env["CHAT_GPT_API_KEY"];
		logService.info(
			`[chatgpt] Environment check: CHAT_GPT_API_KEY=${apiKey ? "present" : "missing"}, env keys available: ${
				Object.keys(env)
					.filter((k) => k.includes("GPT") || k.includes("API"))
					.join(", ") || "none"
			}`,
		);

		if (!apiKey) {
			logService.warn(
				"[chatgpt] No API key configured. Set CHAT_GPT_API_KEY environment variable.",
			);
			logService.info(
				`[chatgpt] ===== ChatGPTAgentContribution constructor END (early return - no API key) =====`,
			);
			// Don't register if no API key to avoid "No default agent" errors
			return;
		}

		logService.info(
			`[chatgpt] API key found: ${apiKey ? `present (${apiKey.length} chars, starts with ${apiKey.substring(0, 7)}...)` : "missing"}`,
		);
		logService.info(
			`[chatgpt] registering online agent using ChatGPT models (${CHATGPT_MODELS.length} models defined)`,
		);

		const agentId = "chatgpt.local";
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: "chatgpt",
			fullName: localize("chatgpt.agent.name", "ChatGPT"),
			description: localize(
				"chatgpt.agent.description",
				"Use ChatGPT online models.",
			),
			isCore: true,
			isDefault: false,
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{
					name: "explain",
					description: localize(
						"chatgpt.command.explain",
						"Explain the current selection.",
					),
					when: undefined,
				},
				{
					name: "review",
					description: localize(
						"chatgpt.command.review",
						"Review the shown changes.",
					),
					when: undefined,
				},
			],
			metadata: {
				followupPlaceholder: localize(
					"chatgpt.followup.placeholder",
					"Ask ChatGPT...",
				),
				additionalWelcomeMessage: localize(
					"chatgpt.welcome",
					"ChatGPT is ready.",
				),
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier("core.chatgpt"),
			extensionVersion: "0.0.0",
			extensionPublisherId: "core",
			extensionDisplayName: "Core",
		});
		this._register(registration);

		const implementation = new ChatGPTAgentImplementation(
			this.requestService,
			apiKey,
			logService,
			textModelService,
			languageModelToolsService,
			languageModelsService,
		);
		this._register(
			this.chatAgentService.registerAgentImplementation(
				agentId,
				implementation,
			),
		);

		const enabledKey = contextKeyService.createKey(
			ChatContextKeys.enabled.key,
			true,
		);
		const panelRegisteredKey = contextKeyService.createKey(
			ChatContextKeys.panelParticipantRegistered.key,
			true,
		);
		const extensionRegisteredKey = contextKeyService.createKey(
			ChatContextKeys.extensionParticipantRegistered.key,
			true,
		);
		this._register(
			toDisposable(() => {
				enabledKey.reset();
				panelRegisteredKey.reset();
				extensionRegisteredKey.reset();
			}),
		);

		const vendor = "openai";
		const provider: ILanguageModelChatProvider = {
			onDidChange: Event.None,
			async provideLanguageModelChatInfo(
				options,
				token,
			): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
				logService.info(
					`[chatgpt] provideLanguageModelChatInfo called: silent=${options.silent}, token cancelled=${token.isCancellationRequested}`,
				);
				try {
					const models = CHATGPT_MODELS.map((modelConfig) => ({
						identifier: modelConfig.identifier,
						metadata: {
							extension: new ExtensionIdentifier("core.chatgpt"),
							name: modelConfig.name,
							id: modelConfig.identifier,
							vendor,
							version: "1.0.0",
							family: "gpt",
							detail: modelConfig.description,
							maxInputTokens: modelConfig.maxInputTokens,
							maxOutputTokens: modelConfig.maxOutputTokens,
							modelPickerCategory: { label: "OpenAI Models", order: 1 },
							isDefault: modelConfig.isDefault,
							isUserSelectable: true,
							capabilities: { agentMode: true, toolCalling: true },
						},
					}));
					logService.info(
						`[chatgpt] provideLanguageModelChatInfo returning ${models.length} models: ${models.map((m) => m.identifier).join(", ")}`,
					);
					return models;
				} catch (error) {
					logService.error(
						`[chatgpt] Error in provideLanguageModelChatInfo:`,
						error,
					);
					throw error;
				}
			},
			async sendChatRequest(modelId, messages, _from, _options, token) {
				logService.info(
					`[chatgpt] sendChatRequest called: modelId=${modelId}, messages=${messages.length}, apiKey present=${!!apiKey}, apiKey length=${apiKey?.length || 0}`,
				);
				const selectedModelConfig = CHATGPT_MODELS.find(
					(m) => m.identifier === modelId,
				);
				const modelToUse =
					selectedModelConfig?.id ||
					CHATGPT_MODELS.find((m) => m.isDefault)?.id ||
					"gpt-5-nano-2025-08-07";
				logService.info(
					`[chatgpt] Resolved model to use: ${modelToUse} (from identifier ${modelId})`,
				);
				try {
					const response = await sendChatGPTRequest(
						requestService,
						apiKey,
						modelToUse,
						toChatGPTMessages(messages),
						token,
					);
					logService.info(
						`[chatgpt] sendChatRequest succeeded for model ${modelToUse}`,
					);
					let sawText = false;
					let functionCallName: string | undefined;

					const stream = (async function* (): AsyncIterable<
						IChatResponsePart | IChatResponsePart[]
					> {
						for await (const chunk of response.stream) {
							if (token.isCancellationRequested) {
								break;
							}
							const chatParts: IChatResponsePart[] = [];
							for (const part of chunk) {
								if (part.text !== undefined && part.text.length > 0) {
									sawText = true;
									chatParts.push({ type: "text", value: part.text });
								} else if (part.toolCall !== undefined) {
									functionCallName = part.toolCall.name;
								}
							}
							if (chatParts.length === 1) {
								yield chatParts[0];
							} else if (chatParts.length > 1) {
								yield chatParts;
							}
						}
						if (
							!sawText &&
							functionCallName &&
							!token.isCancellationRequested
						) {
							yield {
								type: "text",
								value: localize(
									"chatgpt.provider.functionCall",
									"ChatGPT wants to run tool {0}, but tools are only available in agent mode. Retry there or disable tool usage.",
									functionCallName,
								),
							};
						}
					})();

					return {
						stream,
						result: response.result
							.then((): IChatAgentResult => {
								logService.info(
									`[chatgpt] Request completed successfully for model ${modelToUse}`,
								);
								return {
									details: "chatgpt-response",
									metadata: { model: modelToUse },
								};
							})
							.catch((error) => {
								logService.error(
									`[chatgpt] Request failed for model ${modelToUse}:`,
									error,
								);
								throw error;
							}),
					};
				} catch (error) {
					logService.error(
						`[chatgpt] Error in sendChatRequest for model ${modelToUse}:`,
						error,
					);
					throw error;
				}
			},
			async provideTokenCount(_modelId, message, _token) {
				if (typeof message === "string") {
					return message.length;
				}
				return reduceMessageParts(message).length;
			},
		};
		logService.info(
			`[chatgpt] Registering language model provider for vendor: ${vendor}`,
		);
		const registrationDisposable =
			languageModelsService.registerLanguageModelProvider(vendor, provider);
		this._register(registrationDisposable);
		logService.info(
			`[chatgpt] Language model provider registered successfully for vendor: ${vendor}`,
		);
		logService.info(
			`[chatgpt] ===== ChatGPTAgentContribution constructor END (success) =====`,
		);
	}
}

console.log(
	"[chatgpt] About to register ChatGPTAgentContribution with ID:",
	ChatGPTAgentContribution.ID,
);
registerWorkbenchContribution2(
	ChatGPTAgentContribution.ID,
	ChatGPTAgentContribution,
	WorkbenchPhase.AfterRestored,
);
console.log("[chatgpt] ChatGPTAgentContribution registration call completed");
