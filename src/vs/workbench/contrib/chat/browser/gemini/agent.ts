/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import {
	IChatAgentImplementation,
	IChatAgentHistoryEntry,
	IChatAgentRequest,
	IChatAgentResult,
	UserSelectedTools,
	IChatAgentService,
} from '../../common/chatAgents.js';
import {
	ChatErrorLevel,
	IChatProgress,
} from '../../common/chatService.js';
import {
	ILanguageModelsService,
	IChatMessage,
	ChatMessageRole,
} from '../../common/languageModels.js';
import {
	ILanguageModelToolsService,
	IToolData,
	CountTokensCallback,
	IToolInvocation,
	IToolResultTextPart,
} from '../../common/languageModelToolsService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { hasKey } from '../../../../../base/common/types.js';
import { GEMINI_MODELS } from './models.js';
// @ts-ignore - Module resolution error is false positive, files exist
import type { ServerToolResult, ChatGPTStreamingResponse } from '../chatgpt/types.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { validateIDEFormat } from '../chatgpt/validation.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { sendChatGPTRequest } from '../chatgpt/request.js';
import { extractTextFromParts, extractResponseContent } from './utils.js';
import { ContextBuilder } from './context.js';
import type { GeminiContentPart, IContextBlockMetadata } from './types.js';

export class GeminiAgentImplementation implements IChatAgentImplementation {
	private readonly requestTools = new Map<string, UserSelectedTools>();
	private readonly fallbackCountTokens: CountTokensCallback = async (
		input: string,
		_token: CancellationToken,
	) => input.length;
	private readonly contextBuilder: ContextBuilder;

	constructor(
		private readonly requestService: IRequestService,
		private readonly serverAddress: string,
		private readonly secretStorageService: ISecretStorageService,
		private readonly logService: ILogService,
		textModelService: ITextModelService,
		private readonly languageModelToolsService: ILanguageModelToolsService,
		private readonly languageModelsService: ILanguageModelsService,
		private readonly chatAgentService: IChatAgentService,
	) {
		this.contextBuilder = new ContextBuilder(textModelService, logService);
	}

