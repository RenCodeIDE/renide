/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Browser-safe facade for GitIgnoreFilter. In bundled production builds,
 *  we use a no-op implementation since the `ignore` npm package cannot be
 *  dynamically loaded in the Electron renderer's ES module context.
 *  The gitignore filtering is still handled properly by the file service layer.
 *--------------------------------------------------------------------------------------------*/

class BrowserGitIgnoreFilter {
	constructor(readonly workspacePath: string, readonly _logService: unknown) {}

	async initialize(): Promise<void> {
		return;
	}

	shouldIgnore(_relativePath: string, _isDirectory: boolean): boolean {
		// In browser/bundled builds, we don't filter based on .gitignore here.
		// The file service layer handles gitignore filtering at a lower level.
		return false;
	}
}

export const GitIgnoreFilter = BrowserGitIgnoreFilter;
