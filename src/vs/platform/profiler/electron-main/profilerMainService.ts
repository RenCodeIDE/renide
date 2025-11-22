/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IProfilerService, ProfileRun, Hotspot, ProfilerIpcChannels } from '../../profiler/common/profiler.js';
import { Client } from '../../../base/parts/ipc/node/ipc.cp.js';
import { FileAccess } from '../../../base/common/network.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';

export class ProfilerMainService extends Disposable implements IProfilerService {
	declare readonly _serviceBrand: undefined;

	private readonly profilerService: IProfilerService;

	constructor(
		@IEnvironmentMainService private readonly environmentService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		const modulePath = FileAccess.asFileUri('bootstrap-fork.js').fsPath;
		const args = ['--type=profilerService'];

		const env = {
			VSCODE_PROFILER_STORAGE_HOME: this.environmentService.workspaceStorageHome.fsPath,
			VSCODE_ESM_ENTRYPOINT: 'vs/platform/profiler/node/profilerServiceMain'
		};

		const client = this._register(new Client(modulePath, {
			serverName: 'Profiler Service',
			args,
			env
		}));

		const channel = client.getChannel(ProfilerIpcChannels.Profiler);
		this.profilerService = ProxyChannel.toService<IProfilerService>(channel);

		this._register(client.onDidProcessExit(code => {
			this.logService.info(`Profiler service exited with code: ${code.code}, signal: ${code.signal}`);
		}));
	}

	async runProfile(command: string, cwd: string, workspaceId: string): Promise<ProfileRun> {
		return this.profilerService.runProfile(command, cwd, workspaceId);
	}

	async getProfileRuns(workspaceId: string): Promise<ProfileRun[]> {
		return this.profilerService.getProfileRuns(workspaceId);
	}

	async getHotspots(workspaceId: string, runId: string): Promise<Hotspot[]> {
		return this.profilerService.getHotspots(workspaceId, runId);
	}
}


