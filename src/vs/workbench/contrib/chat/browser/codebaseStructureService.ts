/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ICodebaseStructureService = createDecorator<ICodebaseStructureService>('codebaseStructureService');

export interface ICodebaseStructureService {
	readonly _serviceBrand: undefined;

	/**
	 * Get a COMPACT representation of the codebase structure
	 * suitable for inclusion in system prompts.
	 * Limited to key directories only to avoid bloating the prompt.
	 */
	getStructureSummary(): Promise<string>;

	/**
	 * Get all file names for fuzzy matching
	 */
	getAllFileNames(): Promise<string[]>;

	/**
	 * Fuzzy find a file by partial/typo'd name
	 * Returns top matches with similarity scores
	 */
	fuzzyFindFile(query: string): Promise<Array<{ path: string; score: number }>>;

	/**
	 * Invalidate cached structure (call when files change)
	 */
	invalidateCache(): void;
}

interface DirectoryInfo {
	name: string;
	path: string;
	fileCount: number;
	subdirs: string[];
}

export class CodebaseStructureService extends Disposable implements ICodebaseStructureService {
	declare readonly _serviceBrand: undefined;

	private cachedStructure: string | undefined;
	private cachedFileNames: string[] | undefined;
	private cacheExpiry: number = 0;
	private readonly CACHE_TTL_MS = 60000; // 1 minute cache

	// Key directories to always include in structure (limited for prompt size)
	private readonly KEY_DIRS = ['src', 'lib', 'app', 'components', 'utils', 'api', 'server', 'client', 'pages', 'hooks', 'services', 'models', 'types', 'config', 'tests', 'test', '__tests__'];

	// Files to highlight in structure
	private readonly KEY_FILES = ['package.json', 'tsconfig.json', 'README.md', '.env', 'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js'];

	constructor(
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async getStructureSummary(): Promise<string> {
		// Return cached if valid
		if (this.cachedStructure && Date.now() < this.cacheExpiry) {
			return this.cachedStructure;
		}

		const workspace = this.workspaceContext.getWorkspace();
		if (workspace.folders.length === 0) {
			return 'No workspace open.';
		}

		const rootUri = workspace.folders[0].uri;
		const lines: string[] = ['CODEBASE STRUCTURE (key directories):'];

		try {
			// Get top-level items
			const topLevel = await this.fileService.resolve(rootUri, { resolveMetadata: false });
			if (!topLevel.children) {
				return 'Empty workspace.';
			}

			// Collect key directories and files
			const keyDirs: DirectoryInfo[] = [];
			const rootFiles: string[] = [];

			for (const child of topLevel.children) {
				if (child.isDirectory) {
					const dirName = child.name.toLowerCase();
					// Only include key directories to keep prompt small
					if (this.KEY_DIRS.includes(dirName) || dirName.startsWith('src') || dirName.startsWith('app')) {
						const subdirs = await this.getSubdirectoryNames(child.resource, 1);
						keyDirs.push({
							name: child.name,
							path: child.name,
							fileCount: subdirs.length,
							subdirs
						});
					}
				} else {
					// Only include key root files
					if (this.KEY_FILES.includes(child.name.toLowerCase())) {
						rootFiles.push(child.name);
					}
				}
			}

			// Build compact structure (max ~500 chars to keep prompt lean)
			for (const dir of keyDirs.slice(0, 6)) { // Max 6 key directories
				lines.push(`📁 ${dir.name}/`);
				// Show max 4 subdirectories per key dir
				for (const subdir of dir.subdirs.slice(0, 4)) {
					lines.push(`  📁 ${subdir}/`);
				}
				if (dir.subdirs.length > 4) {
					lines.push(`  ... +${dir.subdirs.length - 4} more`);
				}
			}

			if (rootFiles.length > 0) {
				lines.push(`KEY FILES: ${rootFiles.slice(0, 5).join(', ')}`);
			}

		} catch (error) {
			this.logService.warn('[CodebaseStructureService] Error building structure:', error);
			return 'Could not read workspace structure.';
		}

		this.cachedStructure = lines.join('\n');
		this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

		return this.cachedStructure;
	}

	private async getSubdirectoryNames(uri: URI, maxDepth: number): Promise<string[]> {
		if (maxDepth <= 0) return [];

		try {
			const resolved = await this.fileService.resolve(uri, { resolveMetadata: false });
			if (!resolved.children) return [];

			return resolved.children
				.filter(child => child.isDirectory && !child.name.startsWith('.') && child.name !== 'node_modules')
				.map(child => child.name);
		} catch {
			return [];
		}
	}

	async getAllFileNames(): Promise<string[]> {
		// Return cached if valid
		if (this.cachedFileNames && Date.now() < this.cacheExpiry) {
			return this.cachedFileNames;
		}

		const workspace = this.workspaceContext.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}

		const fileNames: string[] = [];
		const rootUri = workspace.folders[0].uri;

		try {
			await this.collectFileNames(rootUri, fileNames, 0, 5); // Max depth 5
		} catch (error) {
			this.logService.warn('[CodebaseStructureService] Error collecting file names:', error);
		}

		this.cachedFileNames = fileNames;
		this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

		return this.cachedFileNames;
	}

