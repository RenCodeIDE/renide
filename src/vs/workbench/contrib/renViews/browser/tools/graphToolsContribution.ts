/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { ILanguageModelToolsService } from "../../../chat/common/languageModelToolsService.js";
import { IInstantiationService } from "../../../../../platform/instantiation/common/instantiation.js";
import { GraphGetStateTool } from "./graphGetStateTool.js";
import { GraphSelectNodesTool } from "./graphSelectNodesTool.js";

export class GraphToolsContribution extends Disposable {
	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		const getStateTool = instantiationService.createInstance(GraphGetStateTool);
		const selectNodesTool =
			instantiationService.createInstance(GraphSelectNodesTool);

		this._register(
			toolsService.registerTool(GraphGetStateTool.DEFINITION, getStateTool)
		);
		this._register(
			toolsService.registerTool(
				GraphSelectNodesTool.DEFINITION,
				selectNodesTool
			)
		);
	}
}
