/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const GRAPH_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] as const;

export const GRAPH_INDEX_FILENAMES = GRAPH_FILE_EXTENSIONS.map(ext => `index${ext}`);

export const GRAPH_DEFAULT_EXCLUDE_GLOBS: Readonly<Record<string, boolean>> = Object.freeze({
	'**/node_modules/**': true,
	'**/node_modules/react/**': true,
	'**/node_modules/react-dom/**': true,
	'**/node_modules/react-native/**': true,
	'**/node_modules/@types/react/**': true,
	'**/node_modules/@types/react-dom/**': true,
	'**/.git/**': true,
	'**/.hg/**': true,
	'**/dist/**': true,
	'**/build/**': true,
	'**/out/**': true,
	'**/.next/**': true,
	'**/.turbo/**': true,
	'**/.vercel/**': true,
	'**/coverage/**': true,
	'**/tmp/**': true,
	'**/.cache/**': true
});

export const GRAPH_EXCLUDED_PATH_SEGMENTS = new Set([
	'node_modules',
	'.git',
	'.hg',
	'dist',
	'build',
	'out',
	'.next',
	'.turbo',
	'.vercel',
	'coverage',
	'tmp',
	'.cache'
]);

export const GRAPH_EXCLUDED_LEAF_NAMES = new Set([
	'react.js',
	'react.ts',
	'react.jsx',
	'react.tsx',
	'react.production.min.js',
	'react-dom.js',
	'react-dom.ts',
	'react-dom.jsx',
	'react-dom.tsx',
	'react-dom.production.min.js'
]);

export const GRAPH_IGNORED_IMPORT_SPECIFIERS = new Set([
	'react',
	'react-dom',
	'react-router',
	'react-router-dom',
	'react-router-native',
	'react-router-config',
	'recoil',
	'redux',
	'@reduxjs/toolkit',
	'@types/react',
	'@types/react-dom'
]);

export function isExcludedPath(path: string): boolean {
	const segments = path.split(/[\\/]+/);
	return segments.some(segment => GRAPH_EXCLUDED_PATH_SEGMENTS.has(segment));
}

export function toCytoscapeId(value: string): string {
	return encodeURIComponent(value).replace(/%/g, '_');
}

export function getImportBase(specifier: string): string {
	if (!specifier) {
		return specifier;
	}
	const trimmed = specifier.trim();
	if (trimmed.startsWith('@')) {
		const [scope, name] = trimmed.split('/', 3);
		return name ? `${scope}/${name}`.toLowerCase() : trimmed.toLowerCase();
	}
	const [base] = trimmed.split('/', 2);
	return (base ?? trimmed).toLowerCase();
}
