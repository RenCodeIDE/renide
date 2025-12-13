/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	IMetricsService,
	IProjectConfig,
	IEditEvent,
	ISuggestionEvent,
	IFileTouchedEvent
} from '../common/metricsService.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { mainWindow } from '../../../../base/browser/window.js';

const PROJECT_CONFIG_FOLDER = '.ren-ide';
const PROJECT_CONFIG_FILE = 'project.json';

export class MetricsService extends Disposable implements IMetricsService {
	declare readonly _serviceBrand: undefined;

	private _projectId: string | undefined;
	private _projectIdPromise: Promise<string | undefined> | undefined;
	private _serverAddress: string | undefined;

	private readonly _onProjectIdReady = this._register(new Emitter<string>());
	readonly onProjectIdReady: Event<string> = this._onProjectIdReady.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		// #region agent log
		console.log('[DEBUG-METRICS] MetricsService constructor called');
		// #endregion

		// Get server address from configuration, with dev mode detection
		const configuredAddress = this.configurationService.getValue<string>('renide.server.address');
		// #region agent log
		console.log('[DEBUG-METRICS] Location info', {
			hostname: mainWindow.location.hostname,
			protocol: mainWindow.location.protocol,
			href: mainWindow.location.href,
			pathname: mainWindow.location.pathname
		});
		// #endregion
		const isDevMode = mainWindow.location.hostname === 'localhost' ||
			mainWindow.location.hostname === '127.0.0.1' ||
			mainWindow.location.protocol === 'file:' ||
			mainWindow.location.href.includes('workbench-dev.html');
		const defaultAddress = isDevMode ? 'http://localhost:8787' : 'https://ren-server.rahilmittal-1.workers.dev';
		this._serverAddress = configuredAddress || defaultAddress;
		// #region agent log
		console.log('[DEBUG-METRICS] Server address configured', { serverAddress: this._serverAddress, isDevMode, configuredAddress });
		// #endregion

		// Initialize project ID when workspace opens
		this._initializeProjectId();

