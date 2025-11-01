/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { registerWorkbenchContribution2, IWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatAgentService, IChatAgentImplementation, IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult, UserSelectedTools } from '../common/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../common/constants.js';
import { IChatProgressHistoryResponseContent } from '../common/chatModel.js';
import { ChatErrorLevel, IChatProgress, IChatTaskDto } from '../common/chatService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../common/chatContextKeys.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelsService, IChatMessage, IChatResponsePart, IChatResponseTextPart, ChatMessageRole } from '../common/languageModels.js';
import { ILanguageModelToolsService, IToolData, CountTokensCallback, IToolInvocation, IToolResult, IToolResultTextPart } from '../common/languageModelToolsService.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IChatRequestVariableEntry, isChatRequestFileEntry, isImplicitVariableEntry, isPasteVariableEntry } from '../common/chatVariableEntries.js';
import { basename } from '../../../../base/common/resources.js';
import { isLocation, Location, TextEdit } from '../../../../editor/common/languages.js';
import { Range, IRange } from '../../../../editor/common/core/range.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { env } from '../../../../base/common/process.js';
import { IRequestService, asJson, isSuccess } from '../../../../platform/request/common/request.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
type GeminiRole = 'user' | 'model';

type GeminiContentPart =
	| { text: string }
	| { functionCall: { name: string; args: Record<string, unknown> } }
	| { functionResponse: { name: string; response: unknown } };

interface GeminiContent {
	readonly role: GeminiRole;
	readonly parts: GeminiContentPart[];
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

interface GeminiFunctionDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: unknown;
}

interface GeminiToolConfig {
	readonly functionDeclarations: GeminiFunctionDeclaration[];
}
interface GeminiRequestOptions {
	readonly tools?: GeminiToolConfig[];
}
interface GeminiResponse {
	readonly parts: GeminiContentPart[];
}

async function sendGeminiRequest(
	requestService: IRequestService,
	apiKey: string,
	model: string,
	messages: GeminiContent[],
	token: CancellationToken,
	options?: GeminiRequestOptions
): Promise<GeminiResponse> {
	const contents = messages.map(msg => ({
		role: msg.role,
		parts: msg.parts
	}));

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
	const payload: Record<string, unknown> = { contents };
	if (options?.tools && options.tools.length) {
		payload['tools'] = options.tools;
	}

	// Log payload structure for verification (sanitized - don't log full contents)
	const toolCount = options?.tools?.flatMap(t => t.functionDeclarations ?? []).length ?? 0;
	const payloadInfo = {
		hasContents: !!payload.contents,
		contentsCount: Array.isArray(payload.contents) ? (payload.contents as unknown[]).length : 0,
		hasTools: !!payload.tools,
		toolCount,
		functionNames: options?.tools?.flatMap(t => t.functionDeclarations?.map(d => d.name) ?? []) ?? []
	};
	console.debug(`[gemini] request payload structure:`, payloadInfo);

	const body = JSON.stringify(payload);

	const context = await requestService.request({
		type: 'POST',
		url,
		data: body,
		headers: {
			'Content-Type': 'application/json'
		}
	}, token);

	if (!isSuccess(context)) {
		const buffer = await streamToBuffer(context.stream);
		const errorText = buffer.toString();
		throw new Error(`Gemini API error: ${context.res.statusCode} - ${errorText || 'Unknown error'}`);
	}

	const response = await asJson<{
		candidates?: Array<{
			content?: {
				parts?: Array<{
					text?: string;
					functionCall?: {
						name: string;
						args?: unknown;
					};
				}>;
			};
		}>;
	}>(context);

	const partsSource = response?.candidates?.[0]?.content?.parts;
	if (!partsSource || !partsSource.length) {
		throw new Error(localize('gemini.invalidResponse', "Model returned an empty response."));
	}

	const parts: GeminiContentPart[] = [];
	for (const part of partsSource) {
		if (typeof part.text === 'string') {
			parts.push({ text: part.text });
			continue;
		}
		if (part.functionCall) {
			const args = normalizeFunctionCallArgs(part.functionCall.args);
			parts.push({ functionCall: { name: part.functionCall.name, args } });
		}
	}

	if (!parts.length) {
		throw new Error(localize('gemini.emptyParts', "Gemini response did not include any usable parts."));
	}

	return { parts };
}
function normalizeFunctionCallArgs(args: unknown): Record<string, unknown> {
	if (args && typeof args === 'object') {
		return args as Record<string, unknown>;
	}
	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			if (parsed && typeof parsed === 'object') {
				return parsed as Record<string, unknown>;
			}
		} catch (error) {
			console.warn('[gemini] Failed to parse function call arguments', error);
		}
	}
	return {};
}

