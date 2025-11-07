/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignoreModule from 'ignore';
import type { Ignore, Options } from 'ignore';
import { ILogService } from '../../log/common/log.js';

const resolveIgnoreFactory = (): ((options?: Options) => Ignore) => {
	const mod = ignoreModule as unknown as { default?: (options?: Options) => Ignore };
	if (typeof ignoreModule === 'function') {
		return ignoreModule as unknown as (options?: Options) => Ignore;
	}
	if (typeof mod.default === 'function') {
		return mod.default;
	}
	throw new Error('Failed to resolve ignore factory');
};

const createIgnore = resolveIgnoreFactory();

async function fileExists(candidate: string): Promise<boolean> {
	try {
		await fs.access(candidate);
		return true;
	} catch {
		return false;
	}
}

async function readFileIfExists(candidate: string): Promise<string | undefined> {
	if (!(await fileExists(candidate))) {
		return undefined;
	}

	try {
		return await fs.readFile(candidate, 'utf8');
	} catch {
		return undefined;
	}
}

async function resolveGlobalGitIgnorePath(repoRoot: string, logService: ILogService): Promise<string | undefined> {
	try {
		const { exec } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execAsync = promisify(exec);
		const { stdout } = await execAsync('git config --get core.excludesFile', {
			cwd: repoRoot,
			windowsHide: true,
		});
		const candidate = stdout.trim();
		if (candidate) {
			return candidate;
		}
	} catch (error) {
		logService.debug(`[MerkleTree] No global git excludes found: ${error}`);
	}
	return undefined;
}

export class GitIgnoreFilter {
	private readonly matcher: Ignore;
	private isLoaded = false;

	constructor(
		private readonly workspacePath: string,
		private readonly logService: ILogService
	) {
		this.matcher = createIgnore();
	}

	async initialize(): Promise<void> {
		const patterns: string[] = [];

		const rootGitIgnore = path.join(this.workspacePath, '.gitignore');
		const repoExclude = path.join(this.workspacePath, '.git', 'info', 'exclude');

		const rootContents = await readFileIfExists(rootGitIgnore);
		if (rootContents) {
			patterns.push(rootContents);
		}

		const repoExcludeContents = await readFileIfExists(repoExclude);
		if (repoExcludeContents) {
			patterns.push(repoExcludeContents);
		}

		const globalExcludePath = await resolveGlobalGitIgnorePath(this.workspacePath, this.logService);
		if (globalExcludePath) {
			const globalContents = await readFileIfExists(globalExcludePath);
			if (globalContents) {
				patterns.push(globalContents);
			}
		}

		if (patterns.length > 0) {
			this.matcher.add(patterns.join('\n'));
		}

		this.isLoaded = true;
		this.logService.debug('[MerkleTree] Git ignore patterns loaded');
	}

	shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
		if (!this.isLoaded) {
			return false;
		}

		if (!relativePath) {
			return false;
		}

		const normalized = relativePath.split(path.sep).join('/');
		const candidate = isDirectory ? `${normalized}/` : normalized;
		return this.matcher.ignores(candidate);
	}
}


