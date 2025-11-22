/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { MarkdownString } from "../../../../../base/common/htmlContent.js";
import { localize } from "../../../../../nls.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { ExtensionIdentifier } from "../../../../../platform/extensions/common/extensions.js";
import {
	IChatAgentImplementation,
	IChatAgentHistoryEntry,
	IChatAgentRequest,
	IChatAgentResult,
	UserSelectedTools,
} from "../../common/chatAgents.js";
import { IChatProgressHistoryResponseContent } from "../../common/chatModel.js";
import {
	ChatErrorLevel,
	IChatProgress,
	IChatTaskDto,
} from "../../common/chatService.js";
import {
	ILanguageModelsService,
	IChatMessage,
	ChatMessageRole,
} from "../../common/languageModels.js";
import {
	ILanguageModelToolsService,
	IToolData,
	CountTokensCallback,
	IToolInvocation,
	IToolResultTextPart,
} from "../../common/languageModelToolsService.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { CHATGPT_MODELS } from "./models.js";
import type {
	OpenAIMessage,
	OpenAIToolCall,
	OpenAIFunction,
	ServerToolResult,
	ChatGPTStreamingResponse,
} from "./types.js";
import type { IContextBlockMetadata } from "../../common/contextBuilder.js";
import { convertOpenAIMessagesToIDE } from "./conversion.js";
import { validateIDEFormat } from "./validation.js";
import { sendChatGPTRequest } from "./request.js";
import { extractTextFromParts } from "./utils.js";
import { ContextBuilder } from "../../common/contextBuilder.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { ILanguageFeaturesService } from "../../../../../editor/common/services/languageFeatures.js";
import { IAgentPlanner, PlanContext, ToolMetadata } from "../../common/agentPlanner.js";
import { IDependencyGraphService } from "../../common/dependencyGraphService.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import { URI } from "../../../../../base/common/uri.js";


export class ChatGPTAgentImplementation implements IChatAgentImplementation {
	private readonly requestTools = new Map<string, UserSelectedTools>();
	private readonly fallbackCountTokens: CountTokensCallback = async (
		input: string,
		_token: CancellationToken
	) => input.length;
	private readonly contextBuilder: ContextBuilder;

	constructor(
		private readonly requestService: IRequestService,
		private readonly serverAddress: string,
		private readonly secretStorageService: ISecretStorageService,
		private readonly logService: ILogService,
		textModelService: any,
		private readonly languageModelToolsService: ILanguageModelToolsService,
		private readonly languageModelsService: ILanguageModelsService,
		private readonly configurationService: IConfigurationService,
		private readonly agentPlanner?: IAgentPlanner,
		private readonly dependencyGraphService?: IDependencyGraphService,
		private readonly workspaceService?: IWorkspaceContextService,
		private readonly fileService?: IFileService,
		languageFeaturesService?: ILanguageFeaturesService,
	) {
		this.contextBuilder = new ContextBuilder(textModelService, logService, languageFeaturesService);
	}

	private async getAccessToken(): Promise<string | undefined> {
		try {
			const token = await this.secretStorageService.get("ren.auth.accessToken");
			if (token) {
				this.logService.debug(
					`[chatgpt-server] Access token retrieved successfully (length: ${token.length})`
				);
			} else {
				this.logService.warn(
					`[chatgpt-server] No access token found in secret storage. User needs to authenticate.`
				);
			}
			return token ?? undefined;
		} catch (error) {
			this.logService.error(
				`[chatgpt-server] Error retrieving access token: ${error instanceof Error ? error.message : String(error)
				}`
			);
			return undefined;
		}
	}

