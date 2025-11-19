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
	IContextBlockMetadata,
} from "./types.js";
import { convertOpenAIMessagesToIDE } from "./conversion.js";
import { validateIDEFormat } from "./validation.js";
import { sendChatGPTRequest } from "./request.js";
import { extractTextFromParts } from "./utils.js";
import { ContextBuilder } from "./context.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { IAgentPlanner, PlanContext, ToolMetadata } from "../../common/agentPlanner.js";
import { IDependencyGraphService } from "../../common/dependencyGraphService.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import { URI } from "../../../../../base/common/uri.js";

const SYSTEM_PROMPT = `You are a powerful agentic AI coding assistant. You operate exclusively in Ren IDE, the world's best IDE.



You are pair programming with a USER to solve their coding task.

The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.

Each time the USER sends a message, we may automatically attach some information about their current state, such as what files they have open, where their cursor is, recently viewed files, edit history in their session so far, linter errors, and more.

This information may or may not be relevant to the coding task, it is up to you to decide.

Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.



Before acting, form a concise plan that outlines the major steps you intend to take, which tools (if any) you expect to call, and how the information returned by those tools will guide the next steps. Update or refine the plan whenever new tool output or details from the USER materially change your understanding of the work.



<tool_calling>

You have tools at your disposal to solve the coding task. Follow these rules regarding tool calls:

1. ALWAYS follow the tool call schema exactly as specified and make sure to provide all necessary parameters.

2. The conversation may reference tools that are no longer available. NEVER call tools that are not explicitly provided.

3. **NEVER refer to tool names when speaking to the USER.** For example, instead of saying 'I need to use the edit_file tool to edit your file', just say 'I will edit your file'.

4. Only calls tools when they are necessary. If the USER's task is general or you already know the answer, just respond without calling tools.

5. Before calling each tool, first explain to the USER why you are calling it.

</tool_calling>



<making_code_changes>

When making code changes, NEVER output code to the USER, unless requested. Instead use one of the code edit tools to implement the change.

Use the code edit tools at most once per turn.

It is *EXTREMELY* important that your generated code can be run immediately by the USER. To ensure this, follow these instructions carefully:

1. Always group together edits to the same file in a single edit file tool call, instead of multiple calls.

2. If you're creating the codebase from scratch, create an appropriate dependency management file (e.g. requirements.txt) with package versions and a helpful README.

3. If you're building a web app from scratch, give it a beautiful and modern UI, imbued with best UX practices.

4. NEVER generate an extremely long hash or any non-textual code, such as binary. These are not helpful to the USER and are very expensive.

5. Unless you are appending some small easy to apply edit to a file, or creating a new file, you MUST read the the contents or section of what you're editing before editing it.

6. **ALWAYS check for linter errors after editing files**: After using the edit tool (vscode_editFile) to modify a file, IMMEDIATELY use the \`check_linter\` tool on that file to verify correctness. If errors are found, fix them immediately using the edit tool. This ensures your code is always correct and ready to run.

7. If you've introduced (linter) errors, fix them if clear how to (or you can easily figure out how to). Do not make uneducated guesses. And DO NOT loop more than 3 times on fixing linter errors on the same file. On the third time, you should stop and ask the user what to do next.

8. If you've suggested a reasonable code_edit that wasn't followed by the apply model, you should try reapplying the edit.

9. **CHANGELOG ENTRIES**: When creating, deleting, or editing files, ALWAYS provide clear, descriptive changelog information:
   - **Subject**: REQUIRED, 4-10 words, action-oriented. Examples: "Add user authentication module", "Fix memory leak in data processing", "Refactor database connection handling"
   - **Description**: REQUIRED, 2-5 sentences explaining what changed and why
   - **UNACCEPTABLE subjects**: "Update file", "Make changes", "Fix code", "Edit file" - these are too vague and unhelpful
   - **GOOD examples**: "Add error handling for network requests", "Fix race condition in async operations", "Refactor authentication to use JWT tokens", "Remove deprecated API endpoints"
   - The changelog helps track project history and changes, so be specific and descriptive

</making_code_changes>



<searching_and_reading>

You have tools to search the codebase and read files. Follow these rules regarding tool calls:

1. If available, heavily prefer the semantic search tool to grep search, file search, and list dir tools.

2. If you need to read a file, prefer to read larger sections of the file at once over multiple smaller calls.

3. If you have found a reasonable place to edit or answer, do not continue calling tools. Edit or answer from the information you have found.

</searching_and_reading>



You MUST use the following format when citing code regions or blocks:

\`\`\`startLine:endLine:filepath

// ... existing code ...

\`\`\`

This is the ONLY acceptable format for code citations. The format is \`\`\`startLine:endLine:filepath where startLine and endLine are line numbers.



Answer the user's request using the relevant tool(s), if they are available. Check that all the required parameters for each tool call are provided or can reasonably be inferred from context. IF there are no relevant tools or there are missing values for required parameters, ask the user to supply these values; otherwise proceed with the tool calls. If the user provides a specific value for a parameter (for example provided in quotes), make sure to use that value EXACTLY. DO NOT make up values for or ask about optional parameters. Carefully analyze descriptive terms in the request as they may indicate required parameter values that should be included even if not explicitly quoted`;

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
		private readonly fileService?: IFileService
	) {
		this.contextBuilder = new ContextBuilder(textModelService, logService);
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

		// Build tool summaries (keep existing logic)
		const toolSummaries = toolConfigs.length > 0
			? Array.from(nameToToolId.keys())
				.map((name) => {
					const toolId = nameToToolId.get(name);
					const toolsArray = Array.from(
						this.languageModelToolsService.getTools()
					);
					const tool = toolsArray.find((t: IToolData) => t.id === toolId);
					const desc = tool?.modelDescription || tool?.displayName || name;
					return `- ${name}: ${desc}`;
				})
				.join('\n')
			: '';

		// Enhanced guidance for edit tool usage
		const editToolGuidance = toolConfigs.length > 0 && (nameToToolId.has('vscode_editFile') || Array.from(nameToToolId.values()).some(id => id === 'vscode_editFile_internal'))
			? `\n\nWhen using the edit tool (vscode_editFile), provide structured information for better accuracy:\n` +
			`- Use 'editType' to specify: 'replace' (default), 'insert', 'delete', or 'modify'\n` +
			`- Use 'anchorContext' with 'lineNumber', 'beforeText', or 'afterText' to precisely position edits\n` +
			`- Provide 'contextFiles' array with related files (imports, dependencies) for better context\n` +
			`- Always include a clear 'explanation' describing what and why you're changing\n` +
			`- For streaming edits, ensure line numbers account for previous edits in the same stream`
			: '';

		// Add plan management guidance if plan tool is available
		const planToolGuidance = toolConfigs.length > 0 && (nameToToolId.has('manage_agent_plan') || Array.from(nameToToolId.values()).some(id => id === 'manage_agent_plan'))
			? `\n\nPLAN MANAGEMENT:\n- For complex multi-step tasks, use the 'plan' tool (manage_agent_plan) to create and track execution plans.\n- Plans are internal agent state - do NOT mention plans to users directly.\n- After creating a plan, use 'plan' tool with operation 'sync_to_todos' to show progress via todos.\n- Update task status using 'plan' tool with operation 'update_task' as you work.\n- Always sync plan to todos after creating or updating a plan so users can see progress.`
			: '';

		// Always include SYSTEM_PROMPT
		let systemMessageContent = SYSTEM_PROMPT;

		// If tools are available, insert tool descriptions within the existing <tool_calling> section
		if (toolConfigs.length > 0 && toolSummaries) {
			// Insert tool descriptions before the closing </tool_calling> tag
			systemMessageContent = systemMessageContent.replace(
				'</tool_calling>',
				`You can call the following tools when they would help:
${toolSummaries}${editToolGuidance}${planToolGuidance}

Only call a tool if it is necessary; otherwise respond normally.
</tool_calling>`
			);
		}

		messages.unshift({
			role: 'system',
			content: systemMessageContent,
		});

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