		// Re-initialize when workspace changes
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._projectId = undefined;
			this._projectIdPromise = undefined;
			this._initializeProjectId();
		}));
	}

	private async _initializeProjectId(): Promise<void> {
		if (this._projectIdPromise) {
			return;
		}

		this._projectIdPromise = this._loadOrCreateProjectConfig();
		const projectId = await this._projectIdPromise;
		if (projectId) {
			this._projectId = projectId;
			this._onProjectIdReady.fire(projectId);
			this.logService.info(`[MetricsService] Project ID initialized: ${projectId.substring(0, 8)}...`);
		}
	}

	private async _loadOrCreateProjectConfig(): Promise<string | undefined> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			this.logService.debug('[MetricsService] No workspace folder, skipping project config');
			return undefined;
		}

		// Use the first workspace folder
		const workspaceFolder = workspaceFolders[0].uri;
		const configFolderUri = URI.joinPath(workspaceFolder, PROJECT_CONFIG_FOLDER);
		const configFileUri = URI.joinPath(configFolderUri, PROJECT_CONFIG_FILE);

		try {
			// Try to read existing config
			const content = await this.fileService.readFile(configFileUri);
			const config: IProjectConfig = JSON.parse(content.value.toString());

			if (config.projectId) {
				this.logService.debug(`[MetricsService] Loaded existing project ID: ${config.projectId.substring(0, 8)}...`);
				return config.projectId;
			}
		} catch {
			// File doesn't exist, create new config
		}

		// Generate new project ID
		const newProjectId = generateUuid();
		const config: IProjectConfig = {
			projectId: newProjectId,
			createdAt: new Date().toISOString()
		};

		try {
			// Ensure config folder exists
			await this.fileService.createFolder(configFolderUri);

			// Write config file
			await this.fileService.writeFile(
				configFileUri,
				VSBuffer.fromString(JSON.stringify(config, null, 2))
			);

			this.logService.info(`[MetricsService] Created new project config with ID: ${newProjectId.substring(0, 8)}...`);
			return newProjectId;
		} catch (error) {
			this.logService.error('[MetricsService] Failed to create project config:', error);
			return undefined;
		}
	}

	getProjectId(): string | undefined {
		return this._projectId;
	}

	async getProjectIdAsync(): Promise<string | undefined> {
		if (this._projectId) {
			return this._projectId;
		}
		if (this._projectIdPromise) {
			return this._projectIdPromise;
		}
		return undefined;
	}

	private async _sendMetricsRequest(endpoint: string, data: unknown): Promise<void> {
		// #region agent log
		console.log('[DEBUG-METRICS] _sendMetricsRequest called', { endpoint, dataKeys: Object.keys(data as object), serverAddress: this._serverAddress, projectId: this._projectId });
		// #endregion
		const accessToken = await this.secretStorageService.get('ren.auth.accessToken');
		// #region agent log
		console.log('[DEBUG-METRICS] Token check', { hasToken: !!accessToken, tokenLength: accessToken?.length });
		// #endregion
		if (!accessToken) {
			this.logService.debug('[MetricsService] No access token, skipping metrics request');
			// #region agent log
			console.log('[DEBUG-METRICS] SKIPPED - no access token', { endpoint });
			// #endregion
			return;
		}

		if (!this._serverAddress) {
			this.logService.debug('[MetricsService] No server address configured');
			// #region agent log
			console.log('[DEBUG-METRICS] SKIPPED - no server address', { endpoint });
			// #endregion
			return;
		}

		try {
			// #region agent log
			console.log('[DEBUG-METRICS] About to fetch', { url: `${this._serverAddress}${endpoint}`, body: data });
			// #endregion
			const response = await fetch(`${this._serverAddress}${endpoint}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${accessToken}`,
					'x-project-id': this._projectId || ''
				},
				body: JSON.stringify(data)
			});

			// #region agent log
			console.log('[DEBUG-METRICS] Got response', { endpoint, status: response.status, ok: response.ok });
			// #endregion
			if (!response.ok) {
				const errorText = await response.text();
				this.logService.warn(`[MetricsService] Request to ${endpoint} failed: ${response.status} - ${errorText}`);
				// #region agent log
				console.log('[DEBUG-METRICS] Request failed', { endpoint, status: response.status, errorText });
				// #endregion
			}
		} catch (error) {
			this.logService.warn(`[MetricsService] Failed to send metrics to ${endpoint}:`, error);
			// #region agent log
			console.log('[DEBUG-METRICS] Fetch threw error', { endpoint, error: String(error) });
			// #endregion
		}
	}

	async trackEditApplied(event: IEditEvent): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/edit-applied', {
			editId: event.editId,
			type: event.type,
			sizeChars: event.sizeChars,
			sizeLines: event.sizeLines,
			sessionId: event.sessionId,
			projectId: event.projectId || this._projectId
		});
	}

	async trackEditReverted(editId: string, type?: 'agent' | 'inline', sessionId?: string): Promise<void> {
		const projectId = await this.getProjectIdAsync();
		await this._sendMetricsRequest('/api/metrics/edit-reverted', {
			editId,
			type,
			sessionId,
			projectId
		});
	}

	async trackSuggestionShown(event: ISuggestionEvent): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/suggestion-shown', {
			suggestionId: event.suggestionId,
			type: event.type,
			sessionId: event.sessionId,
			projectId: event.projectId || this._projectId
		});
	}

	async trackFileTouched(event: IFileTouchedEvent): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/file-touched', {
			filePathHash: event.filePathHash,
			projectId: event.projectId || this._projectId,
			sessionId: event.sessionId
		});
	}

	async trackFeatureUsed(feature: string): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/feature-used', {
			feature
		});
	}

	async trackProjectOpened(sessionId?: string): Promise<void> {
		// #region agent log
		console.log('[DEBUG-METRICS] trackProjectOpened called', { sessionId });
		// #endregion
		const projectId = await this.getProjectIdAsync();
		// #region agent log
		console.log('[DEBUG-METRICS] trackProjectOpened projectId', { projectId, hasProjectId: !!projectId });
		// #endregion
		if (!projectId) {
			// #region agent log
			console.log('[DEBUG-METRICS] trackProjectOpened SKIPPED - no projectId');
			// #endregion
			return;
		}

		await this._sendMetricsRequest('/api/metrics/project-opened', {
			projectId,
			sessionId
		});
	}

	async startSession(sessionId: string, client?: string, platform?: string): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/session/start', {
			sessionId,
			client,
			platform,
			projectId: this._projectId
		});
	}

	async endSession(sessionId: string): Promise<void> {
		await this._sendMetricsRequest('/api/metrics/session/end', {
			sessionId
		});
	}
}

registerSingleton(IMetricsService, MetricsService, InstantiationType.Delayed);

