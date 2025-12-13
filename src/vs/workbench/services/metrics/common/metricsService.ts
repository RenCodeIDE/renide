/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

export const IMetricsService = createDecorator<IMetricsService>('metricsService');

export interface IProjectConfig {
	projectId: string;
	createdAt: string;
	name?: string;
}

export interface IEditEvent {
	editId: string;
	type: 'agent' | 'inline';
	sizeChars?: number;
	sizeLines?: number;
	sessionId?: string;
	projectId?: string;
}

export interface ISuggestionEvent {
	suggestionId: string;
	type: 'inline' | 'agent' | 'chat';
	sessionId?: string;
	projectId?: string;
}

export interface IFileTouchedEvent {
	filePathHash: string;
	projectId?: string;
	sessionId?: string;
}

export interface IMetricsService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when the project ID becomes available
	 */
	readonly onProjectIdReady: Event<string>;

	/**
	 * Get the current project ID for the workspace.
	 * Returns undefined if not yet initialized or no workspace is open.
	 */
	getProjectId(): string | undefined;

	/**
	 * Get the project ID, waiting for initialization if needed.
	 */
	getProjectIdAsync(): Promise<string | undefined>;

	/**
	 * Track when an edit is applied
	 */
	trackEditApplied(event: IEditEvent): Promise<void>;

	/**
	 * Track when an edit is reverted
	 */
	trackEditReverted(editId: string, type?: 'agent' | 'inline', sessionId?: string): Promise<void>;

	/**
	 * Track when a suggestion is shown
	 */
	trackSuggestionShown(event: ISuggestionEvent): Promise<void>;

	/**
	 * Track when a file is opened or modified
	 */
	trackFileTouched(event: IFileTouchedEvent): Promise<void>;

	/**
	 * Track when a feature is used
	 */
	trackFeatureUsed(feature: string): Promise<void>;

	/**
	 * Track when a project is opened
	 */
	trackProjectOpened(sessionId?: string): Promise<void>;

	/**
	 * Start a session
	 */
	startSession(sessionId: string, client?: string, platform?: string): Promise<void>;

	/**
	 * End a session
	 */
	endSession(sessionId: string): Promise<void>;
}


