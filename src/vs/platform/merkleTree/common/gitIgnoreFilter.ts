/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Browser-safe facade that lazily loads the Node implementation when running
 *  in a Node/Electron context. This avoids bundling heavy dependencies such as
 *  the `ignore` package into renderer builds while still exposing a consistent
 *  API to shared code.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line @typescript-eslint/ban-types
declare const require: Function | undefined;
declare const process: { versions?: { node?: string } } | undefined;

class BrowserGitIgnoreFilter {
	constructor(
		readonly workspacePath: string,
		readonly _logService: unknown
	) {}

	async initialize(): Promise<void> {
		return;
	}

	shouldIgnore(_relativePath: string, _isDirectory: boolean): boolean {
		return false;
	}
}

type GitIgnoreFilterCtor = new (workspacePath: string, logService: unknown) => {
	initialize(): Promise<void>;
	shouldIgnore(relativePath: string, isDirectory: boolean): boolean;
};

let GitIgnoreFilterImpl: GitIgnoreFilterCtor = BrowserGitIgnoreFilter;

// Only attempt to load the Node implementation when running in an environment
// where `process.versions.node` and a CommonJS `require` are available.
const isNodeProcess = typeof process !== 'undefined' && !!process?.versions?.node;
if (isNodeProcess && typeof require === 'function') {
	try {
		const nodeModule = require('../node/gitIgnoreFilter.js') as { GitIgnoreFilter: GitIgnoreFilterCtor };
		if (nodeModule?.GitIgnoreFilter) {
			GitIgnoreFilterImpl = nodeModule.GitIgnoreFilter;
		}
	} catch (error) {
		// Fallback to the browser implementation; logging is deferred to the
		// caller's provided log service to avoid requiring it here.
		console.warn('[MerkleTree] Failed to load node GitIgnoreFilter implementation:', error);
	}
}

export const GitIgnoreFilter = GitIgnoreFilterImpl;

