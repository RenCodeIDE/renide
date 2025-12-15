/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';

/**
 * Resolves the path to the ripgrep binary, handling:
 * 1. ASAR packaging (node_modules.asar -> node_modules.asar.unpacked)
 * 2. Production DMG packaging (app.asar -> app.asar.unpacked)
 * 3. Fallback detection when standard paths fail
 */

const LOG_PREFIX = '[ripgrepPathResolver]';

/**
 * Apply ASAR unpacking transformations to a path
 */
function applyAsarTransforms(inputPath: string): string {
	let result = inputPath;
	// Handle node_modules.asar (development)
	result = result.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');
	// Handle app.asar (production DMG)
	result = result.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
	return result;
}

/**
 * Check if a file exists and is executable
 */
function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Log diagnostic information about a path
 */
function logPathDiagnostics(filePath: string): void {
	// Use forward slash for splitting, works on all platforms for path analysis
	const pathParts = filePath.split('/').filter(p => p.length > 0);
	let partialPath = '/';

	for (let i = 0; i < pathParts.length; i++) {
		partialPath = path.join(partialPath, pathParts[i]);
		try {
			const stat = fs.statSync(partialPath);
			if (!stat.isDirectory() && i < pathParts.length - 1) {
				console.error(`${LOG_PREFIX} Path component is a file, not directory: ${partialPath}`);
				return;
			}
		} catch (e: any) {
			console.error(`${LOG_PREFIX} Path component does not exist: ${partialPath} (${e.code})`);
			return;
		}
	}
}

/**
 * Get potential fallback locations for the ripgrep binary
 */
function getFallbackPaths(): string[] {
	const fallbacks: string[] = [];

	// Try to find the app path from process.execPath
	if (process.execPath) {
		const execDir = path.dirname(process.execPath);

		// macOS: /path/to/App.app/Contents/MacOS/Electron
		// -> /path/to/App.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep/bin/rg
		if (process.platform === 'darwin') {
			const contentsDir = path.dirname(execDir);
			const resourcesDir = path.join(contentsDir, 'Resources');

			fallbacks.push(
				path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
				path.join(resourcesDir, 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
				path.join(resourcesDir, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg')
			);
		}

		// Windows/Linux fallbacks
		fallbacks.push(
			path.join(execDir, 'resources', 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
			path.join(execDir, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
		);
	}

	// Try __dirname-based paths
	if (typeof __dirname !== 'undefined') {
		// Walk up from the compiled JS location to find node_modules
		let current = __dirname;
		for (let i = 0; i < 10; i++) { // Limit depth to prevent infinite loop
			const nodeModulesPath = path.join(current, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
			fallbacks.push(nodeModulesPath);

			const asarUnpackedPath = path.join(current, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
			fallbacks.push(asarUnpackedPath);

			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	return fallbacks;
}

/**
 * Resolves the ripgrep binary path with comprehensive fallback and validation.
 * This function is called once at module load time to determine the binary path.
 *
 * @returns The validated path to the ripgrep binary
 * @throws Error if ripgrep binary cannot be found
 */
function resolveRipgrepPath(): string {
	console.log(`${LOG_PREFIX} Resolving ripgrep path...`);
	console.log(`${LOG_PREFIX} Original rgPath from @vscode/ripgrep: ${rgPath}`);
	console.log(`${LOG_PREFIX} process.execPath: ${process.execPath}`);
	console.log(`${LOG_PREFIX} __dirname: ${typeof __dirname !== 'undefined' ? __dirname : 'undefined'}`);

	// Step 1: Apply ASAR transforms to the default path
	const transformedPath = applyAsarTransforms(rgPath);
	console.log(`${LOG_PREFIX} Transformed path: ${transformedPath}`);

	// Step 2: Check if the transformed path exists and is executable
	if (fs.existsSync(transformedPath)) {
		if (isExecutable(transformedPath)) {
			console.log(`${LOG_PREFIX} ✓ Ripgrep binary found and executable at: ${transformedPath}`);
			return transformedPath;
		} else {
			console.warn(`${LOG_PREFIX} ⚠ Ripgrep binary exists but is NOT executable: ${transformedPath}`);
			// Try to make it executable on Unix-like systems
			if (process.platform !== 'win32') {
				try {
					fs.chmodSync(transformedPath, 0o755);
					console.log(`${LOG_PREFIX} ✓ Made ripgrep binary executable`);
					return transformedPath;
				} catch (e) {
					console.error(`${LOG_PREFIX} Failed to make binary executable:`, e);
				}
			}
		}
	} else {
		console.error(`${LOG_PREFIX} ✗ Ripgrep binary NOT found at transformed path: ${transformedPath}`);
		logPathDiagnostics(transformedPath);
	}

	// Step 3: Try fallback paths
	console.log(`${LOG_PREFIX} Searching fallback locations...`);
	const fallbacks = getFallbackPaths();

	for (const fallbackPath of fallbacks) {
		if (fs.existsSync(fallbackPath)) {
			if (isExecutable(fallbackPath)) {
				console.log(`${LOG_PREFIX} ✓ Ripgrep binary found at fallback: ${fallbackPath}`);
				return fallbackPath;
			} else {
				console.warn(`${LOG_PREFIX} Found at fallback but not executable: ${fallbackPath}`);
				// Try to make it executable
				if (process.platform !== 'win32') {
					try {
						fs.chmodSync(fallbackPath, 0o755);
						console.log(`${LOG_PREFIX} ✓ Made fallback binary executable`);
						return fallbackPath;
					} catch (e) {
						console.error(`${LOG_PREFIX} Failed to make fallback executable:`, e);
					}
				}
			}
		}
	}

	// Step 4: Log all attempted paths for debugging
	console.error(`${LOG_PREFIX} ✗ CRITICAL: Could not find ripgrep binary!`);
	console.error(`${LOG_PREFIX} Attempted paths:`);
	console.error(`${LOG_PREFIX}   - Primary: ${transformedPath}`);
	fallbacks.forEach((p, i) => {
		console.error(`${LOG_PREFIX}   - Fallback ${i + 1}: ${p}`);
	});

	// Return the transformed path anyway - the spawn will fail with a more descriptive error
	return transformedPath;
}

/**
 * The resolved path to the ripgrep binary.
 * This is evaluated once at module load time.
 */
export const rgDiskPath: string = resolveRipgrepPath();

/**
 * Validates that the ripgrep binary can be executed.
 * Call this before spawning if you want to provide a better error message.
 *
 * @returns true if the binary exists and is executable
 */
export function validateRipgrepBinary(): boolean {
	return fs.existsSync(rgDiskPath) && isExecutable(rgDiskPath);
}

/**
 * Gets diagnostic information about the ripgrep binary resolution.
 * Useful for debugging path issues.
 */
export function getRipgrepDiagnostics(): {
	rgDiskPath: string;
	originalRgPath: string;
	exists: boolean;
	executable: boolean;
	processExecPath: string;
} {
	return {
		rgDiskPath,
		originalRgPath: rgPath,
		exists: fs.existsSync(rgDiskPath),
		executable: isExecutable(rgDiskPath),
		processExecPath: process.execPath
	};
}
