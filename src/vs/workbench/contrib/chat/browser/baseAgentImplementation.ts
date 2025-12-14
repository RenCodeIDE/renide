/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../base/common/cancellation.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";
import { localize } from "../../../../nls.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { ExtensionIdentifier } from "../../../../platform/extensions/common/extensions.js";
import {
	IChatAgentImplementation,
	IChatAgentHistoryEntry,
	IChatAgentRequest,
	IChatAgentResult,
	UserSelectedTools,
	IChatAgentService,
} from "../common/chatAgents.js";
import { ChatMode } from "../common/chatModes.js";
import { ChatModeKind, validateChatMode } from "../common/constants.js";
import { ChatErrorLevel, IChatProgress } from "../common/chatService.js";
import {
	ILanguageModelsService,
	IChatMessage,
	ChatMessageRole,
} from "../common/languageModels.js";
import {
	ILanguageModelToolsService,
	IToolData,
	CountTokensCallback,
	IToolInvocation,
	IToolResultTextPart,
	ISmartToolContext,
} from "../common/languageModelToolsService.js";
import { IRequestService } from "../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../platform/secrets/common/secrets.js";
import { ITextModelService } from "../../../../editor/common/services/resolverService.js";
import { hasKey } from "../../../../base/common/types.js";
// @ts-ignore - Module resolution error is false positive, files exist
import type {
	ServerToolResult,
	ChatGPTStreamingResponse,
} from "./chatgpt/types.js";
// @ts-ignore - Module resolution error is false positive, files exist
import { validateIDEFormat } from "./chatgpt/validation.js";
// @ts-ignore - Module resolution error is false positive, files exist
import { sendChatGPTRequest } from "./chatgpt/request.js";
import { extractTextFromParts, extractResponseContent, extractThinkingContent } from "./deepseek/utils.js"; // Reuse existing utils or move to common? Reuse for now.
import {
	ContextBuilder,
	type IContextBlockMetadata,
} from "../common/contextBuilder.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { IMetricsService } from "../../../services/metrics/common/metricsService.js";
import {
	AuthenticationHelper,
	ChatConfigurationService,
} from "../common/chatUtilities.js";
import { IToolContextResolverService } from "./toolContextResolverService.js";

export interface IBaseAgentConfig {
	vendorId: string; // e.g. "deepseek", "claude", "gemini"
	logPrefix: string; // e.g. "[deepseek-server]"
	defaultModelId?: string; // e.g. "deepseek-chat"
}

export abstract class BaseAgentImplementation implements IChatAgentImplementation {
	private readonly requestTools = new Map<string, UserSelectedTools>();
	protected readonly fallbackCountTokens: CountTokensCallback = async (
		input: string,
		_token: CancellationToken
	) => input.length;
	protected readonly contextBuilder: ContextBuilder;
	protected readonly authHelper: AuthenticationHelper;
	protected readonly chatConfig: ChatConfigurationService;

	constructor(
		protected readonly config: IBaseAgentConfig,
		protected readonly requestService: IRequestService,
		protected readonly serverAddress: string,
		protected readonly secretStorageService: ISecretStorageService,
		protected readonly logService: ILogService,
		textModelService: ITextModelService,
		protected readonly languageModelToolsService: ILanguageModelToolsService,
		protected readonly languageModelsService: ILanguageModelsService,
		protected readonly chatAgentService: IChatAgentService,
		protected readonly configurationService: IConfigurationService,
		languageFeaturesService?: ILanguageFeaturesService,
		protected readonly metricsService?: IMetricsService,
		protected readonly toolContextResolverService?: IToolContextResolverService
	) {
		this.contextBuilder = new ContextBuilder(
			textModelService,
			logService,
			languageFeaturesService
		);
		// Initialize utilities
		this.authHelper = new AuthenticationHelper(
			secretStorageService,
			logService,
			config.logPrefix
		);
		this.chatConfig = new ChatConfigurationService(configurationService);
	}

	protected abstract getModels(): Array<{ id: string; identifier: string; isDefault?: boolean; maxOutputTokens?: number }>;

	protected async getAccessToken(): Promise<string | undefined> {
		return this.authHelper.getAccessToken();
	}

