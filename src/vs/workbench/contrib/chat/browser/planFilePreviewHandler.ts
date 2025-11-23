/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IChatWidgetService, showChatView } from './chat.js';
import { ChatMode } from '../common/chatModes.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { handleModeSwitch } from './actions/chatActions.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';

/**
 * Handler for automatically opening .plan.md files in preview mode
 * and managing the "Start Execution" button functionality
 */
export class PlanFilePreviewHandler extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.planFilePreviewHandler';
	private static _instance: PlanFilePreviewHandler | undefined;
	private readonly _openedPlanFiles = new Set<string>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		PlanFilePreviewHandler._instance = this;

		// Listen for file opens
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const activeEditor = this.editorService.activeEditor;
			if (activeEditor?.resource) {
				this.handleFileOpen(activeEditor.resource);
			}
		}));
	}

	private isPlanFile(uri: URI): boolean {
		return uri.path.endsWith('.plan.md');
	}

	private async handleFileOpen(uri: URI): Promise<void> {
		if (!this.isPlanFile(uri)) {
			return;
		}

		const uriString = uri.toString();
		if (this._openedPlanFiles.has(uriString)) {
			// Already handled
			return;
		}

		this._openedPlanFiles.add(uriString);

		// Open in preview mode after a short delay to ensure file is fully loaded
		setTimeout(async () => {
			try {
				await this.commandService.executeCommand('markdown.showPreview', uri);
				this.logService.debug(`[PlanFilePreviewHandler] Opened plan file in preview: ${uri.fsPath}`);
			} catch (error) {
				this.logService.warn(`[PlanFilePreviewHandler] Failed to open plan file in preview: ${error}`);
			}
		}, 100);
	}

	/**
	 * Handle "Start Execution" button click from preview webview
	 */
	async handleStartExecution(planFileUri: URI): Promise<void> {
		this.logService.info(`[PlanFilePreviewHandler] Start execution requested for: ${planFileUri.fsPath}`);

		try {
			// Open chat view and get widget
			let widget = await showChatView(this.viewsService, this.layoutService);
			
			// If no widget from view, try last focused widget
			if (!widget) {
				widget = this.chatWidgetService.lastFocusedWidget;
			}

			if (!widget) {
				this.logService.warn('[PlanFilePreviewHandler] Could not get chat widget');
				return;
			}

			// Switch to Agent mode
			const agentMode = ChatMode.Agent;
			const currentMode = widget.input.currentModeKind;
			
			if (currentMode !== agentMode.kind) {
				const editingSession = widget.viewModel?.model.editingSession;
				const requestCount = widget.viewModel?.model.getRequests().length ?? 0;
				const chatModeCheck = await this.instantiationService.invokeFunction(
					handleModeSwitch,
					currentMode,
					agentMode.kind,
					requestCount,
					editingSession
				);

				if (!chatModeCheck) {
					this.logService.warn('[PlanFilePreviewHandler] Mode switch was cancelled');
					return;
				}

				widget.input.setChatMode(agentMode.id);

				if (chatModeCheck.needToClearSession) {
					await this.commandService.executeCommand('workbench.action.chat.newChat');
				}
			}

			// Read plan file content
			let planContent = '';
			try {
				const fileContent = await this.fileService.readFile(planFileUri);
				planContent = fileContent.value.toString();
			} catch (error) {
				this.logService.warn(`[PlanFilePreviewHandler] Failed to read plan file: ${error}`);
			}

			// Prepare message
			const workspaceRelativePath = this.getWorkspaceRelativePath(planFileUri);
			const message = `Please implement the plan in ${workspaceRelativePath || planFileUri.fsPath}.\n\n${planContent ? `Plan content:\n\n${planContent}` : ''}`;

			// Set input and send
			widget.setInput(message);
			await widget.waitForReady();
			await widget.acceptInput();

			this.logService.info('[PlanFilePreviewHandler] Start execution message sent');
		} catch (error) {
			this.logService.error('[PlanFilePreviewHandler] Failed to start execution', error);
		}
	}

	private getWorkspaceRelativePath(uri: URI): string | undefined {
		// Simple implementation - could be enhanced to use workspace service
		const path = uri.fsPath;
		// Try to extract relative path from common workspace patterns
		// This is a simplified version
		return path;
	}

	static getInstance(): PlanFilePreviewHandler | undefined {
		return PlanFilePreviewHandler._instance;
	}
}

/**
 * Command action for starting plan execution from preview
 */
class StartPlanExecutionAction extends Action2 {
	static readonly ID = 'workbench.action.chat.startPlanExecution';

	constructor() {
		super({
			id: StartPlanExecutionAction.ID,
			title: {
				value: localize('startPlanExecution', 'Start Plan Execution'),
				original: 'Start Plan Execution'
			},
			category: localize('chat', 'Chat'),
			f1: false // Hidden from command palette
		});
	}

	async run(accessor: ServicesAccessor, uri?: string): Promise<void> {
		if (!uri) {
			return;
		}

		const handler = PlanFilePreviewHandler.getInstance();
		if (!handler) {
			return;
		}

		await handler.handleStartExecution(URI.parse(uri));
	}
}

registerAction2(StartPlanExecutionAction);

