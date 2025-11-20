/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageModelToolsService } from '../../chat/common/languageModelToolsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MonitorXLogDraftTool } from './monitorXChangelogTool.js';
import {
	MonitorXSearchChangelogTool,
	MonitorXGetChangelogDetailsTool,
	MonitorXGetRecentChangelogTool,
	MonitorXGetChangelogStatsTool
} from './monitorXChangelogQueryTools.js';

export class MonitorXChangelogToolsContribution extends Disposable {
	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		const logDraftTool = instantiationService.createInstance(MonitorXLogDraftTool);
		const searchTool = instantiationService.createInstance(MonitorXSearchChangelogTool);
		const detailsTool = instantiationService.createInstance(MonitorXGetChangelogDetailsTool);
		const recentTool = instantiationService.createInstance(MonitorXGetRecentChangelogTool);
		const statsTool = instantiationService.createInstance(MonitorXGetChangelogStatsTool);

		this._register(toolsService.registerTool(MonitorXLogDraftTool.DEFINITION, logDraftTool));
		this._register(toolsService.registerTool(MonitorXSearchChangelogTool.DEFINITION, searchTool));
		this._register(toolsService.registerTool(MonitorXGetChangelogDetailsTool.DEFINITION, detailsTool));
		this._register(toolsService.registerTool(MonitorXGetRecentChangelogTool.DEFINITION, recentTool));
		this._register(toolsService.registerTool(MonitorXGetChangelogStatsTool.DEFINITION, statsTool));
	}
}

