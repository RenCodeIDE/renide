/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { env } from '../../../../../base/common/process.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import {
	registerWorkbenchContribution2,
	IWorkbenchContribution,
	WorkbenchPhase,
} from '../../../../common/contributions.js';
import {
	IChatAgentService,
	IChatAgentResult,
} from '../../common/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../../common/chatContextKeys.js';
import {
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelsService,
	IChatResponsePart,
} from '../../common/languageModels.js';
import {
	ITextModelService,
} from '../../../../../editor/common/services/resolverService.js';
import {
	ILanguageModelToolsService,
} from '../../common/languageModelToolsService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { DEEPSEEK_MODELS } from './models.js';
import { DeepSeekAgentImplementation } from './agent.js';
import { reduceMessageParts } from './conversion.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { sendChatGPTRequest } from '../chatgpt/request.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { validateIDEFormatStatic } from '../chatgpt/validation.js';
import { IMetricsService } from '../../../../services/metrics/common/metricsService.js';

class DeepSeekAgentContribution
	extends Disposable
	implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.deepseekAgent';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		const serverAddress = env['SERVER_ADDRESS'];
		logService.info(
			`[deepseek-server] Environment check: SERVER_ADDRESS=${serverAddress ? 'present' : 'missing'}`,
		);

		if (!serverAddress) {
			logService.warn('[deepseek-server] No server address configured. Set SERVER_ADDRESS environment variable.');
			return;
		}

		logService.info(`[deepseek-server] registering online agent using DeepSeek models`);

		const agentId = 'deepseek.local';
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'deepseek',
			fullName: localize('deepseek.agent.name', "DeepSeek"),
			description: localize('deepseek.agent.description', "Use DeepSeek online models."),
			isCore: true,
			isDefault: false,
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'explain', description: localize('deepseek.command.explain', "Explain the current selection."), when: undefined },
				{ name: 'review', description: localize('deepseek.command.review', "Review the shown changes."), when: undefined }
			],
			metadata: {
				followupPlaceholder: localize('deepseek.followup.placeholder', "Ask DeepSeek..."),
				additionalWelcomeMessage: localize('deepseek.welcome', "DeepSeek is ready.")
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier('core.deepseek'),
			extensionVersion: '0.0.0',
			extensionPublisherId: 'core',
			extensionDisplayName: 'Core'
		});
		this._register(registration);

		let languageFeaturesService: ILanguageFeaturesService | undefined;
		try {
			languageFeaturesService = this.instantiationService.invokeFunction(accessor => accessor.get(ILanguageFeaturesService));
		} catch {
			// Service not available
		}

		let metricsService: IMetricsService | undefined;
		try {
			metricsService = this.instantiationService.invokeFunction(accessor => accessor.get(IMetricsService));
		} catch {
			// Service not available
		}

		const implementation = new DeepSeekAgentImplementation(
			this.requestService,
			serverAddress,
			this.secretStorageService,
			logService,
			textModelService,
			languageModelToolsService,
			languageModelsService,
			this.chatAgentService,
			this.configurationService,
			languageFeaturesService,
			metricsService,
		);
		this._register(this.chatAgentService.registerAgentImplementation(agentId, implementation));

		const enabledKey = contextKeyService.createKey(ChatContextKeys.enabled.key, true);
		const panelRegisteredKey = contextKeyService.createKey(ChatContextKeys.panelParticipantRegistered.key, true);
		const extensionRegisteredKey = contextKeyService.createKey(ChatContextKeys.extensionParticipantRegistered.key, true);
		this._register(toDisposable(() => {
			enabledKey.reset();
			panelRegisteredKey.reset();
			extensionRegisteredKey.reset();
		}));

		const vendor = 'deepseek';
		const requestServiceInstance = this.requestService;
		const secretStorageInstance = this.secretStorageService;
		const serverAddressInstance = serverAddress;
		const logServiceInstance = logService;
		const provider: ILanguageModelChatProvider = {
			onDidChange: Event.None,
			async provideLanguageModelChatInfo(_options, _token): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
				return DEEPSEEK_MODELS.map(modelConfig => ({
					identifier: modelConfig.identifier,
					metadata: {
						extension: new ExtensionIdentifier('core.deepseek'),
						name: modelConfig.name,
						id: modelConfig.identifier,
						vendor,
						version: '1.0.0',
						family: 'deepseek',
						detail: modelConfig.description,
						maxInputTokens: modelConfig.maxInputTokens,
						maxOutputTokens: modelConfig.maxOutputTokens,
						modelPickerCategory: { label: 'DeepSeek Models', order: 4 },
						isDefault: modelConfig.isDefault,
						isUserSelectable: true,
						capabilities: { agentMode: true, toolCalling: true }
					}
				}));
			},
			async sendChatRequest(modelId, messages, _from, options, token) {
				const selectedModelConfig = DEEPSEEK_MODELS.find(m => m.identifier === modelId);
				const modelToUse = selectedModelConfig?.id || DEEPSEEK_MODELS.find(m => m.isDefault)?.id || 'deepseek-chat';

				let accessToken: string | undefined;
				try {
					accessToken = await secretStorageInstance.get('ren.auth.accessToken') ?? undefined;
					if (!accessToken) {
						throw new Error(localize('deepseek.noAuthToken', 'Authentication token is missing. Please sign in to use DeepSeek.'));
					}
				} catch (error) {
					logServiceInstance.error(`[deepseek-provider] Error retrieving access token: ${error instanceof Error ? error.message : String(error)}`);
					throw new Error(localize('deepseek.noAuthToken', 'Authentication token is missing. Please sign in to use DeepSeek.'));
				}

				validateIDEFormatStatic(messages, logServiceInstance);
				logServiceInstance.debug(`[deepseek-provider] Message format validation passed: ${messages.length} messages in IDE format`);

				const endpoint: '/api/agent/tools' = '/api/agent/tools';
				logServiceInstance.info(`[deepseek-provider] Using endpoint: ${endpoint} for model: ${modelToUse}`);

				const response = await sendChatGPTRequest(
					requestServiceInstance,
					accessToken,
					serverAddressInstance,
					endpoint,
					messages,
					token,
					{
						modelName: modelToUse,
						tools: options.tools,
						toolResults: options.toolResults,
					},
					logServiceInstance,
					'deepseek',
				);

				let sawText = false;
				let functionCallName: string | undefined;

				const stream = (async function* (): AsyncIterable<IChatResponsePart | IChatResponsePart[]> {
					for await (const chunk of response.stream) {
						if (token.isCancellationRequested) {
							break;
						}
						const chatParts: IChatResponsePart[] = [];
						for (const part of chunk) {
							if (part.text !== undefined) {
								if (part.text.length) {
									sawText = true;
								}
								chatParts.push({ type: 'text', value: part.text });
							} else if (part.thinking !== undefined) {
								chatParts.push({ type: 'thinking', value: part.thinking });
							} else if (part.toolCall) {
								functionCallName = part.toolCall.name;
								logServiceInstance.warn(`[deepseek-provider] Received tool call ${part.toolCall.name} in non-agent mode`);
							}
						}
						if (chatParts.length === 1) {
							yield chatParts[0];
						} else if (chatParts.length > 1) {
							yield chatParts;
						}
					}
					if (!sawText && functionCallName && !token.isCancellationRequested) {
						yield { type: 'text', value: localize('deepseek.provider.functionCall', "DeepSeek wants to run tool {0}, but tools are only available in agent mode. Retry there or disable tool usage.", functionCallName) };
					}
				})();

				return {
					stream,
					result: response.result.then((result): IChatAgentResult => ({
						details: 'deepseek-response',
						metadata: { model: modelToUse }
					}))
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

