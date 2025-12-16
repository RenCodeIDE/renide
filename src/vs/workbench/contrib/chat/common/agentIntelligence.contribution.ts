/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { DependencyGraphService, IDependencyGraphService } from './dependencyGraphService.js';
import { AgentPlanner, IAgentPlanner } from './agentPlanner.js';
import { IPlanTodoSyncService, PlanTodoSyncService } from './planTodoSyncService.js';

// Register dependency graph service
registerSingleton(IDependencyGraphService, DependencyGraphService, InstantiationType.Delayed);

// Register agent planner service
registerSingleton(IAgentPlanner, AgentPlanner, InstantiationType.Delayed);

// Register plan-todo sync service
registerSingleton(IPlanTodoSyncService, PlanTodoSyncService, InstantiationType.Delayed);