function reduceMessageParts(message: IChatMessage): string {
	const parts = message.content ?? [];
	const segments: string[] = [];
	for (const part of parts) {
		if (part.type === 'text') {
			segments.push(part.value);
		}
	}
	return segments.join('\n');
}

function toGeminiContents(messages: IChatMessage[]): GeminiContent[] {
	return messages.map(entry => {
		const role: GeminiRole = entry.role === ChatMessageRole.Assistant ? 'model' : 'user';
		const parts: GeminiContentPart[] = [];
		const callIdToName = new Map<string, string>();

		for (const part of entry.content ?? []) {
			switch (part.type) {
				case 'text': {
					if (part.value.length) {
						parts.push({ text: part.value });
					}
					break;
				}
				case 'tool_use': {
					const parameters = typeof part.parameters === 'object' && part.parameters !== null ? part.parameters as Record<string, unknown> : { value: part.parameters };
					parts.push({ functionCall: { name: part.name, args: parameters } });
					callIdToName.set(part.toolCallId, part.name);
					break;
				}
				case 'tool_result': {
					const toolName = callIdToName.get(part.toolCallId) ?? part.toolCallId;
					const response: Record<string, unknown> = {};
					const textOutputs = part.value
						.filter((valuePart): valuePart is IChatResponseTextPart => valuePart.type === 'text')
						.map(valuePart => valuePart.value)
						.join('\n');
					if (textOutputs.length) {
						response['text'] = textOutputs;
					}
					if (part.isError) {
						response['isError'] = true;
					}
					if (!Object.keys(response).length) {
						response['text'] = '';
					}
					parts.push({ functionResponse: { name: toolName, response } });
					break;
				}
				default:
					break;
			}
		}

		if (!parts.length) {
			const text = reduceMessageParts(entry);
			if (text.length) {
				parts.push({ text });
			}
		}

		return { role, parts };
	}).filter(message => message.parts.length > 0);
}

class DeepSeekAgentImplementation implements IChatAgentImplementation {

	private readonly requestTools = new Map<string, UserSelectedTools>();
	private readonly fallbackCountTokens: CountTokensCallback = async (input: string, _token: CancellationToken) => input.length;

