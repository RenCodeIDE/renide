/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatTodoListService, IChatTodo } from './chatTodoListService.js';

export interface IPlanTodo {
	id: string;
	text: string;
	completed: boolean;
	lineNumber: number;
	section?: string;
}

export const IPlanTodoSyncService = createDecorator<IPlanTodoSyncService>('planTodoSyncService');

export interface IPlanTodoSyncService {
	readonly _serviceBrand: undefined;
	readonly onDidSyncPlanTodos: Event<{ planUri: URI; sessionId: string }>;

	/**
	 * Parse todos from a plan file and sync to the chat todo list
	 */
	syncPlanToTodos(planUri: URI, sessionId: string): Promise<void>;

	/**
	 * Sync todo status changes back to the plan file
	 */
	syncTodosToPlan(planUri: URI, sessionId: string): Promise<void>;

	/**
	 * Register a plan file for automatic syncing
	 */
	registerPlanFile(planUri: URI, sessionId: string): IDisposable;

	/**
	 * Parse todos from plan content without syncing
	 */
	parsePlanTodos(content: string): IPlanTodo[];
}

export class PlanTodoSyncService extends Disposable implements IPlanTodoSyncService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidSyncPlanTodos = this._register(new Emitter<{ planUri: URI; sessionId: string }>());
	readonly onDidSyncPlanTodos: Event<{ planUri: URI; sessionId: string }> = this._onDidSyncPlanTodos.event;

	private readonly registeredPlans = new Map<string, { sessionId: string; disposable: IDisposable }>();
	private isSyncing = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IChatTodoListService private readonly todoListService: IChatTodoListService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen for file changes to auto-sync registered plan files
		this._register(this.fileService.onDidFilesChange(event => {
			// Check each registered plan file to see if it was updated
			for (const [uriString, registered] of this.registeredPlans) {
				const planUri = URI.parse(uriString);
				if (event.affects(planUri, FileChangeType.UPDATED) && !this.isSyncing) {
					this.syncPlanToTodos(planUri, registered.sessionId).catch(err => {
						this.logService.warn('[PlanTodoSyncService] Error syncing plan on file change:', err);
					});
				}
			}
		}));

		// Listen for todo changes to sync back to plan files
		this._register(this.todoListService.onDidUpdateTodos(sessionId => {
			if (this.isSyncing) {
				return; // Avoid circular updates
			}

			// Find plan files registered for this session
			for (const [uriString, registered] of this.registeredPlans) {
				if (registered.sessionId === sessionId) {
					this.syncTodosToPlan(URI.parse(uriString), sessionId).catch(err => {
						this.logService.warn('[PlanTodoSyncService] Error syncing todos to plan:', err);
					});
					break;
				}
			}
		}));
	}

	async syncPlanToTodos(planUri: URI, sessionId: string): Promise<void> {
		try {
			this.isSyncing = true;

			const exists = await this.fileService.exists(planUri);
			if (!exists) {
				this.logService.debug(`[PlanTodoSyncService] Plan file does not exist: ${planUri.toString()}`);
				return;
			}

			const content = await this.fileService.readFile(planUri);
			const planContent = content.value.toString();
			const planTodos = this.parsePlanTodos(planContent);

			// Convert to chat todos
			const chatTodos: IChatTodo[] = planTodos.map((todo, index) => ({
				id: index + 1,
				title: todo.text,
				description: todo.section ? `Section: ${todo.section}` : undefined,
				status: todo.completed ? 'completed' : 'not-started'
			}));

			this.todoListService.setTodos(sessionId, chatTodos);
			this.logService.debug(`[PlanTodoSyncService] Synced ${chatTodos.length} todos from plan ${planUri.toString()}`);

			this._onDidSyncPlanTodos.fire({ planUri, sessionId });
		} catch (error) {
			this.logService.error('[PlanTodoSyncService] Error syncing plan to todos:', error);
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	async syncTodosToPlan(planUri: URI, sessionId: string): Promise<void> {
		try {
			this.isSyncing = true;

			const exists = await this.fileService.exists(planUri);
			if (!exists) {
				this.logService.debug(`[PlanTodoSyncService] Plan file does not exist: ${planUri.toString()}`);
				return;
			}

			const content = await this.fileService.readFile(planUri);
			const planContent = content.value.toString();
			const planTodos = this.parsePlanTodos(planContent);
			const chatTodos = this.todoListService.getTodos(sessionId);

			// Match todos by index (since IDs are 1-indexed from parsing order)
			let updatedContent = planContent;
			const lines = planContent.split('\n');

			for (let i = 0; i < Math.min(planTodos.length, chatTodos.length); i++) {
				const planTodo = planTodos[i];
				const chatTodo = chatTodos[i];

				if (planTodo.completed !== (chatTodo.status === 'completed')) {
					// Update the line in the content
					const lineIndex = planTodo.lineNumber - 1;
					if (lineIndex >= 0 && lineIndex < lines.length) {
						const line = lines[lineIndex];
						if (chatTodo.status === 'completed') {
							// Mark as completed
							lines[lineIndex] = line.replace(/- \[ \]/, '- [x]');
						} else {
							// Mark as not completed
							lines[lineIndex] = line.replace(/- \[x\]/i, '- [ ]');
						}
					}
				}
			}

			updatedContent = lines.join('\n');

			if (updatedContent !== planContent) {
				await this.fileService.writeFile(planUri, VSBuffer.fromString(updatedContent));
				this.logService.debug(`[PlanTodoSyncService] Updated plan file with todo changes: ${planUri.toString()}`);
			}
		} catch (error) {
			this.logService.error('[PlanTodoSyncService] Error syncing todos to plan:', error);
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	registerPlanFile(planUri: URI, sessionId: string): IDisposable {
		const uriString = planUri.toString();

		// Clean up existing registration if any
		const existing = this.registeredPlans.get(uriString);
		if (existing) {
			existing.disposable.dispose();
		}

		const disposable = {
			dispose: () => {
				this.registeredPlans.delete(uriString);
			}
		};

		this.registeredPlans.set(uriString, { sessionId, disposable });
		this.logService.debug(`[PlanTodoSyncService] Registered plan file: ${uriString} for session: ${sessionId}`);

		// Initial sync
		this.syncPlanToTodos(planUri, sessionId).catch(err => {
			this.logService.warn('[PlanTodoSyncService] Error during initial sync:', err);
		});

		return disposable;
	}

	parsePlanTodos(content: string): IPlanTodo[] {
		const todos: IPlanTodo[] = [];
		const lines = content.split('\n');
		let currentSection: string | undefined;
		let todoIndex = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNumber = i + 1;

			// Track current section (## headers)
			const sectionMatch = line.match(/^##\s+(.+)$/);
			if (sectionMatch) {
				currentSection = sectionMatch[1].trim();
				continue;
			}

			// Parse todo items: - [ ] or - [x]
			const todoMatch = line.match(/^(\s*)-\s*\[([ xX])\]\s*(.+)$/);
			if (todoMatch) {
				const completed = todoMatch[2].toLowerCase() === 'x';
				const text = todoMatch[3].trim();

				todos.push({
					id: `todo-${todoIndex++}`,
					text,
					completed,
					lineNumber,
					section: currentSection
				});
			}
		}

		return todos;
	}

	override dispose(): void {
		for (const [, registered] of this.registeredPlans) {
			registered.disposable.dispose();
		}
		this.registeredPlans.clear();
		super.dispose();
	}
}
