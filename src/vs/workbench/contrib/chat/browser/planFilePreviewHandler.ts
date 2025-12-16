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
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { PlanValidator } from '../common/planValidator.js';
import { parsePlanMetadata } from '../common/tools/planTemplates.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IChatTodoListService, IChatTodo } from '../common/chatTodoListService.js';
import { IPlanExecutionTracker } from '../common/planExecutionTracker.js';

/**
 * Handler for automatically opening .plan.md files in preview mode
 * and managing the "Start Execution" button functionality
 */
export class PlanFilePreviewHandler extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.planFilePreviewHandler';
	private static _instance: PlanFilePreviewHandler | undefined;
	private readonly _openedPlanFiles = new Set<string>();

	private readonly planValidator: PlanValidator;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IChatTodoListService private readonly todoListService: IChatTodoListService,
		@IPlanExecutionTracker private readonly executionTracker: IPlanExecutionTracker,
	) {
		super();
		PlanFilePreviewHandler._instance = this;
		this.planValidator = this.instantiationService.createInstance(PlanValidator);

		// Listen for file opens
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const activeEditor = this.editorService.activeEditor;
			if (activeEditor?.resource) {
				this.handleFileOpen(activeEditor.resource);
			}
		}));

		// Listen to execution state changes to update preview
		this._register(this.executionTracker.onDidUpdateExecutionState(({ planUri, state }) => {
			// Trigger preview refresh by updating the file (if it's open)
			// The preview will automatically refresh when the file changes
			this.logService.debug(`[PlanFilePreviewHandler] Execution state updated for ${planUri}: ${state.status}`);
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
			// Verify file exists
			if (!await this.fileService.exists(planFileUri)) {
				this.notificationService.error(localize('planExecution.fileNotFound', 'Plan file not found: {0}', planFileUri.fsPath));
				this.logService.error(`[PlanFilePreviewHandler] Plan file does not exist: ${planFileUri.fsPath}`);
				return;
			}

			// Read plan file content
			let planContent = '';
			try {
				const fileContent = await this.fileService.readFile(planFileUri);
				planContent = fileContent.value.toString();
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.notificationService.error(localize('planExecution.readError', 'Failed to read plan file: {0}', errorMessage));
				this.logService.error(`[PlanFilePreviewHandler] Failed to read plan file: ${error}`);
				return;
			}

			// Validate plan before execution
			const validationResult = await this.planValidator.validatePlan(planContent, planFileUri);

			// Extract todos from plan (enhanced extraction)
			const todos = this.extractTodosFromPlan(planContent);
			const planMetadata = parsePlanMetadata(planContent);

			this.logService.debug(`[PlanFilePreviewHandler] Extracted ${todos.length} todos from plan`);

			// Get widget first
			let widget = await showChatView(this.viewsService, this.layoutService);
			if (!widget) {
				widget = this.chatWidgetService.lastFocusedWidget;
			}

			// Execute directly - no banner, regardless of validation errors or warnings
			await this.executePlanInternal(planFileUri, planContent, planMetadata, validationResult, todos, widget);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.notificationService.error(localize('planExecution.error', 'Failed to start plan execution: {0}', errorMessage));
			this.logService.error('[PlanFilePreviewHandler] Failed to start execution', error);
		}
	}

	/**
	 * Update preview with real-time progress
	 */
	private updatePreviewProgress(
		planFileUri: URI,
		progress: number,
		completedTodos: number,
		totalTodos: number,
		status: 'not-started' | 'starting' | 'in-progress' | 'completed' | 'failed',
		todos?: Array<{ id: string; text: string; status: string }>
	): void {
		// Send update to markdown preview via command
		this.commandService.executeCommand('markdown.updatePlanProgress',
			planFileUri.toString(),
			progress,
			completedTodos,
			totalTodos,
			status,
			todos
		).catch(error => {
			this.logService.debug(`[PlanFilePreviewHandler] Failed to update preview progress: ${error}`);
		});
	}

	/**
	 * Internal method to execute the plan
	 * Uses the current active chat if available, otherwise opens chat view.
	 * Directly adds todos and provides plan as context.
	 */
	private async executePlanInternal(
		planFileUri: URI,
		planContent: string,
		planMetadata: ReturnType<typeof parsePlanMetadata>,
		validationResult: Awaited<ReturnType<PlanValidator['validatePlan']>>,
		todos: Array<{ id: string; text: string; completed: boolean; section?: string; lineNumber?: number }>,
		widget: any
	): Promise<void> {
		try {
			// Priority: Use current active chat widget first, then show chat view
			if (!widget) {
				widget = this.chatWidgetService.lastFocusedWidget;
			}
			if (!widget) {
				widget = await showChatView(this.viewsService, this.layoutService);
			}

			if (!widget) {
				this.logService.warn('[PlanFilePreviewHandler] Could not get chat widget');
				this.notificationService.error(localize('planExecution.noChatWidget', 'Could not open chat. Please open chat manually and try again.'));
				return;
			}

			// Switch to Agent mode if needed (preserve conversation)
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
					this.notificationService.warn(localize('planExecution.modeSwitchCancelled', 'Mode switch was cancelled'));
					this.logService.warn('[PlanFilePreviewHandler] Mode switch was cancelled');
					return;
				}

				widget.input.setChatMode(agentMode.id);

				if (chatModeCheck.needToClearSession) {
					const confirmed = await this.dialogService.confirm({
						type: 'info',
						title: localize('planExecution.clearSessionTitle', 'Start new session?'),
						message: localize('planExecution.clearSessionPrompt', 'Switching to Agent mode will clear your current session. Continue?'),
						primaryButton: localize('yes', 'Yes'),
						cancelButton: localize('no', 'No')
					});

					if (confirmed.confirmed) {
						await this.commandService.executeCommand('workbench.action.chat.newChat');
					} else {
						this.logService.info('[PlanFilePreviewHandler] User cancelled session clear');
						return;
					}
				}
			}

			// Get session ID
			const sessionId = widget.viewModel?.model.sessionId || 'default';

			// Extract incomplete todos and directly add them to the session
			const incompleteTodos = todos.filter(t => !t.completed);

			// Directly create the todos in the todo service (don't ask agent to do it)
			if (incompleteTodos.length > 0) {
				const chatTodos: IChatTodo[] = incompleteTodos.map((todo, index) => ({
					id: index + 1,
					title: todo.text,
					description: todo.section ? `Section: ${todo.section}` : undefined,
					status: 'not-started' as const
				}));
				this.todoListService.setTodos(sessionId, chatTodos);
				this.logService.info(`[PlanFilePreviewHandler] Created ${chatTodos.length} todos directly`);
			}

			// Start execution tracking
			this.executionTracker.startExecution(planFileUri.toString(), sessionId, incompleteTodos.length);

			// Prepare a simple, focused message with plan as context
			const workspaceRelativePath = this.getWorkspaceRelativePath(planFileUri);
			const planTitle = planMetadata?.title || workspaceRelativePath || planFileUri.fsPath;

			let message = `Execute the implementation plan: **${planTitle}**\n\n`;
			message += `📋 **Todos have been added** (${incompleteTodos.length} items) - work through them systematically.\n\n`;
			message += `📄 **Plan file:** \`${workspaceRelativePath || planFileUri.fsPath}\`\n\n`;
			message += `---\n\n`;
			message += `**Plan Content:**\n\n${planContent}`;

			// Listen to todo updates to sync with execution tracker and plan file
			this._register(this.todoListService.onDidUpdateTodos((updatedSessionId) => {
				if (updatedSessionId === sessionId) {
					const currentTodos = this.todoListService.getTodos(updatedSessionId);
					const completedCount = currentTodos.filter(t => t.status === 'completed').length;
					const totalCount = currentTodos.length;
					const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

					this.executionTracker.updateProgress(planFileUri.toString(), completedCount);

					// Update preview with real-time progress
					const todosForPreview = currentTodos.map(t => ({
						id: String(t.id),
						text: t.title + (t.description ? `: ${t.description}` : ''),
						status: t.status === 'not-started' ? 'pending' : t.status
					}));
					this.updatePreviewProgress(planFileUri, progress, completedCount, totalCount, 'in-progress', todosForPreview);

					// Sync plan file with todo completion
					this.syncPlanFileWithTodos(planFileUri, planContent, todos, currentTodos).catch(error => {
						this.logService.warn(`[PlanFilePreviewHandler] Failed to sync plan file: ${error}`);
					});
				}
			}));

			// Set input and send
			this.logService.info(`[PlanFilePreviewHandler] Setting input message (length: ${message.length} chars)`);
			widget.setInput(message);
			await widget.waitForReady();
			this.logService.info(`[PlanFilePreviewHandler] Widget ready, accepting input`);
			await widget.acceptInput();
			this.logService.info(`[PlanFilePreviewHandler] Input accepted, message sent to agent`);

			// Mark execution as in-progress
			this.executionTracker.setExecutionState(planFileUri.toString(), {
				status: 'in-progress'
			});

			// Send initial progress update to preview
			const initialTodosForPreview = incompleteTodos.map(t => ({
				id: t.id,
				text: t.text,
				status: 'pending' as const
			}));
			this.updatePreviewProgress(planFileUri, 0, 0, incompleteTodos.length, 'starting', initialTodosForPreview);

			this.logService.info(`[PlanFilePreviewHandler] Plan execution started. Todos: ${incompleteTodos.length}`);
		} catch (error) {
			this.logService.error('[PlanFilePreviewHandler] Failed to execute plan', error);
		}
	}

	/**
	 * Extract todos from plan content with enhanced regex patterns
	 */
	private extractTodosFromPlan(planContent: string): Array<{ id: string; text: string; completed: boolean; section?: string; lineNumber?: number }> {
		const todos: Array<{ id: string; text: string; completed: boolean; section?: string; lineNumber?: number }> = [];

		// Enhanced regex patterns to match various markdown todo formats
		const todoPatterns = [
			/^\s*[-*]\s*\[([\sx])\]\s*(.+)$/gim,  // Standard: - [ ] or - [x]
			/^\s*\d+\.\s*\[([\sx])\]\s*(.+)$/gim, // Numbered: 1. [ ] or 1. [x]
		];

		const lines = planContent.split('\n');
		let currentSection: string | undefined;

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];

			// Track current section
			const sectionMatch = line.match(/^##\s+(.+)$/);
			if (sectionMatch) {
				currentSection = sectionMatch[1].trim();
			}

			// Try each pattern
			for (const pattern of todoPatterns) {
				pattern.lastIndex = 0; // Reset regex
				const match = pattern.exec(line);
				if (match) {
					const todoId = `todo-${lineIndex}-${todos.length}`;
					todos.push({
						id: todoId,
						text: match[2].trim(),
						completed: match[1].toLowerCase() === 'x',
						section: currentSection,
						lineNumber: lineIndex + 1
					});
					break; // Found a match, move to next line
				}
			}
		}

		return todos;
	}

	/**
	 * Sync plan file markdown with todo completion status
	 */
	private async syncPlanFileWithTodos(
		planFileUri: URI,
		originalContent: string,
		planTodos: Array<{ id: string; text: string; completed: boolean; lineNumber?: number }>,
		chatTodos: IChatTodo[]
	): Promise<void> {
		try {
			// Create a map of chat todos by title for matching
			const chatTodoMap = new Map<string, IChatTodo>();
			for (const todo of chatTodos) {
				chatTodoMap.set(todo.title, todo);
			}

			// Update plan content with completed todos
			let updatedContent = originalContent;
			const lines = updatedContent.split('\n');

			for (const planTodo of planTodos) {
				const chatTodo = chatTodoMap.get(planTodo.text);
				if (chatTodo && chatTodo.status === 'completed' && !planTodo.completed) {
					// Find the line and mark it as completed
					if (planTodo.lineNumber && planTodo.lineNumber <= lines.length) {
						const lineIndex = planTodo.lineNumber - 1;
						const line = lines[lineIndex];
						// Replace [ ] with [x] (case-insensitive)
						const updatedLine = line.replace(/\[\s\]/gi, '[x]');
						if (updatedLine !== line) {
							lines[lineIndex] = updatedLine;
						}
					}
				}
			}

			const newContent = lines.join('\n');
			if (newContent !== originalContent) {
				// Write updated content back to file
				const buffer = VSBuffer.fromString(newContent);
				await this.fileService.writeFile(planFileUri, buffer);
				this.logService.debug(`[PlanFilePreviewHandler] Updated plan file with completed todos`);
			}
		} catch (error) {
			this.logService.warn(`[PlanFilePreviewHandler] Error syncing plan file: ${error}`);
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
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);

		logService.info(`[StartPlanExecutionAction] Command called with URI: ${uri}`);

		if (!uri) {
			logService.error('[StartPlanExecutionAction] No URI provided');
			notificationService.error(localize('planExecution.noUri', 'Plan execution failed: No plan file URI provided'));
			return;
		}

		const handler = PlanFilePreviewHandler.getInstance();
		if (!handler) {
			logService.error('[StartPlanExecutionAction] PlanFilePreviewHandler instance not found');
			notificationService.error(localize('planExecution.noHandler', 'Plan execution failed: Handler not available. Please try again.'));
			return;
		}

		try {
			logService.info(`[StartPlanExecutionAction] Parsing URI: ${uri}`);
			const planUri = URI.parse(uri);
			logService.info(`[StartPlanExecutionAction] Parsed URI successfully: ${planUri.toString()}`);
			await handler.handleStartExecution(planUri);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logService.error('[StartPlanExecutionAction] Failed to parse URI or execute plan', error);
			notificationService.error(localize('planExecution.parseError', 'Failed to parse plan URI: {0}', errorMessage));
		}
	}
}

registerAction2(StartPlanExecutionAction);