	private async collectFileNames(uri: URI, fileNames: string[], depth: number, maxDepth: number): Promise<void> {
		if (depth > maxDepth || fileNames.length > 1000) return; // Limit for performance

		try {
			const resolved = await this.fileService.resolve(uri, { resolveMetadata: false });
			if (!resolved.children) return;

			for (const child of resolved.children) {
				// Skip hidden files and node_modules
				if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'dist' || child.name === 'build') {
					continue;
				}

				if (child.isDirectory) {
					await this.collectFileNames(child.resource, fileNames, depth + 1, maxDepth);
				} else {
					// Store relative path from workspace root
					const relativePath = child.resource.path.substring(this.workspaceContext.getWorkspace().folders[0].uri.path.length + 1);
					fileNames.push(relativePath);
				}
			}
		} catch {
			// Ignore errors for individual directories
		}
	}

	async fuzzyFindFile(query: string): Promise<Array<{ path: string; score: number }>> {
		const allFiles = await this.getAllFileNames();
		const normalizedQuery = query.toLowerCase();

		// Extract just the filename part for matching
		const queryBasename = normalizedQuery.split('/').pop() || normalizedQuery;

		const results = allFiles
			.map(filePath => {
				const basename = filePath.split('/').pop()?.toLowerCase() || '';

				// Exact match gets perfect score
				if (basename === queryBasename) {
					return { path: filePath, score: 1.0 };
				}

				// Calculate Levenshtein-like similarity
				const score = this.calculateSimilarity(queryBasename, basename);

				return { path: filePath, score };
			})
			.filter(result => result.score > 0.5) // Only good matches
			.sort((a, b) => b.score - a.score)
			.slice(0, 5); // Top 5

		return results;
	}

	/**
	 * Simple similarity score based on common characters and length difference
	 * (Lighter than full Levenshtein for performance)
	 */
	private calculateSimilarity(query: string, target: string): number {
		if (target.length === 0 || query.length === 0) return 0;

		// Check for substring match
		if (target.includes(query)) {
			return 0.9 - (target.length - query.length) * 0.02;
		}
		if (query.includes(target)) {
			return 0.85;
		}

		// Count common characters
		let commonChars = 0;
		const targetChars = target.split('');
		const queryChars = query.split('');

		for (const char of queryChars) {
			const idx = targetChars.indexOf(char);
			if (idx !== -1) {
				commonChars++;
				targetChars.splice(idx, 1); // Remove matched char
			}
		}

		const similarity = (commonChars * 2) / (query.length + target.length);

		// Bonus for same extension
		const queryExt = query.split('.').pop();
		const targetExt = target.split('.').pop();
		if (queryExt && targetExt && queryExt === targetExt) {
			return Math.min(1, similarity + 0.1);
		}

		return similarity;
	}

	invalidateCache(): void {
		this.cachedStructure = undefined;
		this.cachedFileNames = undefined;
		this.cacheExpiry = 0;
	}
}
