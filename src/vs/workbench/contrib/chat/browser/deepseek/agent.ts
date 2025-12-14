/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from "../../../../../platform/log/common/log.js";
import {
	IChatAgentService,
} from "../../common/chatAgents.js";
import { ChatModeKind } from "../../common/constants.js";
import {
	ILanguageModelsService,
} from "../../common/languageModels.js";
import {
	ILanguageModelToolsService,
} from "../../common/languageModelToolsService.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { ITextModelService } from "../../../../../editor/common/services/resolverService.js";
import { DEEPSEEK_MODELS } from "./models.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { ILanguageFeaturesService } from "../../../../../editor/common/services/languageFeatures.js";
import { IMetricsService } from "../../../../services/metrics/common/metricsService.js";
import { BaseAgentImplementation } from "../baseAgentImplementation.js";
import { IToolContextResolverService } from "../toolContextResolverService.js";

export class DeepSeekAgentImplementation extends BaseAgentImplementation {
	constructor(
		requestService: IRequestService,
		serverAddress: string,
		secretStorageService: ISecretStorageService,
		logService: ILogService,
		textModelService: ITextModelService,
		languageModelToolsService: ILanguageModelToolsService,
		languageModelsService: ILanguageModelsService,
		chatAgentService: IChatAgentService,
		configurationService: IConfigurationService,
		languageFeaturesService?: ILanguageFeaturesService,
		metricsService?: IMetricsService,
		toolContextResolverService?: IToolContextResolverService
	) {
		super(
			{
				vendorId: "deepseek",
				logPrefix: "[deepseek-server]",
				defaultModelId: "deepseek-chat"
			},
			requestService,
			serverAddress,
			secretStorageService,
			logService,
			textModelService,
			languageModelToolsService,
			languageModelsService,
			chatAgentService,
			configurationService,
			languageFeaturesService,
			metricsService,
			toolContextResolverService
		);
	}

	protected getModels(): Array<{ id: string; identifier: string; isDefault?: boolean; maxOutputTokens?: number }> {
		return DEEPSEEK_MODELS;
	}

	protected override getEndpoint(mode: ChatModeKind): "/api/agent/tools" | "/api/agent/ask" {
		// DeepSeek always uses the tools endpoint
		return "/api/agent/tools";
	}
}
