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
import { CLAUDE_MODELS } from './models.js';
import { ClaudeAgentImplementation } from './agent.js';
import { reduceMessageParts } from './conversion.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { sendChatGPTRequest } from '../chatgpt/request.js';
// @ts-ignore - Module resolution error is false positive, files exist
import { validateIDEFormatStatic } from '../chatgpt/validation.js';
import { IMetricsService } from '../../../../services/metrics/common/metricsService.js';

class ClaudeAgentContribution
	extends Disposable
	implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAgent';

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
			`[claude-server] Environment check: SERVER_ADDRESS=${serverAddress ? 'present' : 'missing'}`,
		);

		if (!serverAddress) {
			logService.warn('[claude-server] No server address configured. Set SERVER_ADDRESS environment variable.');
			// Don't register if no server address to avoid "No default agent" errors
			return;
		}

		logService.info(`[claude-server] registering online agent using Claude models`);

		const agentId = 'claude.local';
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'claude',
			fullName: localize('claude.agent.name', "Claude"),
			description: localize('claude.agent.description', "Use Claude online models."),
			isCore: true,
			isDefault: false,
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'explain', description: localize('claude.command.explain', "Explain the current selection."), when: undefined },
				{ name: 'review', description: localize('claude.command.review', "Review the shown changes."), when: undefined }
			],
			metadata: {
				followupPlaceholder: localize('claude.followup.placeholder', "Ask Claude..."),
				additionalWelcomeMessage: localize('claude.welcome', "Claude is ready.")
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier('core.claude'),
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

		// Get metrics service for project tracking
		let metricsService: IMetricsService | undefined;
		try {
			metricsService = this.instantiationService.invokeFunction(accessor => accessor.get(IMetricsService));
		} catch {
			// Service not available
		}

		const implementation = new ClaudeAgentImplementation(
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

		const vendor = 'claude';
		const requestServiceInstance = this.requestService; // Capture for use in provider
		const secretStorageInstance = this.secretStorageService; // Capture for use in provider
		const serverAddressInstance = serverAddress; // Capture for use in provider
		const logServiceInstance = logService; // Capture for use in provider
		const provider: ILanguageModelChatProvider = {
			onDidChange: Event.None,
			async provideLanguageModelChatInfo(_options, _token): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
				return CLAUDE_MODELS.map(modelConfig => ({
					identifier: modelConfig.identifier,
					metadata: {
						extension: new ExtensionIdentifier('core.claude'),
						name: modelConfig.name,
						id: modelConfig.identifier,
						vendor,
						version: '1.0.0',
						family: 'claude',
						detail: modelConfig.description,
						maxInputTokens: modelConfig.maxInputTokens,
						maxOutputTokens: modelConfig.maxOutputTokens,
						modelPickerCategory: { label: 'Anthropic Models', order: 1 },
						isDefault: modelConfig.isDefault,
						isUserSelectable: true,
						capabilities: { agentMode: true, toolCalling: true }
					}
				}));
			},
			async sendChatRequest(modelId, messages, _from, _options, token) {
				const selectedModelConfig = CLAUDE_MODELS.find(m => m.identifier === modelId);
				const modelToUse = selectedModelConfig?.id || CLAUDE_MODELS.find(m => m.isDefault)?.id || 'claude-3-5-sonnet-20241022';

				// Get access token for server authentication
				let accessToken: string | undefined;
				try {
					accessToken = await secretStorageInstance.get('ren.auth.accessToken') ?? undefined;
					if (!accessToken) {
						throw new Error(localize('claude.noAuthToken', 'Authentication token is missing. Please sign in to use Claude.'));
					}
				} catch (error) {
					logServiceInstance.error(`[claude-provider] Error retrieving access token: ${error instanceof Error ? error.message : String(error)}`);
					throw new Error(localize('claude.noAuthToken', 'Authentication token is missing. Please sign in to use Claude.'));
				}

				// Validate messages are in IDE format
				validateIDEFormatStatic(messages, logServiceInstance);
				logServiceInstance.debug(`[claude-provider] Message format validation passed: ${messages.length} messages in IDE format`);

				// Route through server instead of calling Claude API directly
				const endpoint: '/api/agent/tools' = '/api/agent/tools';
				logServiceInstance.info(`[claude-provider] Using endpoint: ${endpoint} for model: ${modelToUse}`);

				const response = await sendChatGPTRequest(
					requestServiceInstance,
					accessToken,
					serverAddressInstance,
					endpoint,
					messages,
					token,
					{
						modelName: modelToUse,
						// No tools for language model provider (non-agent mode)
						tools: undefined,
					},
					logServiceInstance,
					'claude',
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
							} else if (part.toolCall) {
								functionCallName = part.toolCall.name;
								// Note: Tool calls are not supported in language model provider mode
								// This should not happen if server is configured correctly
								logServiceInstance.warn(`[claude-provider] Received tool call ${part.toolCall.name} in non-agent mode`);
							}
						}
						if (chatParts.length === 1) {
							yield chatParts[0];
						} else if (chatParts.length > 1) {
							yield chatParts;
						}
					}
					if (!sawText && functionCallName && !token.isCancellationRequested) {
						yield { type: 'text', value: localize('claude.provider.functionCall', "Claude wants to run tool {0}, but tools are only available in agent mode. Retry there or disable tool usage.", functionCallName) };
					}
				})();

				return {
					stream,
					result: response.result.then((result): IChatAgentResult => ({
						details: 'claude-response',
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

registerWorkbenchContribution2(ClaudeAgentContribution.ID, ClaudeAgentContribution, WorkbenchPhase.AfterRestored);

