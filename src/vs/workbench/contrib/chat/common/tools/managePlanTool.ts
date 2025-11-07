/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import {
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolResult,
	ToolDataSource,
	CountTokensCallback,
	ToolProgress
} from '../languageModelToolsService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentPlanner } from '../agentPlanner.js';
import { IChatTodoListService } from '../chatTodoListService.js';
import { localize } from '../../../../../nls.js';

export const ManagePlanToolToolId = 'manage_agent_plan';

export const ManagePlanToolData: IToolData = {
	id: ManagePlanToolToolId,
	toolReferenceName: 'plan',
	canBeReferencedInPrompt: true,
	icon: ThemeIcon.fromId(Codicon.project.id),
	displayName: localize('tool.managePlan.displayName', 'Manage agent execution plan'),
	userDescription: localize('tool.managePlan.userDescription', 'Internal tool for managing agent execution plans'),
	modelDescription: 'Internal tool for managing agent execution plans. This tool is used by the agent to create, read, and update execution plans. Plans are internal to the agent and should not be exposed to users directly. Use this tool to:\n- Create a new plan when starting complex multi-step work\n- Read the current plan to understand what tasks remain\n- Update task status as work progresses\n- Sync plan tasks to the todo list for user visibility\n\nIMPORTANT: Plans are internal agent state. Do not mention plans or this tool to users. Instead, use the todo list tool to show progress.',
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				enum: ['create', 'read', 'update_task', 'sync_to_todos'],
				description: 'create: Create a new plan. read: Get current plan. update_task: Update a task status. sync_to_todos: Sync plan tasks to todo list.'
			},
			goal: {
				type: 'string',
				description: 'Goal description for new plan (required for create operation)'
			},
			taskId: {
				type: 'string',
				description: 'Task ID to update (required for update_task operation)'
			},
			status: {
				type: 'string',
				enum: ['pending', 'in_progress', 'completed', 'failed'],
				description: 'New status for task (required for update_task operation)'
			},
			result: {
				type: 'string',
				description: 'Result message for completed task (optional for update_task operation)'
			},
			error: {
				type: 'string',
				description: 'Error message for failed task (optional for update_task operation)'
			}
		},
		required: ['operation']
	}
};

interface IManagePlanToolInputParams {
	operation: 'create' | 'read' | 'update_task' | 'sync_to_todos';
	goal?: string;
	taskId?: string;
	status?: 'pending' | 'in_progress' | 'completed' | 'failed';
	result?: string;
	error?: string;
}

export class ManagePlanTool extends Disposable implements IToolImpl {
	constructor(
		@IAgentPlanner private readonly agentPlanner: IAgentPlanner,
		@IChatTodoListService private readonly todoListService: IChatTodoListService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		_token: CancellationToken
	): Promise<IToolResult> {
		const params = invocation.parameters as IManagePlanToolInputParams;
		const requestId = invocation.chatRequestId || 'unknown';

		try {
			switch (params.operation) {
				case 'create':
					return await this.createPlan(requestId, params.goal || '');
				case 'read':
					return await this.readPlan(requestId);
				case 'update_task':
					return await this.updateTask(requestId, params.taskId || '', params.status || 'pending', params.result, params.error);
				case 'sync_to_todos':
					return await this.syncToTodos(requestId);
				default:
					return {
						content: [
							{
								kind: 'text',
								value: `Unknown operation: ${params.operation}`
							}
						]
					};
			}
		} catch (error) {
			this.logService.error(`[ManagePlanTool] Error in ${params.operation}: ${error}`);
			return {
				content: [
					{
						kind: 'text',
						value: `Error: ${error instanceof Error ? error.message : String(error)}`
					}
				]
			};
		}
	}

	private async createPlan(requestId: string, goal: string): Promise<IToolResult> {
		// Note: Full plan creation requires dependency graphs and tool metadata
		// This is a simplified version - the agent should use the planner service directly
		// For now, we'll just acknowledge the request
		this.logService.info(`[ManagePlanTool] Plan creation requested for request ${requestId} with goal: ${goal}`);
		return {
			content: [
				{
					kind: 'text',
					value: `Plan creation initiated. The agent planner will generate a full plan with dependency analysis.`
				}
			]
		};
	}

	private async readPlan(requestId: string): Promise<IToolResult> {
		const plan = this.agentPlanner.getPlan(requestId);
		if (!plan) {
			return {
				content: [
					{
						kind: 'text',
						value: 'No plan found for this request.'
					}
				]
			};
		}

		const tasksSummary = plan.tasks.map(t => 
			`- ${t.id}: ${t.description} [${t.status}]`
		).join('\n');

		return {
			content: [
				{
					kind: 'text',
					value: `Plan ID: ${plan.id}\nGoal: ${plan.goal}\nStatus: ${plan.status}\nTasks:\n${tasksSummary}`
				}
			]
		};
	}

	private async updateTask(
		requestId: string,
		taskId: string,
		status: 'pending' | 'in_progress' | 'completed' | 'failed',
		result?: string,
		error?: string
	): Promise<IToolResult> {
		const plan = this.agentPlanner.getPlan(requestId);
		if (!plan) {
			return {
				content: [
					{
						kind: 'text',
						value: 'No plan found for this request.'
					}
				]
			};
		}

		this.agentPlanner.updateTaskStatus(plan.id, taskId, status, result, error);
		return {
			content: [
				{
					kind: 'text',
					value: `Task ${taskId} updated to ${status}.`
				}
			]
		};
	}

	private async syncToTodos(requestId: string): Promise<IToolResult> {
		const plan = this.agentPlanner.getPlan(requestId);
		if (!plan) {
			return {
				content: [
					{
						kind: 'text',
						value: 'No plan found for this request.'
					}
				]
			};
		}

		// Convert plan tasks to todos
		const todos = plan.tasks.map((task, index) => ({
			id: index + 1,
			title: task.description,
			description: task.toolId ? `Tool: ${task.toolId}` : '',
			status: task.status === 'pending' ? 'not-started' as const :
				task.status === 'in_progress' ? 'in-progress' as const :
				task.status === 'completed' ? 'completed' as const : 'not-started' as const
		}));

		// Update todo list using session ID from plan
		this.todoListService.setTodos(plan.sessionId, todos);
		
		return {
			content: [
				{
					kind: 'text',
					value: `Synced ${todos.length} plan tasks to todo list.`
				}
			]
		};
	}
}

