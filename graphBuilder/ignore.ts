/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import fg from 'fast-glob';
import { execSync } from 'child_process';

/**
 * Collect all files that match .gitignore and related exclude files.
 * @param repoRoot Absolute path to the git repository root
 * @param returnIgnored If true, return ignored files; otherwise, return kept files.
 */
export async function collectGitIgnoredFiles(
	repoRoot: string,
	returnIgnored = true
): Promise<string[]> {
	const ig = ignore();

	// Helper to safely add ignore rules
	const addIfExists = (p: string) => {
		if (fs.existsSync(p)) {
			const data = fs.readFileSync(p, 'utf8');
			ig.add(data);
		}
	};

	// .gitignore
	addIfExists(path.join(repoRoot, '.gitignore'));

	// .git/info/exclude
	addIfExists(path.join(repoRoot, '.git', 'info', 'exclude'));

	// global excludes file from git config
	try {
		const globalPath = execSync('git config --get core.excludesFile', {
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.toString()
			.trim();
		if (globalPath && fs.existsSync(globalPath)) {
			ig.add(fs.readFileSync(globalPath, 'utf8'));
		}
	} catch {
		// ignore if command fails (not configured)
	}

	// Hardcoded vendor dirs (optional)
	ig.add([
		'node_modules/',
		'.venv/',
		'venv/',
		'dist/',
		'build/',
		'target/',
		'.next/',
		'.turbo/',
		'.cache/',
	]);

	// Get all files recursively (no dirs)
	const allFiles = await fg(['**/*'], {
		cwd: repoRoot,
		dot: true, // include dotfiles (so ignore rules apply to them)
		onlyFiles: true,
		absolute: true,
		followSymbolicLinks: false,
	});

	// Apply ignore filter
	const filtered = allFiles.filter((absPath) => {
		const rel = path.relative(repoRoot, absPath);
		const isIgnored = ig.ignores(rel);
		return returnIgnored ? isIgnored : !isIgnored;
	});

	return filtered;
}