	protected resolveModelFromRequest(userSelectedModelId?: string): string {
		const models = this.getModels();
		if (userSelectedModelId) {
			const selectedModelConfig = models.find(
				(m) => m.identifier === userSelectedModelId
			);
			if (selectedModelConfig) {
				return selectedModelConfig.id;
			}
		}
		const defaultModel = models.find((m) => m.isDefault);
		return defaultModel?.id || this.config.defaultModelId || models[0]?.id;
	}



	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatAgentResult> {
		if (token.isCancellationRequested) {
			return { details: "cancelled" };
		}

		// Check if user selected a model from a different vendor
		if (request.userSelectedModelId) {
			const selectedModelMetadata =
				this.languageModelsService.lookupLanguageModel(
					request.userSelectedModelId
				);
			// If the model ID contains vendorId, handle it locally regardless of vendor metadata
			if (request.userSelectedModelId.includes(this.config.vendorId)) {
				// This is a local model, handle it locally
				this.logService.info(`${this.config.logPrefix} Handling model locally: ${request.userSelectedModelId}`);
			} else if (selectedModelMetadata && selectedModelMetadata.vendor !== this.config.vendorId) {
				// Route to appropriate agent based on vendor
				if (
					selectedModelMetadata.vendor === "openai" ||
					request.userSelectedModelId.startsWith("openai/")
				) {
					return this.chatAgentService.invokeAgent(
						"chatgpt.local",
						request,
						progress,
						history,
						token
					);
				}
				if (
					selectedModelMetadata.vendor === "claude" ||
					request.userSelectedModelId.startsWith("anthropic/")
				) {
					return this.chatAgentService.invokeAgent(
						"claude.local",
						request,
						progress,
						history,
						token
					);
				}
				if (
					selectedModelMetadata.vendor === "gemini" ||
					request.userSelectedModelId.startsWith("google/")
				) {
					return this.chatAgentService.invokeAgent(
						"gemini.local",
						request,
						progress,
						history,
						token
					);
				}
				if (
					selectedModelMetadata.vendor === "deepseek" ||
					request.userSelectedModelId.startsWith("deepseek/")
				) {
					return this.chatAgentService.invokeAgent(
						"deepseek.local",
						request,
						progress,
						history,
						token
					);
				}
				// Otherwise, delegate to language models service for cross-vendor model
				return this.invokeViaLanguageModelsService(
					request,
					progress,
					history,
					token,
					request.userSelectedModelId
				);
			}
		}

		// Resolve the model to use from request
		const modelToUse = this.resolveModelFromRequest(
			request.userSelectedModelId
		);

		// Read tools from request object first
		if (request.userSelectedTools) {
			this.logService.debug(
				`[${this.config.vendorId}] reading tools from request object for request ${request.requestId
				}: ${JSON.stringify(request.userSelectedTools)}`
			);
			this.requestTools.set(request.requestId, request.userSelectedTools);
		}

		const { messages, contextEntries } = await this.buildMessages(
			request,
			history,
			token
		);
		const {
			tools: toolConfigs,
			nameToToolId,
			summaries,
		} = this.buildToolDeclarations(request.requestId, validateChatMode(request.chatMode) || ChatModeKind.Agent);

		// Check if a different model might be better for this task
		const toolIds = Array.from(nameToToolId.values());
		const modelRecommendation = this.getModelRecommendation(
			request.message,
			request.userSelectedModelId,
			toolIds
		);

		// Show recommendation as a helpful note (only for high confidence suggestions)
		if (modelRecommendation && modelRecommendation.confidence >= 0.7) {
			const suggestionMarkdown = new MarkdownString(
				`💡 *Tip: ${modelRecommendation.model} might work better for this task* — ${modelRecommendation.reason}\n\n`
			);
			suggestionMarkdown.isTrusted = true;
			progress([{ kind: "markdownContent", content: suggestionMarkdown }]);
		}

		// Inject Plan mode instructions
		if (request.chatMode === ChatModeKind.Plan) {
			const instructions = ChatMode.Plan.modeInstructions?.get();
			if (instructions) {
				messages.push({
					role: ChatMessageRole.System,
					content: [
						{
							type: "text",
							value:
								instructions.content +
								"\n\nIMPORTANT: Never write plan content in chat messages. Always use the writePlan tool to create/update the .plan.md file. Reference the file path in chat instead of duplicating content.",
						},
					],
				});
			}
		}

		if (summaries.length) {
			// Build an enhanced system prompt that encourages proactive tool usage
			const agenticPrompt = this.buildAgenticSystemPrompt(summaries, validateChatMode(request.chatMode));
			messages.push({
				role: ChatMessageRole.System,
				content: [
					{
						type: "text",
						value: agenticPrompt,
					},
				],
			});
		}

		const maxIterations = this.chatConfig.getMaxIterations();
		let iteration = 0;
		let pendingToolResults: ServerToolResult[] | undefined = undefined;
		const conversationToolResults = new Map<string, ServerToolResult>();
		const requestStartTime = Date.now();

		try {
			while (iteration < maxIterations) {
				if (token.isCancellationRequested) {
					return { details: "cancelled" };
				}

				if (pendingToolResults && pendingToolResults.length > 0) {
					for (const result of pendingToolResults) {
						conversationToolResults.set(result.toolCallId, result);
					}
					const ids = pendingToolResults
						.map((result) => result.toolCallId)
						.join(", ");
					this.logService.info(
						`${this.config.logPrefix} Added ${pendingToolResults.length} tool result(s) to conversation history: ${ids}`
					);
					pendingToolResults = undefined;
				}

				if (conversationToolResults.size > 0) {
					const ids = Array.from(conversationToolResults.values())
						.map((result) => result.toolCallId)
						.join(", ");
					this.logService.info(
						`${this.config.logPrefix} Forwarding ${conversationToolResults.size} total tool result(s) to server: ${ids}`
					);
				}

				const toolResultsForServer =
					conversationToolResults.size > 0
						? Array.from(conversationToolResults.values())
						: undefined;


				const projectId = await this.metricsService?.getProjectIdAsync();
				const streamingResponse = await this.performRequest(
					messages,
					toolConfigs,
					token,
					modelToUse,
					toolResultsForServer,
					request.chatMode,
					request.sessionId,
					projectId
				);
				let streamedText = false;

				try {
					for await (const chunk of streamingResponse.stream) {
						if (token.isCancellationRequested) {
							break;
						}

						// Handle streaming format differences if necessary
						// DeepSeek, Claude, and Gemini agents all currently consume the same normalized IDEStreamPart format
						// which is what sendChatGPTRequest returns (after transformers on server)
						// However, the BaseAgent implementation below assumes the generic format:

						// Map generic parts to something we can process
						// Note: formatting might differ slightly per agent if they did custom processing
						// But looking at the source, they all use very similar logic.

						const responseParts: Array<{ text?: string; thinking?: string; functionCall?: { name: string; args: Record<string, unknown> } }> = chunk
							.map(
								(part: {
									text?: string;
									thinking?: string;
									toolCall?: {
										name: string;
										id: string;
										args: Record<string, unknown>;
									};
								}) => {
									if (part.text !== undefined) {
										return { text: part.text };
									} else if (part.thinking !== undefined) {
										return { thinking: part.thinking };
									} else if (part.toolCall) {
										return {
											functionCall: {
												name: part.toolCall.name,
												args: part.toolCall.args,
											},
										};
									}
									return { text: "" };
								}
							)
							.filter((part) =>
								(hasKey(part, { text: true }) ? part.text!.length > 0 : false) ||
								(hasKey(part, { thinking: true }) ? part.thinking!.length > 0 : false) ||
								hasKey(part, "functionCall")
							);

						const delta = extractTextFromParts(responseParts, false); // This helper extracts text. We might need to handle thinking separately in UI.

						// Handle thinking parts by emitting them as markdown (or specific UI element if supported)
						// Currently extractTextFromParts only handles text.
						// Let's modify the progress emission to handle thinking.

						const thinkingParts = responseParts.filter(p => p.thinking).map(p => p.thinking).join("");
						if (thinkingParts.length > 0) {
							// Emit proper thinking part - UI handles accumulation
							progress([{ kind: "thinking", value: thinkingParts }]);
						}
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

				// Add assistant message with both text and tool_use parts if present
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const toolCallParts = responseParts.filter(
					(part: any) => part.toolCall !== undefined
				);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const textParts = responseParts.filter(
					(part: any) => part.text !== undefined
				);

				const thinkingParts = responseParts.filter(
					(part: any) => part.thinking !== undefined
				);

				const assistantContent: Array<
					| { type: "text"; value: string }
					| { type: "thinking"; value: string }
					| {
						type: "tool_use";
						name: string;
						toolCallId: string;
						parameters: Record<string, unknown>;
					}
				> = [];

				if (thinkingParts.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const thinkingContent = thinkingParts
						.map((part: any) => part.thinking || "")
						.join("");
					if (thinkingContent.trim().length) {
						assistantContent.push({ type: "thinking", value: thinkingContent });
					}
				}

				if (textParts.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const textContent = textParts
						.map((part: any) => part.text || "")
						.join("");
					if (textContent.trim().length) {
						assistantContent.push({ type: "text", value: textContent });
					}
				}

				if (toolCallParts.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const toolUseParts = toolCallParts.map((part: any) => {
						const toolCall = part.toolCall;
						return {
							type: "tool_use" as const,
							name: toolCall.name,
							toolCallId: toolCall.id,
							parameters: toolCall.args,
						};
					});
					assistantContent.push(...toolUseParts);
				}

				if (assistantContent.length > 0) {
					messages.push({
						role: ChatMessageRole.Assistant,
						content: assistantContent,
					});
				}

				// Check if there are tool calls to process
				if (!toolCallParts.length) {
					const responseText =
						textParts
							.map((part: { text?: string }) => part.text || "")
							.join("");

					// If response is empty after gathering tool results, request a summary
					if (!responseText.trim() && iteration > 0 && pendingToolResults) {
						this.logService.warn(
							`${this.config.logPrefix} Model returned empty text after ${iteration} tool iterations - adding fallback prompt`
						);

						// Add a user message asking for summary
						messages.push({
							role: ChatMessageRole.User,
							content: [{
								type: "text",
								value: "You've gathered information using the tools. Please provide a clear, helpful summary or answer based on what you found. If you encountered issues or found nothing relevant, explain that clearly."
							}],
						});

						// Continue the loop - this will trigger another API call with the fallback prompt
						iteration++;
						continue;
					}

					if (!responseText.trim()) {
						// After fallback prompt still got nothing - show default message
						const fallbackText = localize(
							`${this.config.vendorId}.emptyTextResponse`,
							`${this.config.vendorId} did not return any text.`
						);

						await this.contextBuilder.tryAutoApplyEdits(
							fallbackText,
							contextEntries,
							progress,
							token
						);

						if (!streamedText) {
							const markdown = new MarkdownString(fallbackText);
							markdown.supportThemeIcons = true;
							progress([{ kind: "markdownContent", content: markdown }]);
						}

						return {
							details: `${this.config.vendorId}-response`,
							metadata: { model: modelToUse },
						};
					}

					await this.contextBuilder.tryAutoApplyEdits(
						responseText,
						contextEntries,
						progress,
						token
					);

					if (!streamedText) {
						const markdown = new MarkdownString(responseText);
						markdown.supportThemeIcons = true;
						progress([{ kind: "markdownContent", content: markdown }]);
					}

					return {
						details: `${this.config.vendorId}-response`,
						metadata: { model: modelToUse },
					};
				}

				if (!toolConfigs.length) {
					const errorMessage = localize(
						`${this.config.vendorId}.toolsNotAuthorized`,
						`${this.config.vendorId} requested tool calls but none were authorized for this request.`
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

				const toolResultsForNextRequest: ServerToolResult[] = [];

				// Parallel tool execution
				const maxConcurrency = this.chatConfig.getToolCallMaxConcurrency();
				const timeoutMs = this.chatConfig.getToolCallTimeoutMs();

				const parallelExecutionStartTime = Date.now();
				this.logService.info(
					`${this.config.logPrefix} Starting parallel execution of ${toolCallParts.length} tool call(s) with maxConcurrency=${maxConcurrency}`
				);

				interface ToolTask {
					index: number;
					callId: string;
					toolName: string;
					toolId?: string;
					parameters: Record<string, unknown>;
				}
				const tasks: ToolTask[] = toolCallParts.map(
					(part: any, index: number) => ({
						index,
						callId: part.toolCall!.id,
						toolName: part.toolCall!.name,
						toolId: nameToToolId.get(part.toolCall!.name),
						parameters: part.toolCall!.args ?? {},
					})
				);

				const resultsBuffer: (ServerToolResult | undefined)[] = new Array(
					tasks.length
				);

				const runTask = async (task: ToolTask): Promise<void> => {
					if (token.isCancellationRequested) {
						return;
					}
					const { callId, toolName, toolId, parameters, index } = task;
					const taskStartTime = Date.now();

					if (!callId || callId.trim().length === 0) {
						resultsBuffer[index] = {
							toolCallId: callId || `invalid_call_id_${index}`,
							content: [
								{ type: "text", value: `Invalid callId for tool ${toolName}` },
							],
						};
						return;
					}

					if (!toolId) {
						this.logService.error(
							`${this.config.logPrefix} model requested unknown tool name '${toolName}'. Available names: ${Array.from(
								nameToToolId.keys()
							).join(", ")}`
						);
						resultsBuffer[index] = {
							toolCallId: callId,
							content: [
								{
									type: "text",
									value: localize(
										`${this.config.vendorId}.unknownToolCall`,
										`${this.config.vendorId} requested unknown tool {0}.`,
										toolName
									),
								},
							],
						};
						return;
					}

					const invocation = this.createToolInvocation(
						callId,
						toolId,
						parameters,
						request
					);

					const runWithTimeout = async (): Promise<ServerToolResult> => {
						const timer = new Promise<never>((_, reject) => {
							const id = setTimeout(() => {
								clearTimeout(id);
								reject(new Error(`Tool timed out after ${timeoutMs}ms`));
							}, timeoutMs);
						});

						const exec = this.languageModelToolsService
							.invokeTool(invocation, this.fallbackCountTokens, token)
							.then((result) => {
								const textOutput = (result.content ?? [])
									.filter(
										(part): part is IToolResultTextPart => part.kind === "text"
									)
									.map((part) => part.value)
									.filter((v) => v && v.length > 0)
									.join("\n");
								const finalOutput =
									textOutput.trim().length > 0
										? textOutput
										: (result as any).toolResultError
											? `Error: ${(result as any).toolResultError}`
											: "Tool executed successfully but returned no output.";
								return {
									toolCallId: callId,
									content: [{ type: "text" as const, value: finalOutput }],
								};
							});

						return Promise.race([exec, timer]);
					};

					try {
						resultsBuffer[index] = await runWithTimeout();
						const taskTime = Date.now() - taskStartTime;
						this.logService.debug(
							`${this.config.logPrefix} Finished tool ${toolName} (callId: ${callId}) in ${taskTime}ms`
						);
					} catch (error) {
						const taskTime = Date.now() - taskStartTime;
						const message =
							error instanceof Error ? error.message : String(error);
						this.logService.error(
							`${this.config.logPrefix} tool ${toolId} (callId: ${callId}) failed after ${taskTime}ms: ${message}`
						);

						// Generate recovery guidance based on the error and tool
						const recoveryGuidance = this.getToolRecoveryGuidance(toolId, toolName, message);

						resultsBuffer[index] = {
							toolCallId: callId,
							content: [
								{
									type: "text" as const,
									value: `Tool Error: ${message}\n\n${recoveryGuidance}`,
								},
							],
						};
					}
				};

				let next = 0;
				const workers: Promise<void>[] = [];
				const startWorker = (): Promise<void> => {
					if (next >= tasks.length) {
						return Promise.resolve();
					}
					const task = tasks[next++];
					return runTask(task).then(() => startWorker());
				};
				for (let i = 0; i < Math.min(maxConcurrency, tasks.length); i++) {
					workers.push(startWorker());
				}
				await Promise.all(workers);

				const parallelExecutionTime = Date.now() - parallelExecutionStartTime;
				this.logService.info(
					`${this.config.logPrefix} Completed parallel execution of ${tasks.length} tool call(s) in ${parallelExecutionTime}ms ` +
					`(avg: ${(parallelExecutionTime / tasks.length).toFixed(
						2
					)}ms per call, ` +
					`concurrency: ${maxConcurrency})`
				);

				for (let i = 0; i < resultsBuffer.length; i++) {
					const r = resultsBuffer[i];
					if (r) {
						toolResultsForNextRequest.push(r);
					}
				}

				if (toolResultsForNextRequest.length === 0) {
					throw new Error(
						localize(
							`${this.config.vendorId}.noToolResponses`,
							`${this.config.vendorId} requested tool calls but no responses were produced.`
						)
					);
				}

				pendingToolResults = toolResultsForNextRequest;
				this.logService.info(
					`${this.config.logPrefix} Collected ${toolResultsForNextRequest.length} tool results for next request`
				);
				iteration++;
			}

			const totalRequestTime = Date.now() - requestStartTime;
			this.logService.warn(
				`${this.config.logPrefix} Reached maxIterations limit (${maxIterations}) after ${totalRequestTime}ms and ${iteration} iterations`
			);
			throw new Error(
				localize(
					`${this.config.vendorId}.maxToolIterations`,
					"Reached the maximum number of tool call iterations ({0}) without producing an answer.",
					maxIterations
				)
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[${this.config.vendorId}] ${message}`);

			const markdown = new MarkdownString(
				localize(`${this.config.vendorId}.error`, "${this.config.vendorId} request failed: {0}", message)
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
				request.requestId
			);
		}
	}

	protected async invokeViaLanguageModelsService(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelId: string
	): Promise<IChatAgentResult> {
		this.logService.info(
			`[${this.config.vendorId}] Delegating request to language models service for model ${modelId} (cross-vendor)`
		);

		const messages: IChatMessage[] = [];

		const contextPrompt = await this.contextBuilder.buildContextPrompt(
			request,
			token
		);
		if (contextPrompt) {
			messages.push({
				role: ChatMessageRole.User,
				content: [{ type: "text", value: contextPrompt.prompt }],
			});
		}

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
				?.map((part) => extractResponseContent(part))
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0
				)
				.join("\n");
			if (assistantText) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: "text", value: assistantText }],
				});
			}
		}

		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: "text", value: request.message }],
		});

		try {
			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				new ExtensionIdentifier(`core.${this.config.vendorId}`),
				messages,
				{},
				token
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
				details: `${this.config.vendorId}-response`,
				metadata: { model: modelId, delegated: true },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(
				`[${this.config.vendorId}] Error in delegated request for model ${modelId}:`,
				error
			);
			const markdown = new MarkdownString(
				localize(`${this.config.vendorId}.error`, "${this.config.vendorId} request failed: {0}", message)
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
				`[${this.config.vendorId}] clearing tool selection for request ${requestId}`
			);
			this.requestTools.delete(requestId);
			return;
		}
		this.logService.debug(
			`[${this.config.vendorId}] received tool selection for request ${requestId}: ${JSON.stringify(
				tools
			)}`
		);
		this.requestTools.set(requestId, tools);
	}

	// Abstracted helper methods

	private buildToolDeclarations(
		requestId: string,
		chatMode: ChatModeKind
	): {
		tools: Array<{ name: string; description?: string; parameters: unknown }>;
		nameToToolId: Map<string, string>;
		summaries: string[];
	} {
		const serverTools: Array<{
			name: string;
			description?: string;
			parameters: unknown;
		}> = [];
		const nameToToolId = new Map<string, string>();
		const summaries: string[] = [];
		const usedToolNames = new Set<string>();

		// Use getTools(true) to bypass context key filtering.
		// The global context key service doesn't have 'chatAgentKind' set properly,
		// so we rely on explicit mode-based filtering below.
		const allTools = Array.from(this.languageModelToolsService.getTools(true));
		
		// Filter tools based on chat mode
		let tools: IToolData[];
		if (chatMode === ChatModeKind.Ask) {
			// In Ask mode, include ask-mode tools (tagged with 'ask-mode')
			// and general tools (not exclusively for agent mode)
			tools = allTools.filter(tool => 
				tool.tags?.includes('ask-mode') || !tool.tags?.includes('agent-only')
			);
		} else {
			// In non-ask modes, exclude ask-mode-only tools
			tools = allTools.filter(tool => !tool.tags?.includes('ask-mode'));
		}

		const currentRequestTools = this.requestTools.get(requestId);
		const toolUserSelection =
			currentRequestTools === undefined || currentRequestTools === null
				? true
				: currentRequestTools;


		let toolIndex = 0;
		for (const tool of tools) {
			// Check if tool is allowed
			if (typeof toolUserSelection === "boolean") {
				if (!toolUserSelection) {
					toolIndex++;
					continue;
				}
			} else if (Array.isArray(toolUserSelection)) {
				if (!toolUserSelection.includes(tool.id)) {
					toolIndex++;
					continue;
				}
			}

			const index = toolIndex++;
			const functionName = this.sanitizeToolName(tool, index, usedToolNames);
			usedToolNames.add(functionName);
			nameToToolId.set(functionName, tool.id);

			const descriptionParts = [];
			if ('displayName' in tool && tool.displayName) descriptionParts.push(tool.displayName);
			if ('description' in tool && tool.description) descriptionParts.push(tool.description);

			const description = descriptionParts.length
				? descriptionParts.join(" ")
				: undefined;

			// Apply same parameters validation as ChatGPT (consolidated)
			let parameters: Record<string, unknown> & {
				type?: string;
				properties?: Record<string, unknown>;
			};
			const rawParameters = tool.inputSchema;
			if (
				!rawParameters ||
				typeof rawParameters !== "object" ||
				rawParameters === null ||
				Array.isArray(rawParameters)
			) {
				parameters = { type: "object", properties: {} };
			} else {
				// Cast to object type for type narrowing
				parameters = rawParameters as Record<string, unknown> & {
					type?: string;
					properties?: Record<string, unknown>;
				};
				if (!("type" in parameters) || parameters.type !== "object") {
					parameters = { ...parameters, type: "object" };
				}
				if (
					!("properties" in parameters) ||
					typeof parameters.properties !== "object" ||
					parameters.properties === null ||
					Array.isArray(parameters.properties)
				) {
					parameters = { ...parameters, properties: {} };
				}
				if (parameters.properties) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const props = parameters.properties as Record<string, any>;
					for (const key in props) {
						if (propIsObject(props[key])) { // Helper needed
							const prop = props[key];
							if (!("type" in prop) || typeof prop.type !== "string") {
								props[key] = { ...prop, type: "string" };
							}
							if (!("description" in props[key])) {
								props[key] = { ...props[key], description: "" };
							}
						}
					}
				}
			}

			summaries.push(
				`${functionName}: ${description ?? tool.toolReferenceName ?? tool.id}`
			);

			serverTools.push({
				name: functionName,
				description,
				parameters,
			});
		}

		return {
			tools: serverTools,
			nameToToolId,
			summaries,
		};
	}

	private sanitizeToolName(
		tool: IToolData,
		index: number,
		usedNames: Set<string>
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

	private createToolInvocation(
		callId: string,
		toolId: string,
		parameters: Record<string, unknown>,
		request: IChatAgentRequest
	): IToolInvocation {
		// Get tool data to check for resolveDefaults
		const toolData = this.languageModelToolsService.getTool(toolId);

		// Merge smart defaults if available
		let mergedParameters = parameters;
		if (toolData?.resolveDefaults && this.toolContextResolverService) {
			try {
				// Build smart context
				const ctx = this.toolContextResolverService.getContext();
				const smartContext: ISmartToolContext = {
					activeFile: ctx.activeFile,
					activeFileLanguage: ctx.activeFileLanguage,
					cursorPosition: ctx.cursorPosition,
					selectionText: ctx.selection?.text,
					selectionRange: ctx.selection?.range ? {
						startLine: ctx.selection.range.startLineNumber,
						endLine: ctx.selection.range.endLineNumber,
						startColumn: ctx.selection.range.startColumn,
						endColumn: ctx.selection.range.endColumn,
					} : undefined,
					visibleRange: ctx.visibleRange ? {
						startLine: ctx.visibleRange.startLineNumber,
						endLine: ctx.visibleRange.endLineNumber,
					} : undefined,
					fileWithMostErrors: this.toolContextResolverService.getFileWithMostErrors(),
					workspaceRoot: ctx.workspaceRoot,
				};

				// Get smart defaults
				const defaults = toolData.resolveDefaults(smartContext);

				// Merge: explicit model-provided parameters override defaults
				mergedParameters = { ...defaults, ...parameters };

				// Log what we auto-filled for debugging
				const autoFilledKeys = Object.keys(defaults).filter(k => !(k in parameters));
				if (autoFilledKeys.length > 0) {
					this.logService.debug(
						`${this.config.logPrefix} [SmartDefaults] Tool ${toolId}: auto-filled ${autoFilledKeys.join(', ')}`
					);
				}
			} catch (error) {
				// Don't fail tool invocation if smart defaults fail
				this.logService.warn(
					`${this.config.logPrefix} [SmartDefaults] Error resolving defaults for ${toolId}:`,
					error
				);
			}
		}

		return {
			callId,
			toolId,
			parameters: mergedParameters,
			context: { sessionId: request.sessionId },
			chatRequestId: request.requestId,
		};
	}

	// Abstract this for customization
	protected getEndpoint(mode: ChatModeKind): "/api/agent/tools" | "/api/agent/ask" {
		// Default behavior for Claude/Gemini: ask endpoint for Ask mode, tools otherwise.
		// DeepSeek overrides this to always return "/api/agent/tools"
		return mode === ChatModeKind.Ask ? "/api/agent/ask" : "/api/agent/tools";
	}

	private async performRequest(
		messages: IChatMessage[],
		tools: Array<{ name: string; description?: string; parameters: unknown }>,
		token: CancellationToken,
		model: string,
		toolResults?: ServerToolResult[],
		mode?: string,
		sessionId?: string,
		projectId?: string
	): Promise<ChatGPTStreamingResponse> {
		const toolNames = tools.map((t) => t.name || "<unnamed>");
		this.logService.info(
			`${this.config.logPrefix} performRequest: model=${model}, messages=${messages.length
			}, tools=${toolNames.join(", ") || "none"}, toolResults=${toolResults?.length || 0
			}, mode=${mode || "unknown"}`
		);

		const accessToken = await this.getAccessToken();
		if (!accessToken) {
			throw new Error(
				localize(
					`${this.config.vendorId}.noAuthToken`,
					"Authentication token is missing. Please sign in."
				)
			);
		}

		validateIDEFormat(messages);
		this.logService.debug(
			`${this.config.logPrefix} Message format validation passed: ${messages.length} messages in IDE format`
		);

		const endpoint = this.getEndpoint(mode as ChatModeKind);
		const hasToolResults = toolResults && toolResults.length > 0;

		// Calculate max output tokens
		const models = this.getModels();
		const modelConfig = models.find((m) => m.id === model);
		const maxOutputTokens = modelConfig?.maxOutputTokens ?? 8192;

		this.logService.info(
			`${this.config.logPrefix} Using endpoint: ${endpoint} (tools=${tools.length
			}, toolResults=${toolResults?.length || 0}, maxOutputTokens=${maxOutputTokens})`
		);

		const response = await sendChatGPTRequest(
			this.requestService,
			accessToken,
			this.serverAddress,
			endpoint,
			messages,
			token,
			{
				modelName: model,
				tools: tools,
				toolResults: hasToolResults ? toolResults : undefined,
				mode: mode,
				maxOutputTokens, // Some agents might ignore this but passing it is safe
				sessionId,
				projectId,
			},
			this.logService,
			this.config.vendorId as "openai" | "gemini" | "claude" | "deepseek"
		);

		response.result.then(
			(result: {
				parts: Array<{
					text?: string;
					toolCall?: {
						name: string;
						id: string;
						args: Record<string, unknown>;
					};
				}>;
				finishReason?: string | null;
			}) => {
				this.logService.info(
					`${this.config.logPrefix} Request completed: ${result.parts.length
					} parts, finishReason=${result.finishReason || "none"}`
				);
			},
			(error: unknown) => {
				this.logService.error(
					`${this.config.logPrefix} Streaming request failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
```typescript
		);


		// Track the request
		if (this.metricsService) {
			this.logService.info(`[${ this.config.vendorId }]Tracking chat request feature usage`);
			this.metricsService.trackFeatureUsed(`${ this.config.vendorId }.chatRequest`);
		} else {
			this.logService.warn(`[${ this.config.vendorId }]Metrics service not available for tracking`);
		}

		return response;
	}

	// Helper to build messages (shared logic)
	protected async buildMessages(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<{
		messages: IChatMessage[];
		contextEntries: IContextBlockMetadata[];
	}> {
		const messages: IChatMessage[] = [];
		const contextPrompt = await this.contextBuilder.buildContextPrompt(
			request,
			token
		);
		const contextEntries = contextPrompt?.entries ?? [];
		if (contextPrompt) {
			messages.push({
				role: ChatMessageRole.User,
				content: [{ type: "text", value: contextPrompt.prompt }],
			});
		}

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
				?.map((part) => extractResponseContent(part))
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0
				)
				.join("\n");

			// Extract thinking content for DeepSeek reasoner models
			const thinkingText = entry.response
				?.map((part) => extractThinkingContent(part))
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0
				)
				.join("\n");

			if (assistantText || thinkingText) {
				const content: Array<{ type: "text"; value: string } | { type: "thinking"; value: string }> = [];
				if (thinkingText) {
					content.push({ type: "thinking", value: thinkingText });
				}
				if (assistantText) {
					content.push({ type: "text", value: assistantText });
				}
				messages.push({
					role: ChatMessageRole.Assistant,
					content,
				});
			}
		}

		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: "text", value: request.message }],
		});

		return { messages, contextEntries };
	}

	/**
	 * Builds an enhanced system prompt that encourages proactive tool usage
	 * and provides behavioral guidelines for agentic behavior.
	 */
	protected buildAgenticSystemPrompt(toolSummaries: string[], chatMode?: ChatModeKind): string {
		const toolsList = toolSummaries.map((summary) => `- ${ summary }`).join("\n");

		// Core agentic behavior instructions
		const coreInstructions = `# Your Role
You are an expert AI coding assistant integrated into an IDE.You help developers by actively using your tools to understand, search, and modify code.

# Core Behaviors
		1. ** Be Proactive **: Don't just answer questions - use tools to gather information and take action. When a user mentions a bug, search for it. When they mention a file, read it.
		2. ** Use Tools Liberally **: Your tools are powerful.Use them whenever they can help - don't ask permission or describe what you could do; just do it.
		3. ** Chain Tools Together **: Combine multiple tools to accomplish complex tasks.Read before editing.Check linter after changes.Search before creating.
4. ** Think Step - by - Step **: Break down complex requests into clear actions and execute them systematically.
5. ** Verify Your Work **: After making changes, use checkLinter or re - read files to verify correctness.

# Tool Usage Guidelines
			- ** Search Before Edit **: Always read / search files before modifying them to understand context
				- ** Verify After Edit **: Check for linting errors after code changes
					- ** Progressive Disclosure **: Start with broad searches, then narrow down to specifics
						- ** Parallel When Possible **: Make multiple independent tool calls simultaneously

# Available Tools
${ toolsList }

# Examples of GOOD Agentic Behavior

			** User says **: "There's a bug in the login"
				** Good response **: * immediately searches for login - related files * → * reads relevant code * → * identifies potential issues * → * proposes or implements fix * → * checks linter *
** Bad response **: "Could you tell me more about the bug?" or "Which file is the login code in?"

			** User says **: "Add input validation to the form"
				** Good response **: * searches for form files * → * reads current implementation * → * identifies inputs needing validation * → * implements validation * → * verifies with linter *
** Bad response **: Describes how validation could be added without actually doing it

			** User says **: "What does this function do?"
				** Good response **: * reads the file containing the function* → * traces related code if needed * → * explains with specific references *
** Bad response **: Asks which function or gives a generic explanation`;

		// Mode-specific additions
		let modeInstructions = "";
		if (chatMode === ChatModeKind.Ask) {
			modeInstructions = `

# Ask Mode Guidelines
You are in ASK mode - focus on answering questions and explaining code.Use read - only tools(read files, search, analyze) liberally to provide accurate, grounded answers.Avoid modifying files unless explicitly requested.`;
		} else if (chatMode === ChatModeKind.Agent) {
			modeInstructions = `

# Agent Mode Guidelines
You are in AGENT mode - take full ownership of tasks.Execute multi - step workflows, make changes, verify results.Proactively complete subtasks without asking for confirmation on each step.Report results when done.`;
		} else if (chatMode === ChatModeKind.Edit) {
			modeInstructions = `

# Edit Mode Guidelines
You are in EDIT mode - focus on making targeted edits.Read relevant context first, then make precise changes.Always verify edits with the linter.`;
		}

		return coreInstructions + modeInstructions;
	}

	/**
	 * Generates recovery guidance based on the tool that failed and the error message.
	 * This helps the model understand how to recover from tool failures.
	 */
	protected getToolRecoveryGuidance(toolId: string, toolName: string, errorMessage: string): string {
		const lowerError = errorMessage.toLowerCase();
		const lowerToolId = toolId.toLowerCase();

		// File not found errors
		if (lowerError.includes("not found") || lowerError.includes("no such file") || lowerError.includes("enoent")) {
			if (lowerToolId.includes("read") || lowerToolId.includes("file")) {
				return `RECOVERY OPTIONS:
		1. Use searchFiles to find the correct file path(handles typos - e.g., "authetication" will find "authentication")
		2. Use searchCodebase with a conceptual query to find related code
		3. TERMINAL FALLBACK: Run these commands to explore:
		- runTerminal("ls -la {parent_directory}") to see what files exist
			- runTerminal("find . -name '*partial_name*' -type f") to search
				- runTerminal("tree -L 2") to see folder structure
		4. The file may have been moved - try a broader search`;
			}
			if (lowerToolId.includes("edit") || lowerToolId.includes("delete")) {
				return `RECOVERY OPTIONS:
		1. First use readFile to verify the file path exists
		2. Use searchFiles to find the correct path
		3. TERMINAL: runTerminal("ls -la {directory}") to see what's there
		4. The file may not exist yet - consider using createFile instead`;
			}
		}

		// Permission/access errors
		if (lowerError.includes("permission") || lowerError.includes("access denied") || lowerError.includes("eperm")) {
			return `RECOVERY OPTIONS:
		1. The file may be read - only or locked by another process
		2. TERMINAL: runTerminal("ls -la {file}") to check permissions
		3. Try a different file or ask the user to close the file if it's open elsewhere
		4. Check if you're trying to modify a system or protected file`;
	}

	// Timeout errors
	if(lowerError.includes("timeout") || lowerError.includes("timed out")) {
	return `RECOVERY OPTIONS:
1. The operation took too long - try with a smaller scope
2. For searches: use more specific patterns to reduce results
3. For file operations: the file might be very large - try limiting lines read
4. Retry the operation - it may have been a temporary issue`;
}

// Search/query errors
if (lowerToolId.includes("search")) {
	if (lowerError.includes("no results") || lowerError.includes("not found")) {
		return `RECOVERY OPTIONS:
1. BROADEN SEARCH: Try a shorter pattern or fewer keywords
2. Use searchCodebase for semantic/meaning-based search
3. TERMINAL FALLBACK (ultimate backup):
   - runTerminal("grep -r 'pattern' . --include='*.ts'") for content search
   - runTerminal("find . -name '*partial*' -type f") for file search
   - runTerminal("tree -L 2") to see codebase structure
4. Check for typos in the search query`;
	}
	return `RECOVERY OPTIONS:
1. Try a simpler search pattern
2. Check if the search pattern is valid regex (if useRegex is true)
3. TERMINAL: runTerminal("ls -la {folder}") to see contents
4. Try limiting the search scope to a specific folder`;
}

// Edit tool errors
if (lowerToolId.includes("edit")) {
	if (lowerError.includes("no match") || lowerError.includes("cannot find")) {
		return `RECOVERY OPTIONS:
1. First use readFile to see the current file contents
2. The file may have changed - re-read it before editing
3. Check that your edit target matches the actual file content exactly`;
	}
	return `RECOVERY OPTIONS:
1. Read the file first to understand current state
2. Verify the file path is correct
3. Check for linter errors with checkLinter after any successful edits`;
}

// Linter tool errors
if (lowerToolId.includes("linter") || lowerToolId.includes("lint")) {
	return `RECOVERY OPTIONS:
1. The file path may be incorrect - try without specifying a path to see all workspace errors
2. The linter service may not be initialized yet - try again
3. The file type may not have linting support`;
}

// Generic recovery guidance
return `RECOVERY OPTIONS:
1. Try the operation again - the error may be transient
2. Use a different approach to accomplish the same goal
3. Break down the task into smaller steps
4. Read related files first to understand context`;
	}

	/**
	 * Analyzes the user's request and returns a model recommendation if a different model
	 * might be better suited for the task.
	 */
	protected getModelRecommendation(
	message: string,
	currentModelId ?: string,
	toolIds ?: string[]
): { model: string; reason: string; confidence: number } | undefined {
	const lowerMessage = message.toLowerCase();
	const messageLength = message.length;

	// Don't recommend if message is too short to analyze
	if (messageLength < 20) {
		return undefined;
	}

	// Normalize current model for comparison
	const currentModel = currentModelId?.toLowerCase() || '';

	// === Long Context Analysis Tasks ===
	// Claude excels at long context and detailed analysis
	const longContextIndicators = [
		'analyze this entire',
		'review all the',
		'summarize this large',
		'read through all',
		'analyze the whole',
		'understand the entire',
		'explain everything in',
		'full codebase',
		'entire project',
		'all files in'
	];

	if (longContextIndicators.some(i => lowerMessage.includes(i)) || messageLength > 5000) {
		if (!currentModel.includes('claude') && !currentModel.includes('sonnet') && !currentModel.includes('opus')) {
			return {
				model: 'Claude',
				reason: 'Claude has excellent long context handling for analyzing large codebases or files',
				confidence: 0.75
			};
		}
	}

	// === Complex Multi-Step Planning ===
	// GPT-4o and o1 are good for complex planning
	const planningIndicators = [
		'create a plan',
		'design a system',
		'architect',
		'step by step plan',
		'implementation strategy',
		'road map',
		'break down this complex',
		'design pattern',
		'how should i structure'
	];

	if (planningIndicators.some(i => lowerMessage.includes(i))) {
		if (!currentModel.includes('gpt-4') && !currentModel.includes('o1')) {
			return {
				model: 'GPT-4o',
				reason: 'GPT-4o excels at complex multi-step planning and system design',
				confidence: 0.7
			};
		}
	}

	// === Deep Reasoning / Math / Logic ===
	// DeepSeek reasoner is excellent for complex reasoning
	const reasoningIndicators = [
		'prove that',
		'derive the',
		'mathematical',
		'algorithm complexity',
		'optimize this algorithm',
		'logical reasoning',
		'step by step thinking',
		'prove or disprove',
		'formal verification'
	];

	if (reasoningIndicators.some(i => lowerMessage.includes(i))) {
		if (!currentModel.includes('deepseek') && !currentModel.includes('reasoner')) {
			return {
				model: 'DeepSeek Reasoner',
				reason: 'DeepSeek Reasoner excels at complex mathematical and logical reasoning',
				confidence: 0.7
			};
		}
	}

	// === Code Generation with Context ===
	// DeepSeek-coder is excellent for pure code generation
	const codeGenIndicators = [
		'write the complete',
		'generate the full',
		'implement from scratch',
		'create a new',
		'build a complete',
		'code for'
	];

	const hasHeavyToolUse = toolIds && toolIds.length > 3;
	if (codeGenIndicators.some(i => lowerMessage.includes(i)) && !hasHeavyToolUse) {
		if (!currentModel.includes('deepseek') && !currentModel.includes('coder')) {
			return {
				model: 'DeepSeek Coder',
				reason: 'DeepSeek Coder is optimized for code generation tasks',
				confidence: 0.65
			};
		}
	}

	// === Quick Simple Tasks ===
	// For simple tasks, smaller/faster models are better
	const simpleTaskIndicators = [
		'what is',
		'how do i',
		'quick question',
		'simple',
		'just tell me',
		'briefly explain'
	];

	if (simpleTaskIndicators.some(i => lowerMessage.includes(i)) && messageLength < 200) {
		if (currentModel.includes('opus') || currentModel.includes('o1')) {
			return {
				model: 'GPT-4o-mini',
				reason: 'A faster model would work well for this simple task',
				confidence: 0.6
			};
		}
	}

	return undefined;
}
}

function propIsObject(val: any): val is Record<string, any> {
	return val && typeof val === "object" && val !== null && !Array.isArray(val);
}
