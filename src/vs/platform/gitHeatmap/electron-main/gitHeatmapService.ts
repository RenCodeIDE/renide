/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import { IGitHeatmapService } from '../common/gitHeatmapService.js';
import { ILogService } from '../../log/common/log.js';

const execFileAsync = promisify(execFile);

export class GitHeatmapService implements IGitHeatmapService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	async readGitLog(cwd: string, windowDays: number): Promise<string> {
		const days = Math.max(1, Math.floor(windowDays));
		const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const sinceArg = '--since=' + sinceDate.toISOString().slice(0, 10);
		const args = [
			'log',
			sinceArg,
			'--no-merges',
			'--date-order',
			'--numstat',
			'--pretty=format:%H%x1f%ct%x1f%an%x1f%ae%x1f%s',
		];

		try {
			const { stdout } = await execFileAsync('git', args, {
				cwd,
				maxBuffer: 1024 * 1024 * 20,
			});
			return stdout ?? '';
		} catch (error) {
			this.logService.error('[GitHeatmapService] failed to execute git log', error);
			throw error;
		}
	}
}

