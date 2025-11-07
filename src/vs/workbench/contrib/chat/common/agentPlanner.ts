/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FileDependencyGraph } from './dependencyGraphService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export const IAgentPlanner = createDecorator<IAgentPlanner>('agentPlanner');

export interface AgentPlan {
	readonly id: string;
	readonly requestId: string;
	readonly sessionId: string;
	readonly goal: string;
	readonly tasks: readonly PlanTask[];
	readonly createdAt: number;
	readonly status: 'planning' | 'approved' | 'executing' | 'completed' | 'cancelled';
}

export interface PlanTask {
	readonly id: string;
	readonly description: string;
	readonly toolId?: string;
	readonly dependencies: readonly string[]; // Task IDs this depends on
	readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
	readonly result?: string;
	readonly error?: string;
	readonly filesAffected?: readonly string[];
}

export interface PlanContext {
	readonly dependencyGraphs: Map<string, FileDependencyGraph>;
	readonly availableTools: readonly ToolMetadata[];
	readonly workspaceFiles: readonly URI[];
}

export interface ToolMetadata {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly cost?: number; // Estimated cost/complexity (1-10)
	readonly latency?: number; // Estimated latency in ms
	readonly prerequisites?: readonly string[]; // Tool IDs that should run first
}

export interface IAgentPlanner {
	readonly _serviceBrand: undefined;

	/**
	 * Generate a plan from a user request
	 */
	generatePlan(
		requestId: string,
		sessionId: string,
		goal: string,
		context: PlanContext
	): Promise<AgentPlan>;

	/**
	 * Update task status in a plan
	 */
	updateTaskStatus(planId: string, taskId: string, status: PlanTask['status'], result?: string, error?: string): void;

	/**
	 * Get current plan for a request
	 */
	getPlan(requestId: string): AgentPlan | undefined;

	/**
	 * Approve a plan (mark as approved)
	 */
	approvePlan(planId: string): void;

	/**
	 * Cancel a plan
	 */
	cancelPlan(planId: string): void;
}

export class AgentPlanner extends Disposable implements IAgentPlanner {
	declare readonly _serviceBrand: undefined;

	private readonly plans = new Map<string, AgentPlan>();
	private static readonly PLAN_FILE = 'AGENT_PLAN.md';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	async generatePlan(
		requestId: string,
		sessionId: string,
		goal: string,
		context: PlanContext
	): Promise<AgentPlan> {
		// Generate plan ID
		const planId = `${requestId}-${Date.now()}`;

		// Analyze dependencies to determine task order
		const tasks = await this.analyzeAndCreateTasks(goal, context);

		const plan: AgentPlan = {
			id: planId,
			requestId,
			sessionId,
			goal,
			tasks,
			createdAt: Date.now(),
			status: 'planning',
		};

		this.plans.set(requestId, plan);
		await this.writePlanToFile(plan);

		this.logService.info(`[AgentPlanner] Generated plan ${planId} with ${tasks.length} tasks`);
		return plan;
	}

	updateTaskStatus(planId: string, taskId: string, status: PlanTask['status'], result?: string, error?: string): void {
		const plan = Array.from(this.plans.values()).find(p => p.id === planId);
		if (!plan) {
			this.logService.warn(`[AgentPlanner] Plan ${planId} not found`);
			return;
		}

		const taskIndex = plan.tasks.findIndex(t => t.id === taskId);
		if (taskIndex === -1) {
			this.logService.warn(`[AgentPlanner] Task ${taskId} not found in plan ${planId}`);
			return;
		}

		const updatedTasks = [...plan.tasks];
		updatedTasks[taskIndex] = {
			...updatedTasks[taskIndex],
			status,
			result,
			error,
		};

		const updatedPlan: AgentPlan = {
			...plan,
			tasks: updatedTasks,
			status: this.computePlanStatus(updatedTasks, plan.status),
		};

		this.plans.set(plan.requestId, updatedPlan);
		this.writePlanToFile(updatedPlan).catch(err => {
			this.logService.error(`[AgentPlanner] Failed to write plan file: ${err}`);
		});
	}

	getPlan(requestId: string): AgentPlan | undefined {
		return this.plans.get(requestId);
	}

	approvePlan(planId: string): void {
		const plan = Array.from(this.plans.values()).find(p => p.id === planId);
		if (!plan) {
			return;
		}

		const updatedPlan: AgentPlan = {
			...plan,
			status: 'approved',
		};

		this.plans.set(plan.requestId, updatedPlan);
		this.writePlanToFile(updatedPlan).catch(err => {
			this.logService.error(`[AgentPlanner] Failed to write plan file: ${err}`);
		});
	}

	cancelPlan(planId: string): void {
		const plan = Array.from(this.plans.values()).find(p => p.id === planId);
		if (!plan) {
			return;
		}

		const updatedPlan: AgentPlan = {
			...plan,
			status: 'cancelled',
		};

		this.plans.set(plan.requestId, updatedPlan);
		this.writePlanToFile(updatedPlan).catch(err => {
			this.logService.error(`[AgentPlanner] Failed to write plan file: ${err}`);
		});
	}

	private async analyzeAndCreateTasks(goal: string, context: PlanContext): Promise<PlanTask[]> {
		// This is a simplified task creation - in a real implementation,
		// this would use an LLM to analyze the goal and create structured tasks
		// For now, we create a basic task structure based on dependency analysis

		const tasks: PlanTask[] = [];
		let taskCounter = 1;

		// Analyze which files might be affected based on goal keywords
		const affectedFiles = this.identifyAffectedFiles(goal, context);
		
		// Create tasks based on dependency order
		const fileOrder = this.orderFilesByDependencies(affectedFiles, context.dependencyGraphs);

		for (const fileUri of fileOrder) {
			tasks.push({
				id: `task-${taskCounter++}`,
				description: `Analyze and modify ${fileUri.path}`,
				dependencies: this.getFileDependencies(fileUri, context.dependencyGraphs, tasks),
				status: 'pending',
				filesAffected: [fileUri.toString()],
			});
		}

		// Add a final validation task
		if (tasks.length > 0) {
			tasks.push({
				id: `task-${taskCounter++}`,
				description: 'Validate changes and run tests',
				dependencies: tasks.map(t => t.id),
				status: 'pending',
			});
		}

		return tasks;
	}

