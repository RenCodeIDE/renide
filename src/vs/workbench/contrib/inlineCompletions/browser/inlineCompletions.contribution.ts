/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { withoutDuplicates } from '../../../../base/common/arrays.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { inlineCompletionProviderGetMatcher, providerIdSchemaUri } from '../../../../editor/contrib/inlineCompletions/browser/controller/commands.js';
import { Extensions, IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { wrapInHotClass1 } from '../../../../platform/observable/common/wrapInHotClass.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InlineCompletionLanguageStatusBarContribution } from './inlineCompletionLanguageStatusBarContribution.js';
import { AIInlineCompletionsProvider } from './aiInlineCompletionsProvider.js';

registerWorkbenchContribution2(InlineCompletionLanguageStatusBarContribution.Id, wrapInHotClass1(InlineCompletionLanguageStatusBarContribution.hot), WorkbenchPhase.Eventually);

export class InlineCompletionSchemaContribution extends Disposable implements IWorkbenchContribution {
	public static Id = 'vs.contrib.InlineCompletionSchemaContribution';

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		const registry = Registry.as<IJSONContributionRegistry>(Extensions.JSONContribution);
		const inlineCompletionsProvider = observableFromEvent(this,
			this._languageFeaturesService.inlineCompletionsProvider.onDidChange,
			() => this._languageFeaturesService.inlineCompletionsProvider.allNoModel()
		);

		this._register(autorun(reader => {
			const provider = inlineCompletionsProvider.read(reader);
			registry.registerSchema(providerIdSchemaUri, {
				enum: withoutDuplicates(provider.flatMap(p => inlineCompletionProviderGetMatcher(p))),
			}, reader.store);
		}));
	}
}

registerWorkbenchContribution2(InlineCompletionSchemaContribution.Id, InlineCompletionSchemaContribution, WorkbenchPhase.Eventually);

export class AIInlineCompletionsContribution extends Disposable implements IWorkbenchContribution {
	public static Id = 'ren.contrib.AIInlineCompletions';

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		// Register the AI inline completions provider for all languages
		const provider = this._instantiationService.createInstance(AIInlineCompletionsProvider);
		this._register(
			this._languageFeaturesService.inlineCompletionsProvider.register('*', provider)
		);
	}
}

registerWorkbenchContribution2(AIInlineCompletionsContribution.Id, AIInlineCompletionsContribution, WorkbenchPhase.Eventually);
