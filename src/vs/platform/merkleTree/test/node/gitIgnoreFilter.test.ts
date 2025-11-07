/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { FileAccess } from '../../../../base/common/network.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { GitIgnoreFilter } from '../../node/gitIgnoreFilter.js';

suite('GitIgnoreFilter', () => {
	const fixturesRoot = FileAccess.asFileUri('vs/platform/merkleTree/test/node/fixtures/gitignore/basic').fsPath;
	const logService = new NullLogService();

	test('respects root gitignore patterns', async () => {
		const filter = new GitIgnoreFilter(fixturesRoot, logService);
		await filter.initialize();

		assert.strictEqual(filter.shouldIgnore('dist', true), true, 'dist directory should be ignored');
		assert.strictEqual(filter.shouldIgnore('dist/index.js', false), true, 'files under dist should be ignored');
		assert.strictEqual(filter.shouldIgnore('logs/error.log', false), true, '*.log pattern should be ignored');
		assert.strictEqual(filter.shouldIgnore('src/app.ts', false), false, 'src/app.ts should not be ignored');
	});

	test('applies repository exclude rules and static directories', async () => {
		const filter = new GitIgnoreFilter(fixturesRoot, logService);
		await filter.initialize();

		assert.strictEqual(filter.shouldIgnore('cache/data.json', false), true, '.git/info/exclude should be respected');
		assert.strictEqual(filter.shouldIgnore('node_modules/library/index.js', false), true, 'node_modules should always be ignored');
	});

	test('ignores dot ignore files explicitly', async () => {
		const filter = new GitIgnoreFilter(fixturesRoot, logService);
		await filter.initialize();

		assert.strictEqual(filter.shouldIgnore('.gitignore', false), true, '.gitignore file should be ignored');
		assert.strictEqual(filter.shouldIgnore('config/.gitignore', false), true, 'nested .gitignore files should be ignored');
	});
});

