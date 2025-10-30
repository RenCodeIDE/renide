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
import { asJson, asText, IRequestService } from '../../../../platform/request/common/request.js';
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
import { isLocation, Location } from '../../../../editor/common/languages.js';
import { Range, IRange } from '../../../../editor/common/core/range.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CancellationError } from '../../../../base/common/errors.js';
type LocalChatMessage = { role: string; content: string };

async function sendLocalModelRequest(requestService: IRequestService, endpoint: string, model: string, messages: LocalChatMessage[], token: CancellationToken): Promise<string> {
	const body = JSON.stringify({
		model,
		messages,
		stream: false,
		temperature: 0.2
	});

	const context = await requestService.request({
		type: 'POST',
		url: endpoint,
		data: body,
		disableCache: true,
		headers: {
			'Content-Type': 'application/json'
		}
	}, token);

	const status = context.res.statusCode ?? 0;
	if (status < 200 || status >= 300) {
		const responseText = await asText(context);
		throw new Error(responseText || `HTTP ${status}`);
	}

	const json = await asJson<{ choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }>(context);
	const text = json?.choices?.[0]?.message?.content;
	if (!text) {
		throw new Error(json?.error?.message || localize('deepseek.invalidResponse', "Model returned an empty response."));
	}

	return text.trim();
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
			case ChatMessageRole.System: role = 'system'; break;
			case ChatMessageRole.Assistant: role = 'assistant'; break;
			case ChatMessageRole.User: role = 'user'; break;
		}
		return { role, content: reduceMessageParts(entry) };
	}).filter(message => message.content.length > 0);
}

class DeepSeekAgentImplementation implements IChatAgentImplementation {