	constructor(
		private readonly requestService: IRequestService,
		private readonly apiKey: string,
		private readonly logService: ILogService,
		private readonly textModelService: ITextModelService,
		private readonly languageModelToolsService: ILanguageModelToolsService,
		private readonly model: string
	) { }

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {

		if (token.isCancellationRequested) {
			return { details: 'cancelled' };
		}

		// Read tools from request object first (setRequestTools() may not be called for initial value)
		if (request.userSelectedTools) {
			this.logService.debug(`[gemini] reading tools from request object for request ${request.requestId}: ${JSON.stringify(request.userSelectedTools)}`);
			this.requestTools.set(request.requestId, request.userSelectedTools);
		}

		const { messages, contextEntries } = await this.buildMessages(request, history, token);
		const { tools: toolConfigs, nameToToolId, summaries } = this.buildGeminiToolDeclarations(request.requestId);
		if (summaries.length) {
			messages.push({
				role: 'user', parts: [{
					text: `You can call the following tools by name when they would help:
${summaries.map(summary => `- ${summary}`).join('\n')}
Only call a tool if it is necessary; otherwise respond normally.` }]
			});
		}
		const maxIterations = 10;
		let iteration = 0;

		try {
			while (iteration < maxIterations) {
				if (token.isCancellationRequested) {
					return { details: 'cancelled' };
				}

				const responseParts = await this.performRequest(messages, toolConfigs, token);
				messages.push({ role: 'model', parts: responseParts });

				const functionCalls = responseParts.filter((part): part is { functionCall: { name: string; args: Record<string, unknown> } } => hasKey(part, { functionCall: true }) && !!part.functionCall);
				if (!functionCalls.length) {
					const responseText = this.extractTextFromParts(responseParts) || localize('gemini.emptyTextResponse', "Gemini did not return any text.");

					await this.tryAutoApplyEdits(responseText, contextEntries, progress, token);

					const markdown = new MarkdownString(responseText);
					markdown.supportThemeIcons = true;
					progress([{ kind: 'markdownContent', content: markdown }]);

					return {
						details: 'gemini-response',
						metadata: { model: this.model }
					};
				}

				if (!toolConfigs.length) {
					const errorMessage = localize('gemini.toolsNotAuthorized', "Gemini requested tool calls but none were authorized for this request.");
					const errorParts = functionCalls.map(call => this.createFunctionResponseFromToolResult(call.functionCall.name, undefined, errorMessage));
					messages.push({ role: 'user', parts: errorParts });
					iteration++;
					continue;
				}

				const toolResponseParts: GeminiContentPart[] = [];
				for (const callPart of functionCalls) {
					if (token.isCancellationRequested) {
						return { details: 'cancelled' };
					}

					const toolName = callPart.functionCall.name;
					const toolId = nameToToolId.get(toolName);
					if (!toolId) {
						this.logService.warn(`[gemini] model requested unknown tool name ${toolName}`);
						toolResponseParts.push(this.createFunctionResponseFromToolResult(toolName, undefined, localize('gemini.unknownToolCall', "Gemini requested unknown tool {0}.", toolName)));
						continue;
					}

					const parameters = callPart.functionCall.args ?? {};
					const callId = `${request.requestId}:${iteration + 1}:${toolResponseParts.length + 1}`;
					const invocation = this.createToolInvocation(callId, toolId, parameters, request);
					this.logService.debug(`[gemini] invoking tool ${toolId} (${toolName}) with params keys: ${Object.keys(parameters).join(', ')}`);

					try {
						const result = await this.languageModelToolsService.invokeTool(invocation, this.fallbackCountTokens, token);
						this.logService.debug(`[gemini] tool ${toolId} completed successfully`);
						toolResponseParts.push(this.createFunctionResponseFromToolResult(toolName, result));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.logService.warn(`[gemini] tool ${toolId} failed: ${message}`);
						toolResponseParts.push(this.createFunctionResponseFromToolResult(toolName, undefined, message));
					}
				}

				if (toolResponseParts.length === 0) {
					throw new Error(localize('gemini.noToolResponses', "Gemini requested tool calls but no responses were produced."));
				}

				messages.push({ role: 'user', parts: toolResponseParts });
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

	private buildGeminiToolDeclarations(requestId: string): { tools: GeminiToolConfig[]; nameToToolId: Map<string, string>; summaries: string[] } {
		const allowedTools = this.getAllowedToolData(requestId);
		if (!allowedTools.length) {
			return { tools: [], nameToToolId: new Map(), summaries: [] };
		}

		const usedNames = new Set<string>();
		const nameToToolId = new Map<string, string>();
		const functionDeclarations: GeminiFunctionDeclaration[] = [];
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

			const parameters = tool.inputSchema ?? { type: 'object', properties: {} };
			summaries.push(`${functionName}: ${description ?? tool.toolReferenceName ?? tool.id}`);

			functionDeclarations.push({
				name: functionName,
				description,
				parameters
			});
		}

		return {
			tools: [{ functionDeclarations }],
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

	private extractResponseContent(part: IChatProgressHistoryResponseContent | IChatTaskDto): string | undefined {
		switch (part.kind) {
			case 'markdownContent':
			case 'progressMessage':
			case 'warning':
				return (part.content as MarkdownString).value;
			default:
				return undefined;
		}
	}

	private async performRequest(messages: GeminiContent[], tools: GeminiToolConfig[], token: CancellationToken): Promise<GeminiContentPart[]> {
		const toolNames = tools.flatMap(config => config.functionDeclarations.map(decl => decl.name));
		this.logService.debug(`[gemini] invoking model with ${messages.length} messages and tools: ${toolNames.join(', ') || 'none'}`);
		const response = await sendGeminiRequest(this.requestService, this.apiKey, this.model, messages, token, { tools });
		this.logService.debug(`[gemini] model returned parts: ${JSON.stringify(response.parts.map(part => hasKey(part, { functionCall: true }) ? { functionCall: { name: part.functionCall.name, argsKeys: Object.keys(part.functionCall.args ?? {}) } } : hasKey(part, { functionResponse: true }) ? { functionResponse: { name: part.functionResponse.name } } : { text: (part as { text?: string }).text ?? '' }))}`);
		return response.parts;
	}

	private extractTextFromParts(parts: GeminiContentPart[]): string {
		const segments: string[] = [];
		for (const part of parts) {
			if (hasKey(part, { text: true }) && typeof part.text === 'string') {
				segments.push(part.text);
			}
		}
		return segments.join('\n').trim();
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

	private createFunctionResponseFromToolResult(functionName: string, result?: IToolResult, errorMessage?: string): GeminiContentPart {
		if (errorMessage) {
			return { functionResponse: { name: functionName, response: { error: errorMessage } } };
		}
		if (!result) {
			return { functionResponse: { name: functionName, response: { error: localize('gemini.toolNoResult', "Tool call produced no result.") } } };
		}

		const response: Record<string, unknown> = {};
		const textOutput = (result.content ?? [])
			.filter((part): part is IToolResultTextPart => part.kind === 'text')
			.map(part => part.value)
			.join('\n')
			.trim();
		if (textOutput.length) {
			response['text'] = textOutput;
		}
		const messageText = this.stringifyToolMessage(result.toolResultMessage);
		if (messageText) {
			response['message'] = messageText;
		}
		if (result.toolResultError) {
			response['toolError'] = result.toolResultError;
		}
		if (result.toolMetadata !== undefined) {
			response['metadata'] = result.toolMetadata;
		}
		if (!Object.keys(response).length) {
			response['text'] = '';
		}
		return { functionResponse: { name: functionName, response } };
	}

	private stringifyToolMessage(message: string | IMarkdownString | undefined): string | undefined {
		if (!message) {
			return undefined;
		}
		if (typeof message === 'string') {
			return message;
		}
		return message.value ?? undefined;
	}

	private async buildMessages(request: IChatAgentRequest, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<{ messages: GeminiContent[]; contextEntries: IContextBlockMetadata[] }> {
		const messages: GeminiContent[] = [];
		const contextPrompt = await this.buildContextPrompt(request, token);
		const contextEntries = contextPrompt?.entries ?? [];
		if (contextPrompt) {
			messages.push({ role: 'user', parts: [{ text: contextPrompt.prompt }] });
		}

		for (const entry of history) {
			if (!entry) {
				continue;
			}
			const userMessage = entry.request?.message;
			if (userMessage) {
				messages.push({ role: 'user', parts: [{ text: userMessage }] });
			}
			const assistantText = entry.response
				?.map(part => this.extractResponseContent(part))
				.filter((value): value is string => typeof value === 'string' && value.length > 0)
				.join('\n');
			if (assistantText) {
				messages.push({ role: 'model', parts: [{ text: assistantText }] });
			}
		}

		messages.push({ role: 'user', parts: [{ text: request.message }] });

		return { messages, contextEntries };
	}

	private async buildContextPrompt(request: IChatAgentRequest, token: CancellationToken): Promise<IContextPromptResult | undefined> {
		const variables = request.variables?.variables ?? [];
		this.logService.debug(`[gemini] preparing context: ${variables.length} entries`);
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
					const lang = entry.language?.toLowerCase() ?? '';
					blocks.push(this.formatCodeBlock(entry.name || 'pasted-snippet', snippet, lang));
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

		this.logService.debug(`[gemini] including ${blocks.length} context blocks`);
		const prompt = [
			'You are an expert coding assistant embedded in the IDE. The code blocks below are the exact context the user means -- even if they refer to them with vague terms like "this", "the file", or "the function".',
			'Ground every response in those blocks: explain behaviour, data structures, and error cases using only the provided code. Mention the relevant file or block when helpful, and if the answer cannot be derived from this context, say so explicitly before offering any speculation.',
			...blocks
		].join('\n\n');
		return { prompt, entries: metadata };
	}

	private async loadEntryContent(entry: IChatRequestVariableEntry, token: CancellationToken): Promise<{ block: string; metadata?: IContextBlockMetadata } | undefined> {
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
			const language = model.getLanguageId() ?? '';
			const label = this.getContextLabel(uri, range, entry);
			return {
				block: this.formatCodeBlock(label, text, language),
				metadata: {
					label,
					uri,
					range,
					language,
					content: text
				}
			};
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			this.logService.warn(`[gemini] Failed to load context for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
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
			if (rawValue && typeof rawValue === 'object') {
				const valueRecord = rawValue as Record<string, unknown>;
				const schemeValue = valueRecord['scheme'];
				if (typeof schemeValue === 'string') {
					return URI.revive(valueRecord as unknown as UriComponents);
				}
				const candidate = valueRecord['uri'];
				if (candidate) {
					return URI.isUri(candidate as unknown) ? candidate as URI : URI.revive(candidate as UriComponents);
				}
			}
		} catch (error) {
			this.logService.warn(`[gemini] Unable to resolve URI for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}

	private getLocation(entry: IChatRequestVariableEntry): Location | undefined {
		const value = (entry as { value?: unknown }).value;
		if (value && isLocation(value)) {
			const loc = value as Location;
			const revivedUri = URI.isUri(loc.uri) ? loc.uri : URI.revive(loc.uri as UriComponents);
			return {
				uri: revivedUri,
				range: Range.lift(loc.range)
			};
		}
		if (value && typeof value === 'object') {
			const recordValue = value as Record<string, unknown>;
			const candidateUri = recordValue['uri'];
			const candidateRange = recordValue['range'];
			if (candidateUri && candidateRange) {
				const revivedUri = URI.isUri(candidateUri as unknown) ? candidateUri as URI : URI.revive(candidateUri as UriComponents);
				return {
					uri: revivedUri,
					range: Range.lift(candidateRange as IRange)
				};
			}
		}
		return undefined;
	}

	private getContextLabel(uri: URI, range: Range | undefined, entry: IChatRequestVariableEntry): string {
		const fileName = basename(uri);
		const locationText = range ? `${range.startLineNumber}-${range.endLineNumber}` : undefined;
		const qualifier = entry.name && entry.name !== fileName ? entry.name : undefined;
		return [fileName, locationText, qualifier].filter(Boolean).join(' ');
	}

	private formatCodeBlock(label: string, content: string, language: string): string {
		const lang = language || '';
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
			const language = match[1]?.trim() ?? '';
			const content = match[2] ?? '';
			blocks.push({ language, content });
		}
		return blocks;
	}

	private findMatchingCodeBlock(entry: IContextBlockMetadata, blocks: IParsedCodeBlock[], used: Set<number>): { block: IParsedCodeBlock; index: number } | undefined {
		let bestScore = 0;
		let bestIndex = -1;

		const anchor = entry.content.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';

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
			if (!entry.language || !candidate.language || entry.language === candidate.language) {
				score += 2;
			}
			if (anchor && candidateContent.includes(anchor)) {
				score += 5;
			}
			const entryFirstLine = entry.content.split('\n')[0]?.trim() ?? '';
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

	private async tryAutoApplyEdits(responseText: string, contextEntries: IContextBlockMetadata[], progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<void> {
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

				const reference = await this.textModelService.createModelReference(entry.uri);
				try {
					const model = reference.object.textEditorModel;
					const editRange = entry.range ?? model.getFullModelRange();
					const edit: TextEdit = { range: editRange, text: newTextRaw };
					progress([{ kind: 'textEdit', uri: entry.uri, edits: [edit], done: false }]);
					progress([{ kind: 'textEdit', uri: entry.uri, edits: [], done: true }]);
				} finally {
					reference.dispose();
				}
			} catch (error) {
				this.logService.warn(`[gemini] Failed to auto-apply edit for ${entry.label}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

class DeepSeekAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.deepSeekAgent';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService
	) {
		super();

		// Read API key from env (which gets userEnv from preload script)
		const apiKey = env['GEMINI_API_KEY'];
		const model = 'gemini-2.5-flash';

		if (!apiKey) {
			logService.warn('[gemini] No API key configured. Set GEMINI_API_KEY environment variable.');
			// Don't register if no API key to avoid "No default agent" errors
			return;
		}

		logService.info(`[gemini] registering online agent using Gemini 2.5 Flash`);

		const agentId = 'gemini.local';
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'gemini',
			fullName: localize('gemini.agent.name', "Gemini 2.5 Flash"),
			description: localize('gemini.agent.description', "Use Gemini 2.5 Flash online model."),
			isCore: true,
			isDefault: true,
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'explain', description: localize('gemini.command.explain', "Explain the current selection."), when: undefined },
				{ name: 'review', description: localize('gemini.command.review', "Review the shown changes."), when: undefined }
			],
			metadata: {
				followupPlaceholder: localize('gemini.followup.placeholder', "Ask Gemini..."),
				additionalWelcomeMessage: localize('gemini.welcome', "Gemini 2.5 Flash is ready.")
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier('core.gemini'),
			extensionVersion: '0.0.0',
			extensionPublisherId: 'core',
			extensionDisplayName: 'Core'
		});
		this._register(registration);

		const implementation = new DeepSeekAgentImplementation(this.requestService, apiKey, logService, textModelService, languageModelToolsService, model);
		this._register(this.chatAgentService.registerAgentImplementation(agentId, implementation));

		const enabledKey = contextKeyService.createKey(ChatContextKeys.enabled.key, true);
		const panelRegisteredKey = contextKeyService.createKey(ChatContextKeys.panelParticipantRegistered.key, true);
		const extensionRegisteredKey = contextKeyService.createKey(ChatContextKeys.extensionParticipantRegistered.key, true);
		this._register(toDisposable(() => {
			enabledKey.reset();
			panelRegisteredKey.reset();
			extensionRegisteredKey.reset();
		}));

		const vendor = 'google';
		const modelIdentifier = 'google/gemini-2.5-flash';
		const provider: ILanguageModelChatProvider = {
			onDidChange: Event.None,
			async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
				return [{
					identifier: modelIdentifier,
					metadata: {
						extension: new ExtensionIdentifier('core.gemini'),
						name: 'Gemini 2.5 Flash',
						id: modelIdentifier,
						vendor,
						version: '1.0.0',
						family: 'gemini',
						detail: localize('gemini.model.detail', "Google Gemini 2.5 Flash online model."),
						maxInputTokens: 128000,
						maxOutputTokens: 8192,
						modelPickerCategory: { label: 'Google Models', order: 1 },
						isDefault: true,
						isUserSelectable: true,
						capabilities: { agentMode: true, toolCalling: true }
					}
				}];
			},
			async sendChatRequest(_modelId, messages, _from, _options, token) {
				const response = await sendGeminiRequest(requestService, apiKey, model, toGeminiContents(messages), token);
				const text = response.parts
					.filter((part): part is { text: string } => hasKey(part, { text: true }) && typeof part.text === 'string')
					.map(part => part.text)
					.join('\n')
					.trim();
				const functionCallPart = response.parts.find((part): part is { functionCall: { name: string; args: Record<string, unknown> } } => hasKey(part, { functionCall: true }) && !!part.functionCall);
				const responseText = text.length ? text : functionCallPart ? localize('gemini.provider.functionCall', "Gemini wants to run tool {0}, but tools are only available in agent mode. Retry there or disable tool usage.", functionCallPart.functionCall.name) : '';
				const stream = (async function* (): AsyncIterable<IChatResponsePart> {
					yield { type: 'text', value: responseText };
				})();
				return {
					stream,
					result: Promise.resolve<IChatAgentResult>({
						details: 'gemini-response',
						metadata: { model }
					})
				};
			},
			async provideTokenCount(_modelId, message, _token) {
				if (typeof message === 'string') {
					return message.length;
				}
				return reduceMessageParts(message).length;
			}
		};
		this._register(languageModelsService.registerLanguageModelProvider(vendor, provider));
	}
}

registerWorkbenchContribution2(DeepSeekAgentContribution.ID, DeepSeekAgentContribution, WorkbenchPhase.AfterRestored);