	private async getAccessToken(): Promise<string | undefined> {
		try {
			const token = await this.secretStorageService.get('ren.auth.accessToken');
			if (token) {
				this.logService.debug(`[gemini-server] Access token retrieved successfully (length: ${token.length})`);
			} else {
				this.logService.warn(`[gemini-server] No access token found in secret storage. User needs to authenticate.`);
			}
			return token ?? undefined;
		} catch (error) {
			this.logService.error(
				`[gemini-server] Error retrieving access token: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private resolveModelFromRequest(userSelectedModelId?: string): string {
		if (userSelectedModelId) {
			const selectedModelConfig = GEMINI_MODELS.find(m => m.identifier === userSelectedModelId);
			if (selectedModelConfig) {
				return selectedModelConfig.id;
			}
		}
		const defaultModel = GEMINI_MODELS.find(m => m.isDefault);
		return defaultModel?.id || 'gemini-2.5-flash';
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		if (token.isCancellationRequested) {
			return { details: 'cancelled' };
		}

		// Check if user selected a model from a different vendor
		if (request.userSelectedModelId) {
			const selectedModelMetadata = this.languageModelsService.lookupLanguageModel(request.userSelectedModelId);
			if (selectedModelMetadata && selectedModelMetadata.vendor !== 'google') {
				// If the selected model is OpenAI, route through the ChatGPT agent so tools execute
				if (selectedModelMetadata.vendor === 'openai' || request.userSelectedModelId.startsWith('openai/')) {
					return this.chatAgentService.invokeAgent(
						'chatgpt.local',
						request,
						progress,
						history,
						token,
					);
				}
				// Otherwise, delegate to language models service for cross-vendor model
				return this.invokeViaLanguageModelsService(request, progress, history, token, request.userSelectedModelId);
			}
		}

		// Resolve the model to use from request
		const modelToUse = this.resolveModelFromRequest(request.userSelectedModelId);

		// Read tools from request object first (setRequestTools() may not be called for initial value)
		if (request.userSelectedTools) {
			this.logService.debug(`[gemini] reading tools from request object for request ${request.requestId}: ${JSON.stringify(request.userSelectedTools)}`);
			this.requestTools.set(request.requestId, request.userSelectedTools);
		}

		const { messages, contextEntries } = await this.buildMessages(request, history, token);
		const { tools: toolConfigs, nameToToolId, summaries } = this.buildGeminiToolDeclarations(request.requestId);
		if (summaries.length) {
			messages.push({
				role: ChatMessageRole.System,
				content: [{
					type: 'text',
					value: `You can call the following tools by name when they would help:
${summaries.map(summary => `- ${summary}`).join('\n')}
Only call a tool if it is necessary; otherwise respond normally.`
				}]
			});
		}
		const maxIterations = 10;
		let iteration = 0;
		let toolResults: ServerToolResult[] | undefined = undefined;

		try {
			while (iteration < maxIterations) {
				if (token.isCancellationRequested) {
					return { details: 'cancelled' };
				}

				const streamingResponse = await this.performRequest(messages, toolConfigs, token, modelToUse, toolResults);
				let streamedText = false;

				try {
					for await (const chunk of streamingResponse.stream) {
						if (token.isCancellationRequested) {
							break;
						}
						// Convert ChatGPTContentPart[] to GeminiContentPart[] for display
						const geminiParts: GeminiContentPart[] = chunk.map((part: { text?: string; toolCall?: { name: string; id: string; args: Record<string, unknown> } }) => {
							if (part.text !== undefined) {
								return { text: part.text };
							} else if (part.toolCall) {
								return { functionCall: { name: part.toolCall.name, args: part.toolCall.args } };
							}
							return { text: '' };
						}).filter((part: GeminiContentPart) => hasKey(part, { text: true }) ? part.text.length > 0 : true);

						const delta = extractTextFromParts(geminiParts, false);
						if (delta.length) {
							const markdownChunk = new MarkdownString(delta);
							markdownChunk.supportThemeIcons = true;
							progress([{ kind: 'markdownContent', content: markdownChunk }]);
							streamedText = true;
						}
					}
				} catch (error) {
					if (!token.isCancellationRequested) {
						throw error;
					}
				}

				if (token.isCancellationRequested) {
					return { details: 'cancelled' };
				}

				const responseData = await streamingResponse.result;
				const responseParts = responseData.parts;

				// Add assistant message with both text and tool_use parts if present
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const toolCallParts = responseParts.filter((part: any) => part.toolCall !== undefined);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const textParts = responseParts.filter((part: any) => part.text !== undefined);

				const assistantContent: Array<{ type: 'text'; value: string } | { type: 'tool_use'; name: string; toolCallId: string; parameters: Record<string, unknown> }> = [];

				// Add text content if present
				if (textParts.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const textContent = textParts.map((part: any) => part.text || '').join('');
					if (textContent.trim().length) {
						assistantContent.push({ type: 'text', value: textContent });
					}
				}

				// Add tool_use parts if present
				if (toolCallParts.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const toolUseParts = toolCallParts.map((part: any) => {
						const toolCall = part.toolCall;
						return {
							type: 'tool_use' as const,
							name: toolCall.name,
							toolCallId: toolCall.id,
							parameters: toolCall.args
						};
					});
					assistantContent.push(...toolUseParts);
				}

				// Add assistant message if there's any content
				if (assistantContent.length > 0) {
					messages.push({
						role: ChatMessageRole.Assistant,
						content: assistantContent
					});
				}

				// Check if there are tool calls to process
				if (!toolCallParts.length) {
					const responseText = textParts.map((part: { text?: string }) => part.text || '').join('') || localize('gemini.emptyTextResponse', "Gemini did not return any text.");

					await this.contextBuilder.tryAutoApplyEdits(responseText, contextEntries, progress, token);

					if (!streamedText) {
						const markdown = new MarkdownString(responseText);
						markdown.supportThemeIcons = true;
						progress([{ kind: 'markdownContent', content: markdown }]);
					}

					return {
						details: 'gemini-response',
						metadata: { model: modelToUse }
					};
				}

				if (!toolConfigs.length) {
					const errorMessage = localize('gemini.toolsNotAuthorized', "Gemini requested tool calls but none were authorized for this request.");
					progress([{ kind: 'markdownContent', content: new MarkdownString(errorMessage) }]);
					return {
						errorDetails: { message: errorMessage, level: ChatErrorLevel.Error },
						details: errorMessage,
					};
				}

				const toolResultsForNextRequest: ServerToolResult[] = [];

				for (const callPart of toolCallParts) {
					if (token.isCancellationRequested) {
						return { details: 'cancelled' };
					}

					const toolName = callPart.toolCall!.name;
					const toolId = nameToToolId.get(toolName);
					if (!toolId) {
						this.logService.error(
							`[gemini-server] model requested unknown tool name '${toolName}'. Available names: ${Array.from(nameToToolId.keys()).join(', ')}`,
						);
						toolResultsForNextRequest.push({
							toolCallId: callPart.toolCall!.id,
							content: [{
								type: 'text',
								value: localize('gemini.unknownToolCall', 'Gemini requested unknown tool {0}.', toolName),
							}],
						});
						continue;
					}

					const parameters = callPart.toolCall!.args ?? {};
					const callId = callPart.toolCall!.id;
					const invocation = this.createToolInvocation(callId, toolId, parameters, request);

					try {
						const result = await this.languageModelToolsService.invokeTool(
							invocation,
							this.fallbackCountTokens,
							token,
						);
						const textOutput = (result.content ?? [])
							.filter((part): part is IToolResultTextPart => part.kind === 'text')
							.map(part => part.value)
							.join('\n');
						toolResultsForNextRequest.push({
							toolCallId: callId,
							content: [{ type: 'text', value: textOutput }],
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.logService.error(`[gemini-server] tool ${toolId} failed: ${message}`);
						toolResultsForNextRequest.push({
							toolCallId: callId,
							content: [{ type: 'text', value: message }],
						});
					}
				}

				if (toolResultsForNextRequest.length === 0) {
					throw new Error(
						localize('gemini.noToolResponses', 'Gemini requested tool calls but no responses were produced.'),
					);
				}

				toolResults = toolResultsForNextRequest;
				this.logService.info(`[gemini-server] Collected ${toolResults.length} tool results for next request`);
				iteration++;
			}

			throw new Error(localize('gemini.maxToolIterations', "Reached the maximum number of tool call iterations without producing an answer."));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[gemini] ${message}`);

			const markdown = new MarkdownString(localize('gemini.error', "Gemini request failed: {0}", message));
			markdown.isTrusted = true;
			progress([{ kind: 'markdownContent', content: markdown }]);

			return {
				errorDetails: {
					message,
					level: ChatErrorLevel.Error
				},
				details: message
			};
		} finally {
			this.requestTools.delete(request.requestId);
			this.languageModelToolsService.cancelToolCallsForRequest(request.requestId);
		}
	}