	private resolveModelFromRequest(userSelectedModelId?: string): string {
		if (userSelectedModelId) {
			const selectedModelConfig = CHATGPT_MODELS.find(
				(m) => m.identifier === userSelectedModelId
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
		token: CancellationToken
	): Promise<IChatAgentResult> {
		if (token.isCancellationRequested) {
			return { details: "cancelled" };
		}

		if (request.userSelectedModelId) {
			const selectedModelMetadata =
				this.languageModelsService.lookupLanguageModel(
					request.userSelectedModelId
				);
			if (selectedModelMetadata && selectedModelMetadata.vendor !== "openai") {
				return this.invokeViaLanguageModelsService(
					request,
					progress,
					history,
					token,
					request.userSelectedModelId
				);
			}
		}

		const modelToUse = this.resolveModelFromRequest(
			request.userSelectedModelId
		);

		if (request.userSelectedTools) {
			this.logService.debug(
				`[chatgpt] reading tools from request object for request ${request.requestId
				}: ${JSON.stringify(request.userSelectedTools)}`
			);
			this.requestTools.set(request.requestId, request.userSelectedTools);
		}

		const { messages, contextEntries } = await this.buildMessages(
			request,
			history,
			token
		);
		const { tools: toolConfigs, nameToToolId } =
			this.buildChatGPTToolDeclarations(request.requestId);

		// Generate plan if planner is available and this is an agent mode request
		let planId: string | undefined;
		if (this.agentPlanner && this.dependencyGraphService && this.workspaceService && this.fileService) {
			try {
				// Collect workspace files for context
				const workspaceFolders = this.workspaceService.getWorkspace().folders;
				const workspaceFiles: URI[] = [];
				if (workspaceFolders.length > 0) {
					// Get a sample of workspace files (in production, this would be more comprehensive)
					const rootUri = workspaceFolders[0].uri;
					try {
						const stat = await this.fileService.resolve(rootUri);
						if (stat.children) {
							for (const child of stat.children.slice(0, 100)) { // Limit to 100 files for performance
								if (!child.isDirectory) {
									workspaceFiles.push(child.resource);
								}
							}
						}
					} catch (error) {
						this.logService.warn(`[chatgpt] Failed to list workspace files: ${error}`);
					}
				}

				// Get dependency graphs for relevant files
				const dependencyGraphs = await this.dependencyGraphService.getDependencyGraphs(workspaceFiles);

				// Get tool metadata
				const availableTools: ToolMetadata[] = Array.from(this.languageModelToolsService.getTools()).map(tool => ({
					id: tool.id,
					name: tool.displayName,
					description: tool.modelDescription || tool.userDescription || '',
					cost: tool.orchestration?.cost,
					latency: tool.orchestration?.latency,
					prerequisites: tool.orchestration?.prerequisites,
				}));

				// Generate plan
				const planContext: PlanContext = {
					dependencyGraphs,
					availableTools,
					workspaceFiles,
				};

				const plan = await this.agentPlanner.generatePlan(
					request.requestId,
					request.sessionId,
					request.message,
					planContext
				);
				planId = plan.id;

				// Plan is now internal - agent will use manage_agent_plan tool to access it
				// The agent should call the plan tool's sync_to_todos operation to show progress

				// Approve plan automatically
				this.agentPlanner.approvePlan(plan.id);
			} catch (error) {
				this.logService.warn(`[chatgpt] Failed to generate plan: ${error}`);
			}
		}

		const contextPrompt = await this.contextBuilder.buildContextPrompt(
			request,
			token
		);
		const contextString = contextPrompt?.prompt || '';

// System prompt is now injected by the server

		// Remove upper limit on iterations - allow unlimited tool call iterations
		// This can be configured via chat.agent.maxIterations if needed, but defaults to unlimited
		const maxIterations = this.configurationService.getValue<number>('chat.agent.maxIterations') ?? Number.MAX_SAFE_INTEGER;
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
					const addedIds = pendingToolResults
						.map((result) => result.toolCallId)
						.join(", ");
					this.logService.info(
						`[chatgpt-server] Added ${pendingToolResults.length} tool result(s) to conversation history: ${addedIds}`
					);
					pendingToolResults = undefined;
				}

				const iterationStartTime = Date.now();
				const elapsedSinceRequestStart = iterationStartTime - requestStartTime;
				this.logService.info(
					`[chatgpt-server] invoke iteration ${iteration + 1}${maxIterations < Number.MAX_SAFE_INTEGER ? `/${maxIterations}` : ''} (elapsed: ${elapsedSinceRequestStart}ms)`
				);

				// Keep a handle on tool results used for this request. Do NOT materialize tool
				// results into the messages array here, because our IDE -> server converter drops
				// tool-role messages. Instead, pass toolResults to the server so it appends
				// proper tool messages after the assistant tool_calls (OpenAI-required order).
				const toolResultsForServer: ServerToolResult[] | undefined =
					conversationToolResults.size > 0
						? Array.from(conversationToolResults.values())
						: undefined;

				if (toolResultsForServer && toolResultsForServer.length > 0) {
					const pendingIds = toolResultsForServer
						.map((tr) => tr.toolCallId)
						.join(", ");
					this.logService.info(
						`[chatgpt-server] Forwarding ${toolResultsForServer.length} tool result(s) to server: ${pendingIds}`
					);
				} else {
					this.logService.info(
						`[chatgpt-server] No pending tool results to forward for this iteration`
					);
				}

				const lastAssistantWithTools = [...messages]
					.reverse()
					.find(
						(message) =>
							message.role === "assistant" &&
							Array.isArray((message as OpenAIMessage).tool_calls) &&
							(message as OpenAIMessage).tool_calls!.length > 0
					);
				if (lastAssistantWithTools && lastAssistantWithTools.tool_calls) {
					const lastIds = lastAssistantWithTools.tool_calls
						.map((tc) => tc.id)
						.join(", ");
					this.logService.info(
						`[chatgpt-server] Last assistant message before request contains tool_calls: ${lastIds}`
					);
				} else {
					this.logService.warn(
						`[chatgpt-server] No assistant message with tool_calls found before request`
					);
				}

				const streamingResponse = await this.performRequest(
					messages,
					toolConfigs,
					token,
					modelToUse,
					contextString,
					toolResultsForServer
				);
				let streamedText = false;

				const streamIterationStartTime = Date.now();
				this.logService.info(
					`[Stream] [${streamIterationStartTime}] Starting async iteration of stream`
				);

				try {
					// Start consuming stream immediately to avoid buffering
					for await (const chunk of streamingResponse.stream) {
						const consumeTimestamp = Date.now();
						this.logService.debug(
							`[Stream] [${consumeTimestamp}] Consuming chunk from async iterable (${chunk.length} parts)`
						);

						if (token.isCancellationRequested) {
							this.logService.info(
								`[Stream] [${consumeTimestamp}] Stream cancelled, breaking iteration`
							);
							break;
						}

						const delta = extractTextFromParts(chunk, false);
						if (delta.length) {
							const progressTimestamp = Date.now();
							this.logService.debug(
								`[Stream] [${progressTimestamp}] Calling progress() with ${delta.length} chars`
							);

							// Ensure progress() is non-blocking by scheduling it
							const markdownChunk = new MarkdownString(delta);
							markdownChunk.supportThemeIcons = true;

							// Call progress synchronously but ensure it's fast
							// The progress callback should handle UI updates asynchronously
							progress([{ kind: "markdownContent", content: markdownChunk }]);
							streamedText = true;
						}
					}

					const iterationEndTime = Date.now();
					this.logService.info(
						`[Stream] [${iterationEndTime}] Completed async iteration (duration: ${iterationEndTime - streamIterationStartTime
						}ms)`
					);
				} catch (error) {
					const errorTimestamp = Date.now();
					this.logService.error(
						`[Stream] [${errorTimestamp}] Error in async iteration: ${error instanceof Error ? error.message : String(error)
						}`
					);
					if (!token.isCancellationRequested) {
						throw error;
					}
				}

				if (token.isCancellationRequested) {
					return { details: "cancelled" };
				}

				const responseData = await streamingResponse.result;
				const responseParts = responseData.parts;

				// (No-op here now; tool results are materialized before the request.)

				this.logService.info(
					`[chatgpt-server] Response received: ${responseParts.length} parts total`
				);

				const textParts = responseParts.filter(
					(part) => part.text !== undefined
				);
				const toolCallParts = responseParts.filter(
					(part) => part.toolCall !== undefined
				);

				this.logService.info(
					`[chatgpt-server] Filtered tool calls: ${toolCallParts.length} tool call(s) found`
				);

				if (textParts.length > 0) {
					const textContent = textParts.map((part) => part.text || "").join("");
					if (textContent.trim().length) {
						messages.push({ role: "assistant", content: textContent });
					}
				}

				if (toolCallParts.length > 0) {
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
							"ChatGPT requested tool calls but none were authorized for this request."
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
					const toolCallIds = toolCallParts.map((part) => part.toolCall!.id);
					const toolCallNames = toolCallParts.map((part) => part.toolCall!.name);
					this.logService.info(
						`[chatgpt-server] Executing ${toolCallParts.length
						} tool call(s): ${toolCallNames.map((name, i) => `${name} (${toolCallIds[i]})`).join(", ")}`
					);

					// Log each tool call with details
					toolCallParts.forEach((part, index) => {
						const toolName = part.toolCall!.name;
						const toolId = nameToToolId.get(toolName);
						const toolArgs = part.toolCall!.args ?? {};
						this.logService.info(
							`[Tool Call ${index + 1}/${toolCallParts.length}] Name: ${toolName}, ID: ${toolId || 'unknown'}, CallID: ${part.toolCall!.id}, Args: ${JSON.stringify(toolArgs).substring(0, 200)}${JSON.stringify(toolArgs).length > 200 ? '...' : ''}`
						);
					});

					// Bounded-parallel execution of tool calls with per-call timeout
					// Increased default from 3 to 10 for better performance with multiple tool calls
					const maxConcurrency =
						this.configurationService.getValue<number>(
							"chat.toolCalls.maxConcurrency"
						) ?? 10;
					const timeoutMs =
						this.configurationService.getValue<number>(
							"chat.toolCalls.timeoutMs"
						) ?? 30000;

					interface ToolTask {
						index: number;
						callId: string;
						toolName: string;
						toolId?: string;
						parameters: Record<string, unknown>;
					}

					const tasks: ToolTask[] = toolCallParts.map((part, index) => ({
						index,
						callId: part.toolCall!.id,
						toolName: part.toolCall!.name,
						toolId: nameToToolId.get(part.toolCall!.name),
						parameters: part.toolCall!.args ?? {},
					}));

					const parallelExecutionStartTime = Date.now();
					this.logService.info(
						`[chatgpt-server] Starting parallel execution of ${tasks.length} tool call(s) with maxConcurrency=${maxConcurrency}`
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

						// Update plan task status if planner is available
						if (planId && this.agentPlanner && toolId) {
							// Find task associated with this tool
							const plan = this.agentPlanner.getPlan(request.requestId);
							if (plan) {
								const associatedTask = plan.tasks.find(t => t.toolId === toolId || t.description.toLowerCase().includes(toolName.toLowerCase()));
								if (associatedTask) {
									this.agentPlanner.updateTaskStatus(planId, associatedTask.id, 'in_progress');
								}
							}
						}

						if (!callId || callId.trim().length === 0) {
							this.logService.error(
								`[chatgpt-server] CRITICAL: Tool call has empty or missing callId for tool ${toolName}.`
							);
							resultsBuffer[index] = {
								toolCallId: callId || `invalid_call_id_${index}`,
								content: [
									{
										type: "text",
										value: `Invalid callId for tool ${toolName}`,
									},
								],
							};
							return;
						}

						if (!toolId) {
							this.logService.error(
								`[chatgpt-server] model requested unknown tool name '${toolName}'. Available names: ${Array.from(
									nameToToolId.keys()
								).join(", ")}`
							);
							resultsBuffer[index] = {
								toolCallId: callId,
								content: [
									{
										type: "text",
										value: localize(
											"chatgpt.unknownToolCall",
											"ChatGPT requested unknown tool {0}.",
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

						if (invocation.callId !== callId) {
							this.logService.error(
								`[chatgpt-server] CRITICAL: callId mismatch! Expected ${callId}, but invocation has ${invocation.callId}`
							);
							resultsBuffer[index] = {
								toolCallId: callId,
								content: [
									{ type: "text", value: `callId mismatch for ${toolName}` },
								],
							};
							return;
						}

						this.logService.info(
							`[Tool Execution] Starting: ${toolName} (ID: ${toolId}, CallID: ${callId})`
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
									if (!result) {
										throw new Error("Tool execution returned undefined result");
									}
									const textOutput = (result.content ?? [])
										.filter(
											(part): part is IToolResultTextPart =>
												part.kind === "text"
										)
										.map((part) => part.value ?? "")
										.filter((value) => value.length > 0)
										.join("\n");

									const finalOutput =
										textOutput.trim().length > 0
											? textOutput
											: result.toolResultError
												? `Error: ${result.toolResultError}`
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
							const resultText = resultsBuffer[index]?.content?.[0]?.value || 'No output';
							const resultPreview = resultText.length > 100 ? resultText.substring(0, 100) + '...' : resultText;
							this.logService.info(
								`[Tool Execution] Completed: ${toolName} (ID: ${toolId}, CallID: ${callId}) in ${taskTime}ms - Result: ${resultPreview}`
							);

							// Update plan task status on success
							if (planId && this.agentPlanner && toolId) {
								const plan = this.agentPlanner.getPlan(request.requestId);
								if (plan) {
									const associatedTask = plan.tasks.find(t => t.toolId === toolId || t.description.toLowerCase().includes(toolName.toLowerCase()));
									if (associatedTask) {
										const resultText = resultsBuffer[index]?.content?.[0]?.value || 'Completed successfully';
										this.agentPlanner.updateTaskStatus(planId, associatedTask.id, 'completed', resultText);
									}
								}
							}
						} catch (error) {
							const taskTime = Date.now() - taskStartTime;
							const message =
								error instanceof Error ? error.message : String(error);
							this.logService.error(
								`[Tool Execution] Failed: ${toolName} (ID: ${toolId}, CallID: ${callId}) after ${taskTime}ms - Error: ${message}`
							);
							this.logService.error(
								`[chatgpt-server] tool ${toolId} (callId: ${callId}) failed after ${taskTime}ms: ${message}`
							);
							resultsBuffer[index] = {
								toolCallId: callId,
								content: [
									{
										type: "text" as const,
										value: message || "Tool execution failed",
									},
								],
							};

							// Update plan task status on failure
							if (planId && this.agentPlanner && toolId) {
								const plan = this.agentPlanner.getPlan(request.requestId);
								if (plan) {
									const associatedTask = plan.tasks.find(t => t.toolId === toolId || t.description.toLowerCase().includes(toolName.toLowerCase()));
									if (associatedTask) {
										this.agentPlanner.updateTaskStatus(planId, associatedTask.id, 'failed', undefined, message);
									}
								}
							}
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
						`[chatgpt-server] Completed parallel execution of ${tasks.length} tool call(s) in ${parallelExecutionTime}ms ` +
						`(avg: ${(parallelExecutionTime / tasks.length).toFixed(2)}ms per call, ` +
						`concurrency: ${maxConcurrency})`
					);

					// Collect results in input order, ensuring a message per callId
					for (let i = 0; i < resultsBuffer.length; i++) {
						const r = resultsBuffer[i];
						if (r) {
							toolResultsForNextRequest.push(r);
						}
					}

					if (toolResultsForNextRequest.length === 0) {
						throw new Error(
							localize(
								"chatgpt.noToolResponses",
								"ChatGPT requested tool calls but no responses were produced."
							)
						);
					}

					pendingToolResults = toolResultsForNextRequest;
					const resultCallIds = toolResultsForNextRequest.map(
						(tr) => tr.toolCallId
					);
					this.logService.info(
						`[chatgpt-server] Collected ${toolResultsForNextRequest.length} tool results for next request. ` +
						`Expected: ${toolCallIds.join(", ")}, ` +
						`Got: ${resultCallIds.join(", ")}`
					);

					// Verify all tool calls have results
					const missingResults = toolCallIds.filter(
						(callId) => !resultCallIds.includes(callId)
					);
					if (missingResults.length > 0) {
						this.logService.error(
							`[chatgpt-server] CRITICAL: ${missingResults.length
							} tool call(s) missing results: ${missingResults.join(", ")}`
						);
					}

					// Keep the assistant message with tool_calls in the messages array
					// The OpenAI API requires that tool role messages must follow an assistant message with tool_calls
					// The server will convert the assistant message (with tool_use parts in IDE format) back to
					// OpenAI format (with tool_calls), and then add the tool role messages after it
					// This ensures the API receives the correct message structure: assistant(with tool_calls) -> tool -> tool -> ...
					this.logService.debug(
						`[chatgpt-server] Keeping assistant message with tool_calls for next request (required by OpenAI API)`
					);

					iteration++;
					continue;
				}

				const responseText =
					extractTextFromParts(responseParts) ||
					localize(
						"chatgpt.emptyTextResponse",
						"ChatGPT did not return any text."
					);

				pendingToolResults = undefined;

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

				this.logService.info(`[chatgpt-server] Request completed successfully`);

				return {
					details: "chatgpt-response",
					metadata: { model: modelToUse },
				};
			}

			const totalRequestTime = Date.now() - requestStartTime;
			this.logService.warn(
				`[chatgpt-server] Reached maxIterations limit (${maxIterations}) after ${totalRequestTime}ms and ${iteration} iterations`
			);
			throw new Error(
				localize(
					"chatgpt.maxToolIterations",
					"Reached the maximum number of tool call iterations ({0}) without producing an answer.",
					maxIterations
				)
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			let userMessage = message;

			if (
				message.includes("Authentication token is missing") ||
				message.includes("noAuthToken")
			) {
				userMessage = localize(
					"chatgpt.authRequired",
					"Please sign in to use ChatGPT. Authentication is required."
				);
			} else if (
				message.includes("SERVER_ADDRESS") ||
				message.includes("server address")
			) {
				userMessage = localize(
					"chatgpt.serverAddressMissing",
					"Server address is not configured. Please set SERVER_ADDRESS environment variable."
				);
			} else if (message.includes("401") || message.includes("Unauthorized")) {
				userMessage = localize(
					"chatgpt.unauthorized",
					"Authentication failed. Please sign in again."
				);
			} else if (message.includes("403") || message.includes("Forbidden")) {
				userMessage = localize(
					"chatgpt.forbidden",
					"Access forbidden. Please check your permissions."
				);
			} else if (
				message.includes("Network") ||
				message.includes("fetch") ||
				message.includes("ECONNREFUSED")
			) {
				userMessage = localize(
					"chatgpt.networkError",
					"Network error. Please check your connection and server address."
				);
			}

			this.logService.error(`[chatgpt-server] Request failed: ${message}`);

			const markdown = new MarkdownString(
				localize("chatgpt.error", "ChatGPT request failed: {0}", userMessage)
			);
			markdown.isTrusted = true;
			progress([{ kind: "markdownContent", content: markdown }]);

			return {
				errorDetails: { message: userMessage, level: ChatErrorLevel.Error },
				details: message,
			};
		} finally {
			this.requestTools.delete(request.requestId);
			this.languageModelToolsService.cancelToolCallsForRequest(
				request.requestId
			);
		}
	}

	private async invokeViaLanguageModelsService(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelId: string
	): Promise<IChatAgentResult> {
		this.logService.info(
			`[chatgpt] Delegating request to language models service for model ${modelId} (cross-vendor)`
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
				?.map((part) => this.extractResponseContent(part))
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
				new ExtensionIdentifier("core.chatgpt"),
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
				details: "chatgpt-response",
				metadata: { model: modelId, delegated: true },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(
				`[chatgpt] Error in delegated request for model ${modelId}:`,
				error
			);
			const markdown = new MarkdownString(
				localize("chatgpt.error", "ChatGPT request failed: {0}", message)
			);
			markdown.isTrusted = true;
			progress([{ kind: "markdownContent", content: markdown }]);
			return {
				errorDetails: { message, level: ChatErrorLevel.Error },
				details: message,
			};
		}
	}

	setRequestTools(requestId: string, tools: UserSelectedTools): void {
		if (!tools) {
			this.logService.debug(
				`[chatgpt] clearing tool selection for request ${requestId}`
			);
			this.requestTools.delete(requestId);
			return;
		}
		this.logService.debug(
			`[chatgpt] received tool selection for request ${requestId}: ${JSON.stringify(
				tools
			)}`
		);
		this.requestTools.set(requestId, tools);
	}

	private getAllowedToolData(requestId: string): IToolData[] {
		const selected = this.requestTools.get(requestId);
		if (!selected) {
			const allTools = Array.from(this.languageModelToolsService.getTools());
			this.logService.debug(
				`[chatgpt] no tools selected for request ${requestId}, using all ${allTools.length} registered tools`
			);
			return allTools;
		}
		const allowedIds = Object.keys(selected).filter(
			(id) => selected[id] === true
		);
		if (!allowedIds.length) {
			const allTools = Array.from(this.languageModelToolsService.getTools());
			this.logService.debug(
				`[chatgpt] tool selection for request ${requestId} contained no enabled entries, using all ${allTools.length} registered tools`
			);
			return allTools;
		}
		const allowedSet = new Set(allowedIds);
		const allowedTools: IToolData[] = [];
		for (const tool of this.languageModelToolsService.getTools()) {
			if (allowedSet.has(tool.id)) {
				allowedTools.push(tool);
			}
		}
		this.logService.debug(
			`[chatgpt] resolved ${allowedTools.length
			} tools for request ${requestId}: ${allowedTools
				.map((tool) => tool.id)
				.join(", ")}`
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

		return { tools: functions, nameToToolId };
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

	private extractResponseContent(
		part: IChatProgressHistoryResponseContent | IChatTaskDto
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

	private async buildMessages(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<{
		messages: OpenAIMessage[];
		contextEntries: IContextBlockMetadata[];
	}> {
		const messages: OpenAIMessage[] = [];
		const contextPrompt = await this.contextBuilder.buildContextPrompt(
			request,
			token
		);
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
						typeof value === "string" && value.length > 0
				)
				.join("\n");
			if (assistantText) {
				messages.push({ role: "assistant", content: assistantText });
			}
		}

		messages.push({ role: "user", content: request.message });

		return { messages, contextEntries };
	}

	private async performRequest(
		messages: OpenAIMessage[],
		tools: OpenAIFunction[],
		token: CancellationToken,
		model: string,
		context?: string,
		toolResults?: ServerToolResult[]
	): Promise<ChatGPTStreamingResponse> {
		const toolNames = tools.map((f) => f.function.name);
		this.logService.info(
			`[chatgpt-server] performRequest: model=${model}, messages=${messages.length
			}, tools=${toolNames.join(", ") || "none"
			}, hasContext=${!!context}, toolResults=${toolResults?.length || 0}`
		);

		const accessToken = await this.getAccessToken();
		if (!accessToken) {
			throw new Error(
				localize(
					"chatgpt.noAuthToken",
					"Authentication token is missing. Please sign in to use ChatGPT."
				)
			);
		}

		const ideMessages = convertOpenAIMessagesToIDE(messages, this.logService);
		validateIDEFormat(ideMessages);
		this.logService.debug(
			`[chatgpt-server] Message format validation passed: ${ideMessages.length} messages in IDE format`
		);

		const serverTools = tools.map((tool) => {
			let parameters: Record<string, unknown> & {
				type?: string;
				properties?: Record<string, unknown>;
			};
			const rawParameters = tool.function.parameters;
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
				// Ensure type: "object"
				if (!("type" in parameters) || parameters.type !== "object") {
					parameters = { ...parameters, type: "object" };
				}
				// Ensure properties exist
				if (
					!("properties" in parameters) ||
					typeof parameters.properties !== "object" ||
					parameters.properties === null ||
					Array.isArray(parameters.properties)
				) {
					parameters = { ...parameters, properties: {} };
				}
				// Ensure all properties have both type and description (required by server schema)
				if (parameters.properties) {
					const props = parameters.properties as Record<string, any>;
					for (const key in props) {
						if (
							props[key] &&
							typeof props[key] === "object" &&
							props[key] !== null &&
							!Array.isArray(props[key])
						) {
							const prop = props[key];
							// Ensure type exists (default to 'string' if missing)
							if (!("type" in prop) || typeof prop.type !== "string") {
								props[key] = { ...prop, type: "string" };
							}
							// Ensure description exists (default to empty string if missing)
							if (!("description" in props[key])) {
								props[key] = { ...props[key], description: "" };
							}
						}
					}
				}
			}
			return {
				name: tool.function.name,
				description: tool.function.description,
				parameters,
			};
		});

		const endpoint: "/api/agent/tools" = "/api/agent/tools";
		const hasToolResults = toolResults && toolResults.length > 0;

		this.logService.info(
			`[chatgpt-server] Using endpoint: ${endpoint} (tools=${serverTools.length
			}, toolResults=${toolResults?.length || 0})`
		);

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
				tools: serverTools,
				toolResults: hasToolResults ? toolResults : undefined,
			},
			this.logService
		);

		response.result.then(
			(result) => {
				this.logService.info(
					`[chatgpt-server] Request completed: ${result.parts.length
					} parts, finishReason=${result.finishReason || "none"}`
				);
			},
			(error) => {
				this.logService.error(
					`[chatgpt-server] Streaming request failed: ${error instanceof Error ? error.message : String(error)
					}`
				);
			}
		);
		return response;
	}

	private createToolInvocation(
		callId: string,
		toolId: string,
		parameters: Record<string, unknown>,
		request: IChatAgentRequest
	): IToolInvocation {
		return {
			callId,
			toolId,
			parameters,
			context: { sessionId: request.sessionId },
			chatRequestId: request.requestId,
		};
	}
}