	constructor(
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
		private readonly textModelService: ITextModelService,
		private readonly endpoint: string,
		private readonly model: string
	) { }

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {

		if (token.isCancellationRequested) {
			return { details: 'cancelled' };
		}

		const messages = await this.buildMessages(request, history, token);

		try {
			const responseText = await this.performRequest(messages, token);

			const markdown = new MarkdownString(responseText);
			markdown.supportThemeIcons = true;
			progress([{ kind: 'markdownContent', content: markdown }]);

			return {
				details: 'deepseek-response',
				metadata: {
					model: this.model
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[deepseek] ${message}`);

			const markdown = new MarkdownString(localize('deepseek.error', "DeepSeek request failed: {0}", message));
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
		const body = JSON.stringify({
			model: this.model,
			messages,
			stream: false,
			temperature: 0.2
		});

		const context = await this.requestService.request({
			type: 'POST',
			url: this.endpoint,
			data: body,
			disableCache: true,
			headers: {
				'Content-Type': 'application/json'
			}
		}, token);

		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			const responseText = await asText(context);
			throw new Error(responseText || `HTTP ${status}`);
		}

		const json = await asJson<{ choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }>(context);
		const text = json?.choices?.[0]?.message?.content;
		if (!text) {
			throw new Error(json?.error?.message || localize('deepseek.invalidResponse', "Model returned an empty response."));
		}

		return text.trim();
	}

	private async buildMessages(request: IChatAgentRequest, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<Array<{ role: string; content: string }>> {
		const messages: Array<{ role: string; content: string }> = [];

		const contextPrompt = await this.buildContextPrompt(request, token);
		if (contextPrompt) {
			messages.push({ role: 'system', content: contextPrompt });
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

		return messages;
	}

	private async buildContextPrompt(request: IChatAgentRequest, token: CancellationToken): Promise<string | undefined> {
		const variables = request.variables?.variables ?? [];
		this.logService.debug(`[qwen] preparing context: ${variables.length} entries`);
		if (!variables.length) {
			return undefined;
		}

		const blocks: string[] = [];
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
					blocks.push(contextBlock);
				}
			}
		}

		if (!blocks.length) {
			return undefined;
		}

		this.logService.debug(`[qwen] including ${blocks.length} context blocks`);
		return [
			'You are an expert coding assistant embedded in the IDE. The code blocks below are the exact context the user means -- even if they refer to them with vague terms like "this", "the file", or "the function".',
			'Ground every response in those blocks: explain behaviour, data structures, and error cases using only the provided code. Mention the relevant file or block when helpful, and if the answer cannot be derived from this context, say so explicitly before offering any speculation.',
			...blocks
		].join('\n\n');
	}

	private async loadEntryContent(entry: IChatRequestVariableEntry, token: CancellationToken): Promise<string | undefined> {
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
			return this.formatCodeBlock(label, text, language);
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			this.logService.warn(`[qwen] Failed to load context for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
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
			this.logService.warn(`[qwen] Unable to resolve URI for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
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
}

class DeepSeekAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.deepSeekAgent';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITextModelService textModelService: ITextModelService
	) {
		super();

		const globals = globalThis as { DEEPSEEK_ENDPOINT?: string; DEEPSEEK_MODEL?: string } | undefined;
		const endpoint = globals?.DEEPSEEK_ENDPOINT ?? 'http://localhost:11434/v1/chat/completions';
		const model = globals?.DEEPSEEK_MODEL ?? 'qwen2.5-coder:7b';
		logService.info(`[qwen] registering local agent using ${endpoint} (${model})`);

		const agentId = 'qwen.local';
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'qwen',
			fullName: localize('deepseek.agent.name', "Qwen 2.5"),
			description: localize('deepseek.agent.description', "Use a local Qwen 2.5 Coder model served through Ollama."),
			isCore: true,
			isDefault: true,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'explain', description: localize('deepseek.command.explain', "Explain the current selection."), when: undefined },
				{ name: 'review', description: localize('deepseek.command.review', "Review the shown changes."), when: undefined }
			],
			metadata: {
				followupPlaceholder: localize('deepseek.followup.placeholder', "Ask Qwen 2.5..."),
				additionalWelcomeMessage: localize('deepseek.welcome', "Qwen 2.5 Coder is ready. Ensure Ollama is running and the '{0}' model is installed.", model)
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier('core.qwen'),
			extensionVersion: '0.0.0',
			extensionPublisherId: 'core',
			extensionDisplayName: 'Core'
		});
		this._register(registration);

		const implementation = new DeepSeekAgentImplementation(requestService, logService, textModelService, endpoint, model);
		this._register(this.chatAgentService.registerAgentImplementation(agentId, implementation));

		const enabledKey = contextKeyService.createKey(ChatContextKeys.enabled.key, true);
		const panelRegisteredKey = contextKeyService.createKey(ChatContextKeys.panelParticipantRegistered.key, true);
		const extensionRegisteredKey = contextKeyService.createKey(ChatContextKeys.extensionParticipantRegistered.key, true);
		this._register(toDisposable(() => {
			enabledKey.reset();
			panelRegisteredKey.reset();
			extensionRegisteredKey.reset();
		}));
		const vendor = 'local';
		const modelIdentifier = `${vendor}/${model}`;
		const provider: ILanguageModelChatProvider = {
			onDidChange: Event.None,
			async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
				return [{
					identifier: modelIdentifier,
					metadata: {
						extension: new ExtensionIdentifier('core.qwen'),
						name: 'Qwen 2.5 Coder',
						id: modelIdentifier,
						vendor,
						version: '1.0.0',
						family: 'qwen',
						detail: localize('deepseek.model.detail', "Local Qwen 2.5 Coder served via Ollama."),
						maxInputTokens: 128000,
						maxOutputTokens: 8192,
						modelPickerCategory: { label: 'Local Models', order: 1 },
						isDefault: true,
						isUserSelectable: false,
						capabilities: { agentMode: true, toolCalling: false }
					}
				}];
			},
			async sendChatRequest(_modelId, messages, _from, _options, token) {
				const responseText = await sendLocalModelRequest(requestService, endpoint, model, toLocalMessages(messages), token);
				const stream = (async function* (): AsyncIterable<IChatResponsePart> {
					yield { type: 'text', value: responseText };
				})();
				return {
					stream,
					result: Promise.resolve<IChatAgentResult>({
						details: 'qwen-response',
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