	private identifyAffectedFiles(goal: string, context: PlanContext): URI[] {
		// Simple keyword-based file identification
		// In a real implementation, this would use semantic search or LLM analysis
		const keywords = goal.toLowerCase().split(/\s+/);
		const affected: URI[] = [];

		for (const fileUri of context.workspaceFiles) {
			const fileName = fileUri.path.toLowerCase();
			if (keywords.some(keyword => fileName.includes(keyword))) {
				affected.push(fileUri);
			}
		}

		return affected;
	}

	private orderFilesByDependencies(
		files: URI[],
		graphs: Map<string, FileDependencyGraph>
	): URI[] {
		// Topological sort based on import dependencies
		const ordered: URI[] = [];
		const visited = new Set<string>();
		const visiting = new Set<string>();

		const visit = (fileUri: URI) => {
			const key = fileUri.toString();
			if (visited.has(key)) {
				return;
			}
			if (visiting.has(key)) {
				// Circular dependency - add anyway
				return;
			}

			visiting.add(key);
			const graph = graphs.get(key);
			if (graph) {
				// Visit dependencies first
				for (const imp of graph.imports) {
					if (imp.targetUri) {
						const depUri = URI.parse(imp.targetUri);
						if (files.some(f => f.toString() === depUri.toString())) {
							visit(depUri);
						}
					}
				}
			}
			visiting.delete(key);
			visited.add(key);
			ordered.push(fileUri);
		};

		for (const fileUri of files) {
			visit(fileUri);
		}

		return ordered;
	}

	private getFileDependencies(
		fileUri: URI,
		graphs: Map<string, FileDependencyGraph>,
		existingTasks: PlanTask[]
	): string[] {
		const graph = graphs.get(fileUri.toString());
		if (!graph) {
			return [];
		}

		// Find tasks that affect files this file imports
		const dependencies: string[] = [];
		for (const imp of graph.imports) {
			if (imp.targetUri) {
				const depTask = existingTasks.find(t => 
					t.filesAffected?.some(f => f === imp.targetUri)
				);
				if (depTask) {
					dependencies.push(depTask.id);
				}
			}
		}

		return dependencies;
	}

	private computePlanStatus(tasks: PlanTask[], currentStatus: AgentPlan['status']): AgentPlan['status'] {
		if (currentStatus === 'cancelled') {
			return 'cancelled';
		}

		const allCompleted = tasks.every(t => t.status === 'completed' || t.status === 'skipped');
		const anyInProgress = tasks.some(t => t.status === 'in_progress');
		const anyFailed = tasks.some(t => t.status === 'failed');

		if (allCompleted) {
			return 'completed';
		}
		if (anyFailed) {
			return 'executing'; // Keep executing even if some tasks fail
		}
		if (anyInProgress || currentStatus === 'executing') {
			return 'executing';
		}
		if (currentStatus === 'approved') {
			return 'executing';
		}
		return currentStatus;
	}

	private async writePlanToFile(plan: AgentPlan): Promise<void> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			if (workspaceFolders.length === 0) {
				return;
			}

			const planUri = URI.joinPath(workspaceFolders[0].uri, AgentPlanner.PLAN_FILE);
			const content = this.formatPlan(plan);

			await this.fileService.writeFile(planUri, VSBuffer.fromString(content));
		} catch (error) {
			this.logService.error(`[AgentPlanner] Failed to write plan file: ${error}`);
		}
	}

	private formatPlan(plan: AgentPlan): string {
		const lines: string[] = [];

		lines.push('# Agent Plan');
		lines.push('');
		lines.push(`**Plan ID:** ${plan.id}`);
		lines.push(`**Status:** ${plan.status}`);
		lines.push(`**Goal:** ${plan.goal}`);
		lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
		lines.push('');

		lines.push('## Tasks');
		lines.push('');

		if (plan.tasks.length === 0) {
			lines.push('*No tasks defined yet.*');
		} else {
			for (const task of plan.tasks) {
				const statusIcon = this.getStatusIcon(task.status);
				lines.push(`### ${statusIcon} ${task.description}`);
				lines.push('');
				lines.push(`- **ID:** ${task.id}`);
				lines.push(`- **Status:** ${task.status}`);
				
				if (task.dependencies.length > 0) {
					lines.push(`- **Depends on:** ${task.dependencies.join(', ')}`);
				}

				if (task.filesAffected && task.filesAffected.length > 0) {
					lines.push(`- **Files:** ${task.filesAffected.map(f => URI.parse(f).path).join(', ')}`);
				}

				if (task.result) {
					lines.push(`- **Result:** ${task.result}`);
				}

				if (task.error) {
					lines.push(`- **Error:** ${task.error}`);
				}

				lines.push('');
			}
		}

		lines.push('---');
		lines.push(`*This plan is automatically generated and updated by the Ren IDE agent.*`);

		return lines.join('\n');
	}

	private getStatusIcon(status: PlanTask['status']): string {
		switch (status) {
			case 'completed':
				return '✅';
			case 'in_progress':
				return '🔄';
			case 'failed':
				return '❌';
			case 'skipped':
				return '⏭️';
			default:
				return '⏳';
		}
	}
}
