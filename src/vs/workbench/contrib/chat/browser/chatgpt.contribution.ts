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
	IChatMessagePart,
	ChatMessageRole,
} from "../common/languageModels.js";
import {
	ILanguageModelToolsService,
	IToolData,
	CountTokensCallback,
	IToolInvocation,
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
import { ISecretStorageService } from "../../../../platform/secrets/common/secrets.js";

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

interface ServerToolResult {
	readonly toolCallId: string;
	readonly content: Array<{ type: "text"; value: string }>;
}

interface ServerRequestOptions {
	readonly context?: string;
	readonly modelName?: string;
	readonly tools?: Array<{
		name: string;
		description?: string;
		parameters?: unknown;
	}>;
	readonly toolResults?: ServerToolResult[];
}

interface IDEStreamPart {
	readonly type: "text" | "finish" | "tool_use" | "error";
	readonly value?: string;
	readonly finishReason?: string;
	readonly name?: string;
	readonly toolCallId?: string;
	readonly parameters?: Record<string, unknown>;
	readonly message?: string;
}

async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: "/api/agent/tools",
	messages: IChatMessage[],
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
): Promise<ChatGPTStreamingResponse> {
	const url = `${serverAddress}${endpoint}`;

	if (!accessToken) {
		throw new Error(
			localize(
				"chatgpt.noAuthToken",
				"Authentication token is missing. Please sign in to use ChatGPT.",
			),
		);
	}

	const payload: Record<string, unknown> = {
		model: "openai",
		messages: messages,
	};

	if (options?.context) {
		payload["context"] = options.context;
	}
	if (options?.modelName) {
		payload["modelName"] = options.modelName;
	}
	// Tools endpoint requires tools array (even if empty, but server validates min 1)
	// Always include tools if provided (for /api/agent/tools endpoint)
	if (options?.tools !== undefined) {
		payload["tools"] = options.tools;
	}
	if (options?.toolResults && options.toolResults.length > 0) {
		payload["toolResults"] = options.toolResults;
	}

	const body = JSON.stringify(payload);

	logService?.info(
		`[chatgpt-server] Sending request to ${url}`,
	);
	logService?.debug(
		`[chatgpt-server] Request payload: model=${payload.model}, messages=${messages.length}, tools=${options?.tools?.length || 0}, toolResults=${options?.toolResults?.length || 0}`,
	);
	logService?.debug(
		`[chatgpt-server] Auth token present: ${!!accessToken}`,
	);

	const context = await requestService.request(
		{
			type: "POST",
			url,
			data: body,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				Accept: "text/event-stream",
			},
		},
		token,
	);

	if (!isSuccess(context)) {
		logService?.error(
			`[chatgpt-server] Request failed with status ${context.res.statusCode}`,
		);
		const buffer = await streamToBuffer(context.stream);
		const errorText = buffer.toString();
		let errorMessage = `Server error: ${context.res.statusCode}`;
		try {
			const errorJson = JSON.parse(errorText);
			if (errorJson.error?.message) {
				errorMessage = errorJson.error.message;
			} else if (errorJson.message) {
				errorMessage = errorJson.message;
			}
		} catch {
			if (errorText) {
				errorMessage += ` - ${errorText}`;
			}
		}
		logService?.error(
			`[chatgpt-server] Error details: ${errorMessage}`,
		);
		throw new Error(errorMessage);
	}

	logService?.info(
		`[chatgpt-server] Request successful, starting SSE stream parsing`,
	);

	const stream = new AsyncIterableSource<ChatGPTContentPart[]>();
	const deferred = new DeferredPromise<ChatGPTResponse>();
	const aggregatedParts: ChatGPTContentPart[] = [];
	const textAccumulator: string[] = [];
	let finishReason: string | null | undefined;
	let usage: unknown;
	let streamCompleted = false;
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
			// Check for empty response
			if (
				!aggregatedParts.length &&
				textAccumulator.length === 0
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
			const toolCallCountInFinal = aggregatedParts.filter(p => p.toolCall !== undefined).length;
			logService?.info(
				`[chatgpt-server] Finalizing response: ${aggregatedParts.length} total parts, ${toolCallCountInFinal} tool call(s)`,
			);
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
			logService?.debug(
				`[chatgpt-server] Received [DONE] marker, finalizing stream`,
			);
			finalizeSuccess();
			return;
		}

		let parsedParts: IDEStreamPart[];
		try {
			parsedParts = JSON.parse(rawData) as IDEStreamPart[];
			if (!Array.isArray(parsedParts)) {
				// Handle single part (not wrapped in array)
				parsedParts = [parsedParts as IDEStreamPart];
			}
			logService?.trace(
				`[chatgpt-server] Parsed ${parsedParts.length} IDE stream part(s)`,
			);
		} catch (error) {
			logService?.error(
				`[chatgpt-server] SSE chunk parse failure: ${error instanceof Error ? error.message : String(error)}`,
			);
			const err = new Error(
				`Streaming chunk parse failure: ${error instanceof Error ? error.message : String(error)}`,
			);
			finalizeError(err);
			return;
		}

		const newParts: ChatGPTContentPart[] = [];

		for (const part of parsedParts) {
			switch (part.type) {
				case "text":
					if (part.value !== undefined && part.value.length > 0) {
						textAccumulator.push(part.value);
						newParts.push({ text: part.value });
						logService?.trace(
							`[chatgpt-server] Received text part (length: ${part.value.length})`,
						);
					}
					break;

				case "finish":
					if (part.finishReason !== undefined) {
						finishReason = finishReason ?? part.finishReason;
						logService?.debug(
							`[chatgpt-server] Received finish part: ${part.finishReason}`,
						);
					}
					break;

				case "tool_use":
					if (part.name && part.toolCallId && part.parameters !== undefined) {
						// Tool calls are complete in IDE format, emit immediately
						const toolCallPart = {
							toolCall: {
								id: part.toolCallId,
								name: part.name,
								args: part.parameters as Record<string, unknown>,
							},
						};
						newParts.push(toolCallPart);
						logService?.info(
							`[chatgpt-server] Received tool_use part: ${part.name} (id: ${part.toolCallId}), parameters: ${JSON.stringify(Object.keys(part.parameters))}`,
						);
					} else {
						logService?.warn(
							`[chatgpt-server] Received incomplete tool_use part: name=${part.name}, toolCallId=${part.toolCallId}, parameters=${part.parameters !== undefined}`,
						);
					}
					break;

				case "error": {
					logService?.error(
						`[chatgpt-server] Received error part: ${part.message || "Unknown error"}`,
					);
					const err = new Error(part.message || "Streaming error");
					finalizeError(err);
					return;
				}

				default:
					logService?.warn(
						`[chatgpt-server] Unknown part type: ${(part as IDEStreamPart).type}`,
					);
					break;
			}
		}

		if (newParts.length) {
			const toolCallCount = newParts.filter(p => p.toolCall !== undefined).length;
			if (toolCallCount > 0) {
				logService?.info(
					`[chatgpt-server] Adding ${toolCallCount} tool call(s) to aggregatedParts (total parts now: ${aggregatedParts.length + newParts.length})`,
				);
			}
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


class ChatGPTAgentImplementation implements IChatAgentImplementation {
	private readonly requestTools = new Map<string, UserSelectedTools>();
	private readonly fallbackCountTokens: CountTokensCallback = async (
		input: string,
		_token: CancellationToken,
	) => input.length;

	constructor(
		private readonly requestService: IRequestService,
		private readonly serverAddress: string,
		private readonly secretStorageService: ISecretStorageService,
		private readonly logService: ILogService,
		private readonly textModelService: ITextModelService,
		private readonly languageModelToolsService: ILanguageModelToolsService,
		private readonly languageModelsService: ILanguageModelsService,
	) { }

	private async getAccessToken(): Promise<string | undefined> {
		try {
			const token = await this.secretStorageService.get("ren.auth.accessToken");
			if (token) {
				this.logService.debug(
					`[chatgpt-server] Access token retrieved successfully (length: ${token.length})`,
				);
			} else {
				this.logService.warn(
					`[chatgpt-server] No access token found in secret storage. User needs to authenticate.`,
				);
			}
			return token ?? undefined;
		} catch (error) {
			this.logService.error(
				`[chatgpt-server] Error retrieving access token: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

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

		// Build context prompt for first request
		const contextPrompt = await this.buildContextPrompt(request, token);
		const contextString = contextPrompt?.prompt;

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
		let toolResults: ServerToolResult[] | undefined = undefined;

		try {
			while (iteration < maxIterations) {
				if (token.isCancellationRequested) {
					return { details: "cancelled" };
				}

				this.logService.info(
					`[chatgpt-server] invoke iteration ${iteration + 1}/${maxIterations}`,
				);

				const streamingResponse = await this.performRequest(
					messages,
					toolConfigs,
					token,
					modelToUse,
					contextString,
					toolResults,
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

				this.logService.info(
					`[chatgpt-server] Response received: ${responseParts.length} parts total`,
				);
				this.logService.debug(
					`[chatgpt-server] Response parts breakdown: text=${responseParts.filter(p => p.text !== undefined).length}, toolCall=${responseParts.filter(p => p.toolCall !== undefined).length}`,
				);

				// Extract text and tool calls from response
				const textParts = responseParts.filter(
					(part) => part.text !== undefined,
				);
				const toolCallParts = responseParts.filter(
					(part) => part.toolCall !== undefined,
				);

				this.logService.info(
					`[chatgpt-server] Filtered tool calls: ${toolCallParts.length} tool call(s) found`,
				);
				if (toolCallParts.length > 0) {
					this.logService.debug(
						`[chatgpt-server] Tool calls: ${JSON.stringify(toolCallParts.map(p => ({ name: p.toolCall?.name, id: p.toolCall?.id })))}`,
					);
				}

				// Add assistant message with text
				if (textParts.length > 0) {
					const textContent = textParts.map((part) => part.text || "").join("");
					if (textContent.trim().length) {
						messages.push({ role: "assistant", content: textContent });
					}
				}

				// Handle tool calls
				if (toolCallParts.length > 0) {
					// Add assistant message with tool calls so the next request has proper ordering
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

					// Execute tool calls and collect server-format results
					const toolResultsForNextRequest: ServerToolResult[] = [];

					for (const callPart of toolCallParts) {
						if (token.isCancellationRequested) {
							return { details: "cancelled" };
						}

						const toolName = callPart.toolCall!.name;
						this.logService.info(
							`[chatgpt-server] Looking up tool name "${toolName}" in nameToToolId map`,
						);
						this.logService.debug(
							`[chatgpt-server] Available tool names in map: ${Array.from(nameToToolId.keys()).join(", ")}`,
						);
						const toolId = nameToToolId.get(toolName);
						if (!toolId) {
							this.logService.error(
								`[chatgpt-server] model requested unknown tool name "${toolName}". Available names: ${Array.from(nameToToolId.keys()).join(", ")}`,
							);
							// Create server-format error tool result
							toolResultsForNextRequest.push({
								toolCallId: callPart.toolCall!.id,
								content: [{
									type: "text", value: localize(
										"chatgpt.unknownToolCall",
										"ChatGPT requested unknown tool {0}.",
										toolName,
									)
								}],
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
						this.logService.info(
							`[chatgpt-server] invoking tool ${toolId} (${toolName}) with params keys: ${Object.keys(parameters).join(", ")}`,
						);

						try {
							const result = await this.languageModelToolsService.invokeTool(
								invocation,
								this.fallbackCountTokens,
								token,
							);
							this.logService.info(
								`[chatgpt-server] tool ${toolId} completed successfully`,
							);
							// Convert to server-format tool result
							const textOutput = (result.content ?? [])
								.filter((part): part is IToolResultTextPart => part.kind === "text")
								.map((part) => part.value)
								.join("\n");
							toolResultsForNextRequest.push({
								toolCallId: callId,
								content: [{ type: "text", value: textOutput }],
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							this.logService.error(
								`[chatgpt-server] tool ${toolId} failed: ${message}`,
							);
							// Create server-format error tool result
							toolResultsForNextRequest.push({
								toolCallId: callId,
								content: [{ type: "text", value: message }],
							});
						}
					}

					if (toolResultsForNextRequest.length === 0) {
						throw new Error(
							localize(
								"chatgpt.noToolResponses",
								"ChatGPT requested tool calls but no responses were produced.",
							),
						);
					}

					// Set server-format tool results for next iteration
					toolResults = toolResultsForNextRequest;
					this.logService.info(
						`[chatgpt-server] Collected ${toolResults.length} tool results for next request`,
					);

					// Do not embed tool results in messages; send via toolResults next
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

				// Reset tool results for next request
				toolResults = undefined;

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

				this.logService.info(
					`[chatgpt-server] Request completed successfully`,
				);

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
			let userMessage = message;

			// Provide user-friendly messages for common errors
			if (message.includes("Authentication token is missing") || message.includes("noAuthToken")) {
				userMessage = localize(
					"chatgpt.authRequired",
					"Please sign in to use ChatGPT. Authentication is required.",
				);
			} else if (message.includes("SERVER_ADDRESS") || message.includes("server address")) {
				userMessage = localize(
					"chatgpt.serverAddressMissing",
					"Server address is not configured. Please set SERVER_ADDRESS environment variable.",
				);
			} else if (message.includes("401") || message.includes("Unauthorized")) {
				userMessage = localize(
					"chatgpt.unauthorized",
					"Authentication failed. Please sign in again.",
				);
			} else if (message.includes("403") || message.includes("Forbidden")) {
				userMessage = localize(
					"chatgpt.forbidden",
					"Access forbidden. Please check your permissions.",
				);
			} else if (message.includes("Network") || message.includes("fetch") || message.includes("ECONNREFUSED")) {
				userMessage = localize(
					"chatgpt.networkError",
					"Network error. Please check your connection and server address.",
				);
			}

			this.logService.error(`[chatgpt-server] Request failed: ${message}`);

			const markdown = new MarkdownString(
				localize("chatgpt.error", "ChatGPT request failed: {0}", userMessage),
			);
			markdown.isTrusted = true;
			progress([{ kind: "markdownContent", content: markdown }]);

			return {
				errorDetails: {
					message: userMessage,
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
			// No tools explicitly selected - return ALL registered tools (like Gemini)
			const allTools = Array.from(this.languageModelToolsService.getTools());
			this.logService.debug(
				`[chatgpt] no tools selected for request ${requestId}, using all ${allTools.length} registered tools`,
			);
			return allTools;
		}
		const allowedIds = Object.keys(selected).filter(
			(id) => selected[id] === true,
		);
		if (!allowedIds.length) {
			// Tools selected but none enabled - return ALL registered tools (like Gemini)
			const allTools = Array.from(this.languageModelToolsService.getTools());
			this.logService.debug(
				`[chatgpt] tool selection for request ${requestId} contained no enabled entries, using all ${allTools.length} registered tools`,
			);
			return allTools;
		}
		// Filter to only selected tools
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

	private convertOpenAIMessagesToIDE(messages: OpenAIMessage[]): IChatMessage[] {
		const ideMessages: IChatMessage[] = [];
		for (const msg of messages) {
			let role: ChatMessageRole;
			switch (msg.role) {
				case "system":
					role = ChatMessageRole.System;
					break;
				case "user":
					role = ChatMessageRole.User;
					break;
				case "assistant":
					role = ChatMessageRole.Assistant;
					break;
				case "tool":
					// Tool messages are not directly supported in IChatMessage
					// They should be converted to tool_result parts
					// For now, skip tool messages or handle separately
					continue;
				default:
					continue;
			}

			const content: IChatMessagePart[] = [];
			if (msg.content !== null && msg.content !== undefined) {
				content.push({ type: "text", value: msg.content });
			}

			// Include tool calls so the following toolResults are valid against provider ordering
			if (msg.tool_calls && msg.tool_calls.length > 0) {
				for (const toolCall of msg.tool_calls) {
					try {
						const args = JSON.parse(toolCall.function.arguments || "{}");
						content.push({
							type: "tool_use",
							name: toolCall.function.name,
							toolCallId: toolCall.id,
							parameters: args,
						});
					} catch {
						// Skip invalid tool calls
					}
				}
			}

			if (content.length > 0) {
				ideMessages.push({ role, content });
			}
		}
		return ideMessages;
	}

	private async performRequest(
		messages: OpenAIMessage[],
		tools: OpenAIFunction[],
		token: CancellationToken,
		model: string,
		context?: string,
		toolResults?: ServerToolResult[],
	): Promise<ChatGPTStreamingResponse> {
		const toolNames = tools.map((f) => f.function.name);
		this.logService.info(
			`[chatgpt-server] performRequest: model=${model}, messages=${messages.length}, tools=${toolNames.join(", ") || "none"}, hasContext=${!!context}, toolResults=${toolResults?.length || 0}`,
		);

		// Get access token
		const accessToken = await this.getAccessToken();
		if (!accessToken) {
			throw new Error(
				localize(
					"chatgpt.noAuthToken",
					"Authentication token is missing. Please sign in to use ChatGPT.",
				),
			);
		}

		// Convert messages to IDE format
		const ideMessages = this.convertOpenAIMessagesToIDE(messages);

		// Convert tools to server format
		const serverTools = tools.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
		}));

		// Always use /api/agent/tools endpoint (never use /api/agent/chat)
		const endpoint: "/api/agent/tools" = "/api/agent/tools";
		const hasToolResults = toolResults && toolResults.length > 0;

		this.logService.info(
			`[chatgpt-server] Using endpoint: ${endpoint} (tools=${serverTools.length}, toolResults=${toolResults?.length || 0})`,
		);
		this.logService.debug(
			`[chatgpt-server] Tools being sent: ${serverTools.map((t) => t.name).join(", ") || "none"}`,
		);

		// Always send tools (should always have at least one from getAllowedToolData)
		const toolsToSend = serverTools;

		const response = await sendChatGPTRequest(
			this.requestService,
			accessToken,
			this.serverAddress,
			endpoint,
			ideMessages,
			token,
			{
				context,
				modelName: model,
				// Always send tools (required for /api/agent/tools endpoint)
				tools: toolsToSend,
				toolResults: hasToolResults ? toolResults : undefined,
			},
			this.logService,
		);

		response.result.then(
			(result) => {
				this.logService.info(
					`[chatgpt-server] Request completed: ${result.parts.length} parts, finishReason=${result.finishReason || "none"}`,
				);
				this.logService.debug(
					`[chatgpt-server] Response parts: ${JSON.stringify(result.parts.map((part) => (part.toolCall ? { toolCall: { name: part.toolCall.name, argsKeys: Object.keys(part.toolCall.args ?? {}) } } : { text: part.text?.substring(0, 50) ?? "" })))}`,
				);
			},
			(error) => {
				this.logService.error(
					`[chatgpt-server] Streaming request failed: ${error instanceof Error ? error.message : String(error)}`,
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

	// Removed legacy tool response builder; server expects toolResults array

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
	implements IWorkbenchContribution {
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
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();

		logService.info(
			`[chatgpt-server] ===== ChatGPTAgentContribution constructor START =====`,
		);

		// Read SERVER_ADDRESS from env (which gets userEnv from preload script)
		const serverAddress = env["SERVER_ADDRESS"];
		logService.info(
			`[chatgpt-server] Environment check: SERVER_ADDRESS=${serverAddress ? "present" : "missing"}, env keys available: ${Object.keys(env)
				.filter((k) => k.includes("SERVER") || k.includes("ADDRESS"))
				.join(", ") || "none"
			}`,
		);

		if (!serverAddress) {
			logService.warn(
				"[chatgpt-server] No server address configured. Set SERVER_ADDRESS environment variable.",
			);
			logService.info(
				`[chatgpt-server] ===== ChatGPTAgentContribution constructor END (early return - no server address) =====`,
			);
			// Don't register if no server address to avoid "No default agent" errors
			return;
		}

		// Validate SERVER_ADDRESS format
		let normalizedServerAddress = serverAddress.trim();
		if (!normalizedServerAddress.startsWith("http://") && !normalizedServerAddress.startsWith("https://")) {
			logService.warn(
				`[chatgpt-server] SERVER_ADDRESS missing protocol, assuming https://. Original: ${normalizedServerAddress}`,
			);
			normalizedServerAddress = `https://${normalizedServerAddress}`;
		}
		// Remove trailing slash
		normalizedServerAddress = normalizedServerAddress.replace(/\/+$/, "");

		logService.info(
			`[chatgpt-server] Server address found: ${normalizedServerAddress}`,
		);
		logService.info(
			`[chatgpt-server] registering online agent using ChatGPT models (${CHATGPT_MODELS.length} models defined)`,
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
			normalizedServerAddress,
			this.secretStorageService,
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
				throw new Error('OpenAI models must run in agent mode. Use ChatGPT agent.');
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
