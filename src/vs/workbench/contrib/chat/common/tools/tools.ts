/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../common/languageModelToolsService.js';
import { ConfirmationTool, ConfirmationToolData } from './confirmationTool.js';
import { EditTool, EditToolData } from './editFileTool.js';
import { createManageTodoListToolData, ManageTodoListTool, TodoListToolWriteOnlySettingId, TodoListToolDescriptionFieldSettingId } from './manageTodoListTool.js';
import { ManagePlanTool, ManagePlanToolData } from './managePlanTool.js';
import { PlanFileTool, PlanFileToolData } from './planFileTool.js';
import { CreatePlanFileTool, CreatePlanFileToolData } from './createPlanFileTool.js';
import { ReadFileTool, ReadFileToolData } from './readFileTool.js';
import { CreateFileTool, CreateFileToolData } from './createFileTool.js';
import { DeleteFileTool, DeleteFileToolData } from './deleteFileTool.js';
import { SearchFilesTool, SearchFilesToolData } from './searchFilesTool.js';
import { GetDocsTool, GetDocsToolData } from './getDocsTool.js';
import { CheckLinterTool, CheckLinterToolData } from './checkLinterTool.js';
import { SemanticSearchTool, SemanticSearchToolData } from './semanticSearchTool.js';

export class BuiltinToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.builtinTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Register EditTool FIRST - this ensures it appears early in tool lists
		// and is more likely to be discovered by agents. EditTool is the PREFERRED
		// method for file edits as it provides reliable changelog tracking.
		const editTool = instantiationService.createInstance(EditTool);
		this._register(toolsService.registerTool(EditToolData, editTool));

		// Check if write-only mode is enabled for the todo tool
		const writeOnlyMode = this.configurationService.getValue<boolean>(TodoListToolWriteOnlySettingId) === true;
		const includeDescription = this.configurationService.getValue<boolean>(TodoListToolDescriptionFieldSettingId) !== false;
		const todoToolData = createManageTodoListToolData(writeOnlyMode, includeDescription);
		const manageTodoListTool = this._register(instantiationService.createInstance(ManageTodoListTool, writeOnlyMode, includeDescription));
		this._register(toolsService.registerTool(todoToolData, manageTodoListTool));

		// Register the confirmation tool
		const confirmationTool = instantiationService.createInstance(ConfirmationTool);
		this._register(toolsService.registerTool(ConfirmationToolData, confirmationTool));

		// Register the plan management tool (internal agent tool)
		const managePlanTool = instantiationService.createInstance(ManagePlanTool);
		this._register(toolsService.registerTool(ManagePlanToolData, managePlanTool));

		// Register the plan file tools (Plan Mode)
		const createPlanFileTool = instantiationService.createInstance(CreatePlanFileTool);
		this._register(toolsService.registerTool(CreatePlanFileToolData, createPlanFileTool));

		const planFileTool = instantiationService.createInstance(PlanFileTool);
		this._register(toolsService.registerTool(PlanFileToolData, planFileTool));

		// Register file operation tools
		const readFileTool = instantiationService.createInstance(ReadFileTool);
		this._register(toolsService.registerTool(ReadFileToolData, readFileTool));

		const createFileTool = instantiationService.createInstance(CreateFileTool);
		this._register(toolsService.registerTool(CreateFileToolData, createFileTool));

		const deleteFileTool = instantiationService.createInstance(DeleteFileTool);
		this._register(toolsService.registerTool(DeleteFileToolData, deleteFileTool));

		const searchFilesTool = instantiationService.createInstance(SearchFilesTool);
		this._register(toolsService.registerTool(SearchFilesToolData, searchFilesTool));

		const getDocsTool = instantiationService.createInstance(GetDocsTool);
		this._register(toolsService.registerTool(GetDocsToolData, getDocsTool));

		// Register the linter check tool
		const checkLinterTool = instantiationService.createInstance(CheckLinterTool);
		this._register(toolsService.registerTool(CheckLinterToolData, checkLinterTool));

		// Register the semantic codebase search tool
		const semanticSearchTool = instantiationService.createInstance(SemanticSearchTool);
		this._register(toolsService.registerTool(SemanticSearchToolData, semanticSearchTool));
	}
}

export const InternalFetchWebPageToolId = 'vscode_fetchWebPage_internal';
