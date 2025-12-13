/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { hash } from '../../../../base/common/hash.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMetricsService } from '../../../services/metrics/common/metricsService.js';
import { IChatService } from '../../chat/common/chatService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Contribution that tracks user activity metrics:
 * - File touched (when editor changes)
 * - Project opened (on workspace init)
 * - Edit applied/reverted (from chat edits)
 */
export class MetricsEventContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'ren.contrib.metricsEvents';

	private _lastTrackedFilePath: string | undefined;
	private _currentSessionId: string | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IMetricsService private readonly metricsService: IMetricsService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._initializeTracking();
	}

	private _initializeTracking(): void {
		// #region agent log
		console.log('[DEBUG-METRICS] MetricsContribution _initializeTracking called');
		// #endregion
		// Track project opened on contribution init
		this._trackProjectOpened();

		// Track file touched when active editor changes
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._trackFileTouched();
		}));

		// Track when chat requests are submitted (for session tracking)
		this._register(this.chatService.onDidSubmitRequest(e => {
			this._currentSessionId = e.chatSessionId;
		}));

		this.logService.debug('[MetricsContribution] Event tracking initialized');
	}

	private async _trackProjectOpened(): Promise<void> {
		// #region agent log
		console.log('[DEBUG-METRICS] _trackProjectOpened called', { sessionId: this._currentSessionId });
		// #endregion
		try {
			await this.metricsService.trackProjectOpened(this._currentSessionId);
			this.logService.debug('[MetricsContribution] Project opened tracked');
			// #region agent log
			console.log('[DEBUG-METRICS] trackProjectOpened completed successfully');
			// #endregion
		} catch (error) {
			this.logService.warn('[MetricsContribution] Failed to track project opened:', error);
			// #region agent log
			console.log('[DEBUG-METRICS] trackProjectOpened error', { error: String(error) });
			// #endregion
		}
	}

	private async _trackFileTouched(): Promise<void> {
		// #region agent log
		console.log('[DEBUG-METRICS] _trackFileTouched called');
		// #endregion
		try {
			const activeEditor = this.editorService.activeEditor;
			if (!activeEditor) {
				// #region agent log
				console.log('[DEBUG-METRICS] _trackFileTouched: no active editor');
				// #endregion
				return;
			}

			const resource = activeEditor.resource;
			if (!resource) {
				// #region agent log
				console.log('[DEBUG-METRICS] _trackFileTouched: no resource');
				// #endregion
				return;
			}

			const filePath = resource.fsPath || resource.path;
			if (!filePath) {
				// #region agent log
				console.log('[DEBUG-METRICS] _trackFileTouched: no filePath');
				// #endregion
				return;
			}

			// Dedupe - don't track same file twice in a row
			if (this._lastTrackedFilePath === filePath) {
				// #region agent log
				console.log('[DEBUG-METRICS] _trackFileTouched: deduped same file');
				// #endregion
				return;
			}
			this._lastTrackedFilePath = filePath;

			// Hash the file path for privacy
			const filePathHash = String(hash(filePath));
			const projectId = this.metricsService.getProjectId();
			// #region agent log
			console.log('[DEBUG-METRICS] _trackFileTouched: sending', { filePathHash: filePathHash.substring(0, 8), projectId });
			// #endregion

			await this.metricsService.trackFileTouched({
				filePathHash,
				sessionId: this._currentSessionId,
				projectId,
			});

			this.logService.debug(`[MetricsContribution] File touched: ${filePathHash.substring(0, 8)}...`);
			// #region agent log
			console.log('[DEBUG-METRICS] _trackFileTouched: success');
			// #endregion
		} catch (error) {
			this.logService.warn('[MetricsContribution] Failed to track file touched:', error);
			// #region agent log
			console.log('[DEBUG-METRICS] _trackFileTouched: error', { error: String(error) });
			// #endregion
		}
	}
}

registerWorkbenchContribution2(MetricsEventContribution.ID, MetricsEventContribution, WorkbenchPhase.Eventually);

