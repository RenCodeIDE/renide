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

	async filterIgnoredPaths(cwd: string, paths: string[]): Promise<string[]> {
		const ignored = new Set<string>();
		if (!paths.length) {
			return [];
		}
		const normalized = paths
			.map(path => path.replace(/\\/g, '/').trim())
			.filter(path => path.length > 0);
		const chunkSize = 200;
		for (let offset = 0; offset < normalized.length; offset += chunkSize) {
			const chunk = normalized.slice(offset, offset + chunkSize);
			await new Promise<void>((resolve, reject) => {
				if (!chunk.length) {
					resolve();
					return;
				}
				const child = execFile('git', ['check-ignore', '--stdin'], { cwd }, (error, stdout) => {
					const exitCodeRaw = (error as NodeJS.ErrnoException | undefined)?.code;
					const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : typeof exitCodeRaw === 'string' ? Number(exitCodeRaw) : undefined;
					if (error && exitCode !== 1) {
						this.logService.error('[GitHeatmapService] git check-ignore failed', error);
						reject(error);
						return;
					}
					if (stdout) {
						for (const line of stdout.split(/\r?\n/)) {
							if (line.trim().length) {
								ignored.add(line.trim().replace(/\\/g, '/'));
							}
						}
					}
					resolve();
				});
				if (child.stdin) {
					child.stdin.write(chunk.join('\n'));
					child.stdin.end('\n');
				}
			});
		}
		return Array.from(ignored);
	}
}

