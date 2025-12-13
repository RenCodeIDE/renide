/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from "../../../../../platform/log/common/log.js";
import {
	IChatAgentService,
} from "../../common/chatAgents.js";
import {
	ILanguageModelsService,
} from "../../common/languageModels.js";
import {
	ILanguageModelToolsService,
} from "../../common/languageModelToolsService.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { ITextModelService } from "../../../../../editor/common/services/resolverService.js";
import { GEMINI_MODELS } from "./models.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { ILanguageFeaturesService } from "../../../../../editor/common/services/languageFeatures.js";
import { IMetricsService } from "../../../../services/metrics/common/metricsService.js";
import { BaseAgentImplementation } from "../baseAgentImplementation.js";

export class GeminiAgentImplementation extends BaseAgentImplementation {
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
		metricsService?: IMetricsService
	) {
		super(
			{
				vendorId: "gemini",
				logPrefix: "[gemini-server]",
				defaultModelId: "gemini-2.5-flash"
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
			metricsService
		);
	}

	protected getModels(): Array<{ id: string; identifier: string; isDefault?: boolean; maxOutputTokens?: number }> {
		return GEMINI_MODELS;
	}
}
