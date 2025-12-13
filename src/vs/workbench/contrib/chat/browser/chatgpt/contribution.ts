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
} from '../../common/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../../common/chatContextKeys.js';
import {
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelsService,
} from '../../common/languageModels.js';
import {
	ITextModelService,
} from '../../../../../editor/common/services/resolverService.js';
import {
	ILanguageModelToolsService,
} from '../../common/languageModelToolsService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { CHATGPT_MODELS } from './models.js';
import { ChatGPTAgentImplementation } from './agent.js';
import { reduceMessageParts } from './utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAgentPlanner } from '../../common/agentPlanner.js';
import { IDependencyGraphService } from '../../common/dependencyGraphService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IMetricsService } from '../../../../services/metrics/common/metricsService.js';
import '../../common/agentIntelligence.contribution.js';

class ChatGPTAgentContribution
	extends Disposable
	implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chatGPTAgent';

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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		logService.info(`[chatgpt-server] ===== ChatGPTAgentContribution constructor START =====`);

		const serverAddress = env['SERVER_ADDRESS'];
		logService.info(
			`[chatgpt-server] Environment check: SERVER_ADDRESS=${serverAddress ? 'present' : 'missing'}, env keys available: ${Object.keys(env)
				.filter((k) => k.includes('SERVER') || k.includes('ADDRESS'))
				.join(', ') || 'none'
			}`,
		);

		if (!serverAddress) {
			logService.warn('[chatgpt-server] No server address configured. Set SERVER_ADDRESS environment variable.');
			logService.info(`[chatgpt-server] ===== ChatGPTAgentContribution constructor END (early return - no server address) =====`);
			return;
		}

		let normalizedServerAddress = serverAddress.trim();
		if (!normalizedServerAddress.startsWith('http://') && !normalizedServerAddress.startsWith('https://')) {
			logService.warn(
				`[chatgpt-server] SERVER_ADDRESS missing protocol, assuming https://. Original: ${normalizedServerAddress}`,
			);
			normalizedServerAddress = `https://${normalizedServerAddress}`;
		}
		normalizedServerAddress = normalizedServerAddress.replace(/\/+$/, '');

		logService.info(`[chatgpt-server] Server address found: ${normalizedServerAddress}`);
		logService.info(`[chatgpt-server] registering online agent using ChatGPT models (${CHATGPT_MODELS.length} models defined)`);

		const agentId = 'chatgpt.local';
		const registration = this.chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'chatgpt',
			fullName: localize('chatgpt.agent.name', 'ChatGPT'),
			description: localize('chatgpt.agent.description', 'Use ChatGPT online models.'),
			isCore: true,
			isDefault: false,
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{
					name: 'explain',
					description: localize('chatgpt.command.explain', 'Explain the current selection.'),
					when: undefined,
				},
				{
					name: 'review',
					description: localize('chatgpt.command.review', 'Review the shown changes.'),
					when: undefined,
				},
			],
			metadata: {
				followupPlaceholder: localize('chatgpt.followup.placeholder', 'Ask ChatGPT...'),
				additionalWelcomeMessage: localize('chatgpt.welcome', 'ChatGPT is ready.'),
			},
			disambiguation: [],
			extensionId: new ExtensionIdentifier('core.chatgpt'),
			extensionVersion: '0.0.0',
			extensionPublisherId: 'core',
			extensionDisplayName: 'Core',
		});
		this._register(registration);

		// Get optional services for planning
		let agentPlanner: IAgentPlanner | undefined;
		let dependencyGraphService: IDependencyGraphService | undefined;
		let workspaceService: IWorkspaceContextService | undefined;
		let fileService: IFileService | undefined;

		try {
			agentPlanner = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentPlanner));
		} catch {
			// Service not available
		}

		try {
			dependencyGraphService = this.instantiationService.invokeFunction(accessor => accessor.get(IDependencyGraphService));
		} catch {
			// Service not available
		}

		try {
			workspaceService = this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService));
		} catch {
			// Service not available
		}

		try {
			fileService = this.instantiationService.invokeFunction(accessor => accessor.get(IFileService));
		} catch {
			// Service not available
		}

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

		const implementation = new ChatGPTAgentImplementation(
			this.requestService,
			normalizedServerAddress,
			this.secretStorageService,
			logService,
			textModelService,
			languageModelToolsService,
			languageModelsService,
			this.configurationService,
			this.chatAgentService,
			agentPlanner,
			dependencyGraphService,
			workspaceService,
			fileService,
			languageFeaturesService,
			metricsService,
		);
		this._register(this.chatAgentService.registerAgentImplementation(agentId, implementation));

		const enabledKey = contextKeyService.createKey(ChatContextKeys.enabled.key, true);
		const panelRegisteredKey = contextKeyService.createKey(ChatContextKeys.panelParticipantRegistered.key, true);
		const extensionRegisteredKey = contextKeyService.createKey(ChatContextKeys.extensionParticipantRegistered.key, true);
		this._register(
			toDisposable(() => {
				enabledKey.reset();
				panelRegisteredKey.reset();
				extensionRegisteredKey.reset();
			}),
		);

		const vendor = 'openai';
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
							extension: new ExtensionIdentifier('core.chatgpt'),
							name: modelConfig.name,
							id: modelConfig.identifier,
							vendor,
							version: '1.0.0',
							family: 'gpt',
							detail: modelConfig.description,
							maxInputTokens: modelConfig.maxInputTokens,
							maxOutputTokens: modelConfig.maxOutputTokens,
							modelPickerCategory: { label: 'OpenAI Models', order: 1 },
							isDefault: modelConfig.isDefault,
							isUserSelectable: true,
							capabilities: { agentMode: true, toolCalling: true },
						},
					}));
					logService.info(
						`[chatgpt] provideLanguageModelChatInfo returning ${models.length} models: ${models.map((m) => m.identifier).join(', ')}`,
					);
					return models;
				} catch (error) {
					logService.error(`[chatgpt] Error in provideLanguageModelChatInfo:`, error);
					throw error;
				}
			},
			async sendChatRequest(modelId, messages, _from, _options, token) {
				throw new Error('OpenAI models must run in agent mode. Use ChatGPT agent.');
			},
			async provideTokenCount(_modelId, message, _token) {
				if (typeof message === 'string') {
					return message.length;
				}
				return reduceMessageParts(message).length;
			},
		};
		logService.info(`[chatgpt] Registering language model provider for vendor: ${vendor}`);
		const registrationDisposable = languageModelsService.registerLanguageModelProvider(vendor, provider);
		this._register(registrationDisposable);
		logService.info(`[chatgpt] Language model provider registered successfully for vendor: ${vendor}`);
		logService.info(`[chatgpt] ===== ChatGPTAgentContribution constructor END (success) =====`);
	}
}

registerWorkbenchContribution2(
	ChatGPTAgentContribution.ID,
	ChatGPTAgentContribution,
	WorkbenchPhase.AfterRestored,
);