	private async invokeViaLanguageModelsService(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelId: string,
	): Promise<IChatAgentResult> {
		this.logService.info(`[gemini] Delegating request to language models service for model ${modelId} (cross-vendor)`);

		const messages: IChatMessage[] = [];

		// Add context prompt if available
		const contextPrompt = await this.contextBuilder.buildContextPrompt(request, token);
		if (contextPrompt) {
			messages.push({
				role: ChatMessageRole.User,
				content: [{ type: 'text', value: contextPrompt.prompt }]
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
					content: [{ type: 'text', value: userMessage }]
				});
			}
			const assistantText = entry.response
				?.map(part => extractResponseContent(part))
				.filter((value): value is string => typeof value === 'string' && value.length > 0)
				.join('\n');
			if (assistantText) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: assistantText }]
				});
			}
		}

		// Add current request
		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: request.message }]
		});

		try {
			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				new ExtensionIdentifier('core.gemini'),
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
					if (part.type === 'text') {
						const markdownChunk = new MarkdownString(part.value);
						markdownChunk.supportThemeIcons = true;
						progress([{ kind: 'markdownContent', content: markdownChunk }]);
					}
				}
			}

			await response.result;

			return {
				details: 'gemini-response',
				metadata: { model: modelId, delegated: true }
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[gemini] Error in delegated request for model ${modelId}:`, error);
			const markdown = new MarkdownString(localize('gemini.error', "Gemini request failed: {0}", message));
			markdown.isTrusted = true;
			progress([{ kind: 'markdownContent', content: markdown }]);
			return {
				errorDetails: {
					message,
					level: ChatErrorLevel.Error
				},
				details: message
			};
		}
	}

	setRequestTools(requestId: string, tools: UserSelectedTools): void {
		if (!tools) {
			this.logService.debug(`[gemini] clearing tool selection for request ${requestId}`);
			this.requestTools.delete(requestId);
			return;
		}
		this.logService.debug(`[gemini] received tool selection for request ${requestId}: ${JSON.stringify(tools)}`);
		this.requestTools.set(requestId, tools);
	}

	private getAllowedToolData(requestId: string): IToolData[] {
		const selected = this.requestTools.get(requestId);
		if (!selected) {
			this.logService.debug(`[gemini] no tools selected for request ${requestId}`);
			return [];
		}
		const allowedIds = Object.keys(selected).filter(id => selected[id] === true);
		if (!allowedIds.length) {
			this.logService.debug(`[gemini] tool selection for request ${requestId} contained no enabled entries`);
			return [];
		}
		const allowedSet = new Set(allowedIds);
		const allowedTools: IToolData[] = [];
		for (const tool of this.languageModelToolsService.getTools()) {
			if (allowedSet.has(tool.id)) {
				allowedTools.push(tool);
			}
		}
		this.logService.debug(`[gemini] resolved ${allowedTools.length} tools for request ${requestId}: ${allowedTools.map(tool => tool.id).join(', ')}`);
		return allowedTools;
	}

	private buildGeminiToolDeclarations(requestId: string): { tools: Array<{ name: string; description?: string; parameters: unknown }>; nameToToolId: Map<string, string>; summaries: string[] } {
		const allowedTools = this.getAllowedToolData(requestId);
		if (!allowedTools.length) {
			return { tools: [], nameToToolId: new Map(), summaries: [] };
		}

		const usedNames = new Set<string>();
		const nameToToolId = new Map<string, string>();
		const serverTools: Array<{ name: string; description?: string; parameters: unknown }> = [];
		const summaries: string[] = [];

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

			const description = descriptionParts.length ? descriptionParts.join(' ') : undefined;

			// Apply same parameters validation as ChatGPT
			let parameters: Record<string, unknown> & { type?: string; properties?: Record<string, unknown> };
			const rawParameters = tool.inputSchema;
			if (!rawParameters || typeof rawParameters !== 'object' || rawParameters === null || Array.isArray(rawParameters)) {
				parameters = { type: 'object', properties: {} };
			} else {
				// Cast to object type for type narrowing
				parameters = rawParameters as Record<string, unknown> & { type?: string; properties?: Record<string, unknown> };
				// Ensure type: "object"
				// Note: Using 'in' operator here matches ChatGPT agent pattern (see chatgpt/agent.ts:639, 643)
				// The linter warning is acceptable as this matches the established pattern
				if (!('type' in parameters) || parameters.type !== 'object') {
					parameters = { ...parameters, type: 'object' };
				}
				// Ensure properties exist
				// Note: Using 'in' operator here matches ChatGPT agent pattern (see chatgpt/agent.ts:639, 643)
				// The linter warning is acceptable as this matches the established pattern
				if (!('properties' in parameters) || typeof parameters.properties !== 'object' || parameters.properties === null || Array.isArray(parameters.properties)) {
					parameters = { ...parameters, properties: {} };
				}
				// Ensure all properties have both type and description (required by server schema)
				if (parameters.properties) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const props = parameters.properties as Record<string, any>;
					for (const key in props) {
						if (props[key] && typeof props[key] === 'object' && props[key] !== null && !Array.isArray(props[key])) {
							const prop = props[key];
							// Ensure type exists (default to 'string' if missing)
							// Note: Using 'in' operator here matches ChatGPT agent pattern (see chatgpt/agent.ts:653)
							// The linter warning is acceptable as this matches the established pattern
							if (!('type' in prop) || typeof prop.type !== 'string') {
								props[key] = { ...prop, type: 'string' };
							}
							// Ensure description exists (default to empty string if missing)
							// Note: Using 'in' operator here matches ChatGPT agent pattern (see chatgpt/agent.ts:657)
							// The linter warning is acceptable as this matches the established pattern
							if (!('description' in props[key])) {
								props[key] = { ...props[key], description: '' };
							}
						}
					}
				}
			}

			summaries.push(`${functionName}: ${description ?? tool.toolReferenceName ?? tool.id}`);

			serverTools.push({
				name: functionName,
				description,
				parameters
			});
		}

		return {
			tools: serverTools,
			nameToToolId,
			summaries
		};
	}

	private sanitizeToolName(tool: IToolData, index: number, usedNames: Set<string>): string {
		const rawBase = tool.toolReferenceName ?? tool.id;
		let base = rawBase
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_+/, '')
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

	private async performRequest(
		messages: IChatMessage[],
		tools: Array<{ name: string; description?: string; parameters: unknown }>,
		token: CancellationToken,
		model: string,
		toolResults?: ServerToolResult[],
	): Promise<ChatGPTStreamingResponse> {
		const toolNames = tools.map(t => t.name || '<unnamed>');
		this.logService.info(
			`[gemini-server] performRequest: model=${model}, messages=${messages.length}, tools=${toolNames.join(', ') || 'none'}, toolResults=${toolResults?.length || 0}`,
		);

		const accessToken = await this.getAccessToken();
		if (!accessToken) {
			throw new Error(
				localize('gemini.noAuthToken', 'Authentication token is missing. Please sign in to use Gemini.'),
			);
		}

		validateIDEFormat(messages);
		this.logService.debug(`[gemini-server] Message format validation passed: ${messages.length} messages in IDE format`);

		const endpoint: '/api/agent/tools' = '/api/agent/tools';
		const hasToolResults = toolResults && toolResults.length > 0;

		this.logService.info(`[gemini-server] Using endpoint: ${endpoint} (tools=${tools.length}, toolResults=${toolResults?.length || 0})`);

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
			},
			this.logService,
			'gemini',
		);

		response.result.then(
			(result: { parts: Array<{ text?: string; toolCall?: { name: string; id: string; args: Record<string, unknown> } }>; finishReason?: string | null }) => {
				this.logService.info(
					`[gemini-server] Request completed: ${result.parts.length} parts, finishReason=${result.finishReason || 'none'}`,
				);
			},
			(error: unknown) => {
				this.logService.error(`[gemini-server] Streaming request failed: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
		return response;
	}

	private createToolInvocation(callId: string, toolId: string, parameters: Record<string, unknown>, request: IChatAgentRequest): IToolInvocation {
		return {
			callId,
			toolId,
			parameters,
			context: { sessionId: request.sessionId },
			chatRequestId: request.requestId
		};
	}

	private async buildMessages(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<{ messages: IChatMessage[]; contextEntries: IContextBlockMetadata[] }> {
		const messages: IChatMessage[] = [];
		const contextPrompt = await this.contextBuilder.buildContextPrompt(request, token);
		const contextEntries = contextPrompt?.entries ?? [];
		if (contextPrompt) {
			messages.push({
				role: ChatMessageRole.User,
				content: [{ type: 'text', value: contextPrompt.prompt }]
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
					content: [{ type: 'text', value: userMessage }]
				});
			}
			const assistantText = entry.response
				?.map(part => extractResponseContent(part))
				.filter((value): value is string => typeof value === 'string' && value.length > 0)
				.join('\n');
			if (assistantText) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: assistantText }]
				});
			}
		}

		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: request.message }]
		});

		return { messages, contextEntries };
	}
}

