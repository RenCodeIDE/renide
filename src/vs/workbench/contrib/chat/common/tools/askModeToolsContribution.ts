/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILanguageModelToolsService } from '../languageModelToolsService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';

// Existing Ask Mode Tools
import { SwitchViewTool, SwitchViewToolData } from './switchViewTool.js';
import { GraphControlTool, GraphControlToolData } from './graphControlTool.js';
import { OpenFileTool, OpenFileToolData } from './openFileTool.js';
import { CloseFileTool, CloseFileToolData } from './closeFileTool.js';
import { AskConfirmationTool, AskConfirmationToolData } from './askConfirmationTool.js';

// New Ask Mode Tools
import { OpenDocsTool, OpenDocsToolData } from './openDocsTool.js';
import { CloseDocsTool, CloseDocsToolData } from './closeDocsTool.js';
import { NavigateToLineTool, NavigateToLineToolData } from './navigateToLineTool.js';
import { HighlightLinesTool, HighlightLinesToolData } from './highlightLinesTool.js';

/**
 * Contribution that registers all Ask Mode interactive tools.
 * These tools enable the AI to create magical, visual teaching experiences by:
 * - Switching between code and graph views
 * - Controlling what graphs are displayed
 * - Opening/closing files and documentation
 * - Navigating to specific lines and highlighting code
 * - Asking the user confirmation questions
 */
export class AskModeToolsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.askModeTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		// --- Register View Switching Tools ---
		
		// Switch View Tool - switches between code and graph view
		const switchViewTool = instantiationService.createInstance(SwitchViewTool);
		this._register(toolsService.registerTool(SwitchViewToolData, switchViewTool));

		// --- Register Graph Control Tool ---
		
		// Graph Control Tool - controls what graph is displayed
		const graphControlTool = instantiationService.createInstance(GraphControlTool);
		this._register(toolsService.registerTool(GraphControlToolData, graphControlTool));

		// --- Register File Management Tools ---
		
		// Open File Tool - opens files in the editor
		const openFileTool = instantiationService.createInstance(OpenFileTool);
		this._register(toolsService.registerTool(OpenFileToolData, openFileTool));

		// Close File Tool - closes files in the editor
		const closeFileTool = instantiationService.createInstance(CloseFileTool);
		this._register(toolsService.registerTool(CloseFileToolData, closeFileTool));

		// --- Register Documentation Tools ---
		
		// Open Docs Tool - opens documentation panel for a file
		const openDocsTool = instantiationService.createInstance(OpenDocsTool);
		this._register(toolsService.registerTool(OpenDocsToolData, openDocsTool));

		// Close Docs Tool - closes documentation panel
		const closeDocsTool = instantiationService.createInstance(CloseDocsTool);
		this._register(toolsService.registerTool(CloseDocsToolData, closeDocsTool));

		// --- Register Navigation Tools ---
		
		// Navigate to Line Tool - navigates to specific line in a file
		const navigateToLineTool = instantiationService.createInstance(NavigateToLineTool);
		this._register(toolsService.registerTool(NavigateToLineToolData, navigateToLineTool));

		// Highlight Lines Tool - highlights a range of lines
		const highlightLinesTool = instantiationService.createInstance(HighlightLinesTool);
		this._register(toolsService.registerTool(HighlightLinesToolData, highlightLinesTool));

		// --- Register Confirmation Tool ---
		
		// Ask Confirmation Tool - asks user confirmation with custom options
		const askConfirmationTool = instantiationService.createInstance(AskConfirmationTool);
		this._register(toolsService.registerTool(AskConfirmationToolData, askConfirmationTool));
	}
}
