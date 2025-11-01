/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { registerWorkbenchContribution2, IWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatAgentService, IChatAgentImplementation, IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult } from '../common/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../common/constants.js';
import { IChatProgressHistoryResponseContent } from '../common/chatModel.js';
import { ChatErrorLevel, IChatProgress, IChatTaskDto } from '../common/chatService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../common/chatContextKeys.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelsService, IChatMessage, IChatResponsePart, ChatMessageRole } from '../common/languageModels.js';
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
type LocalChatMessage = { role: string; content: string };

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

async function sendGeminiRequest(
	requestService: IRequestService,
	apiKey: string,
	model: string,
	messages: LocalChatMessage[],
	token: CancellationToken
): Promise<string> {
	// Convert messages to Gemini API format
	const contents = messages.map(msg => ({
		role: msg.role === 'model' ? 'model' : 'user',
		parts: [{ text: msg.content }]
	}));

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
	const body = JSON.stringify({ contents });

	const context = await requestService.request({
		type: 'POST',
		url,
		data: body,
		headers: {
			'Content-Type': 'application/json'
		}
	}, token);

	if (!isSuccess(context)) {
		// Read error response text
		const buffer = await streamToBuffer(context.stream);
		const errorText = buffer.toString();
		throw new Error(`Gemini API error: ${context.res.statusCode} - ${errorText || 'Unknown error'}`);
	}

	const response = await asJson<{
		candidates?: Array<{
			content?: {
				parts?: Array<{
					text?: string;
				}>;
			};
		}>;
	}>(context);

	if (!response?.candidates?.[0]?.content?.parts?.[0]?.text) {
		throw new Error(localize('gemini.invalidResponse', "Model returned an empty response."));
	}

	return response.candidates[0].content.parts[0].text.trim();
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

function toLocalMessages(messages: IChatMessage[]): LocalChatMessage[] {
	return messages.map(entry => {
		let role: string = 'user';
		switch (entry.role) {
			case ChatMessageRole.System: role = 'user'; break;
			case ChatMessageRole.Assistant: role = 'model'; break;
			case ChatMessageRole.User: role = 'user'; break;
		}
		return { role, content: reduceMessageParts(entry) };
	}).filter(message => message.content.length > 0);
}

class DeepSeekAgentImplementation implements IChatAgentImplementation {

	constructor(
		private readonly requestService: IRequestService,
		private readonly apiKey: string,
		private readonly logService: ILogService,
		private readonly textModelService: ITextModelService,
		private readonly model: string
	) { }

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {

		if (token.isCancellationRequested) {
			return { details: 'cancelled' };
		}

		const { messages, contextEntries } = await this.buildMessages(request, history, token);

		try {
			const responseText = await this.performRequest(messages, token);

			await this.tryAutoApplyEdits(responseText, contextEntries, progress, token);

			const markdown = new MarkdownString(responseText);
			markdown.supportThemeIcons = true;
			progress([{ kind: 'markdownContent', content: markdown }]);

			return {
				details: 'gemini-response',
				metadata: {
					model: this.model
				}
			};
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
		}
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

	private async performRequest(messages: Array<{ role: string; content: string }>, token: CancellationToken): Promise<string> {
		return sendGeminiRequest(this.requestService, this.apiKey, this.model, messages, token);
	}

	private async buildMessages(request: IChatAgentRequest, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<{ messages: Array<{ role: string; content: string }>; contextEntries: IContextBlockMetadata[] }> {
		const messages: Array<{ role: string; content: string }> = [];
		const contextPrompt = await this.buildContextPrompt(request, token);
		const contextEntries = contextPrompt?.entries ?? [];
		if (contextPrompt) {
			messages.push({ role: 'system', content: contextPrompt.prompt });
		}

		for (const entry of history) {
			if (!entry) {
				continue;
			}
			const userMessage = entry.request?.message;
			if (userMessage) {
				messages.push({ role: 'user', content: userMessage });
			}
			const assistantText = entry.response
				?.map(part => this.extractResponseContent(part))
				.filter((value): value is string => typeof value === 'string' && value.length > 0)
				.join('\n');
			if (assistantText) {
				messages.push({ role: 'assistant', content: assistantText });
			}
		}

		messages.push({ role: 'user', content: request.message });

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
		@ITextModelService textModelService: ITextModelService
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

		const implementation = new DeepSeekAgentImplementation(this.requestService, apiKey, logService, textModelService, model);
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
				const responseText = await sendGeminiRequest(requestService, apiKey, model, toLocalMessages(messages), token);
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


