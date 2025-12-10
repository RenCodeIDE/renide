/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type PlanExecutionStatus = 'not-started' | 'starting' | 'in-progress' | 'completed' | 'failed';

export interface PlanExecutionState {
	planUri: string;
	status: PlanExecutionStatus;
	startedAt?: number;
	completedAt?: number;
	todoCount: number;
	completedTodos: number;
	chatSessionId?: string;
}

export const IPlanExecutionTracker = createDecorator<IPlanExecutionTracker>('planExecutionTracker');

export interface IPlanExecutionTracker {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateExecutionState: Event<{ planUri: string; state: PlanExecutionState }>;
	getExecutionState(planUri: string): PlanExecutionState | undefined;
	setExecutionState(planUri: string, state: Partial<PlanExecutionState>): void;
	startExecution(planUri: string, chatSessionId: string, todoCount: number): void;
	updateProgress(planUri: string, completedTodos: number): void;
	completeExecution(planUri: string, success: boolean): void;
}

export class PlanExecutionTracker extends Disposable implements IPlanExecutionTracker {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateExecutionState = this._register(new Emitter<{ planUri: string; state: PlanExecutionState }>());
	readonly onDidUpdateExecutionState: Event<{ planUri: string; state: PlanExecutionState }> = this._onDidUpdateExecutionState.event;

	private readonly executionStates = new Map<string, PlanExecutionState>();

	getExecutionState(planUri: string): PlanExecutionState | undefined {
		return this.executionStates.get(planUri);
	}

	setExecutionState(planUri: string, state: Partial<PlanExecutionState>): void {
		const currentState = this.executionStates.get(planUri);
		const newState: PlanExecutionState = {
			planUri,
			status: state.status || currentState?.status || 'not-started',
			startedAt: state.startedAt ?? currentState?.startedAt,
			completedAt: state.completedAt ?? currentState?.completedAt,
			todoCount: state.todoCount ?? currentState?.todoCount ?? 0,
			completedTodos: state.completedTodos ?? currentState?.completedTodos ?? 0,
			chatSessionId: state.chatSessionId ?? currentState?.chatSessionId
		};

		this.executionStates.set(planUri, newState);
		this._onDidUpdateExecutionState.fire({ planUri, state: newState });
	}

	startExecution(planUri: string, chatSessionId: string, todoCount: number): void {
		this.setExecutionState(planUri, {
			status: 'starting',
			startedAt: Date.now(),
			chatSessionId,
			todoCount,
			completedTodos: 0
		});

		// Transition to in-progress after a short delay
		setTimeout(() => {
			this.setExecutionState(planUri, {
				status: 'in-progress'
			});
		}, 100);
	}

	updateProgress(planUri: string, completedTodos: number): void {
		const currentState = this.executionStates.get(planUri);
		if (currentState) {
			this.setExecutionState(planUri, {
				completedTodos,
				status: 'in-progress'
			});
		}
	}

	completeExecution(planUri: string, success: boolean): void {
		this.setExecutionState(planUri, {
			status: success ? 'completed' : 'failed',
			completedAt: Date.now()
		});
	}
}

