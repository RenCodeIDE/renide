/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ISearchService, IFileQuery, QueryType, ISearchConfiguration, getExcludes } from '../../../../services/search/common/search.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';

export const ReadFileToolData: IToolData = {
	id: 'read_file',
	toolReferenceName: 'readFile',
	displayName: localize('readFileTool.displayName', 'Read File'),
	modelDescription: localize('readFileTool.modelDescription',
		`Reads file contents with fuzzy filename matching across the workspace.

USE THIS WHEN:
- You need to examine specific file contents before editing
- User mentions a file by name (even partial names work)
- You want to understand implementation details
- You need to verify current file state

PREFER OVER searchFiles WHEN: You know the filename and want full contents.
PREFER searchFiles WHEN: You're looking for specific code patterns across files.

EXAMPLES:
- "Read config file" → finds config.json, config.yaml, etc.
- "Show me utils.ts" → finds and reads utilities file
- Always read files BEFORE making edits to understand context`),
	source: ToolDataSource.Internal,
	category: 'file_operations',
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			uri: {
				type: 'string',
				description: localize('readFileTool.uri', 'The URI, file path, or filename to read. Can be a full path/URI or just a filename. If a filename is provided, the tool will search the workspace recursively with fuzzy matching.')
			},
			maxLines: {
				type: 'number',
				description: localize('readFileTool.maxLines', 'Optional: Maximum number of lines to read. If not specified, reads the entire file.')
			}
		},
		required: ['uri']
	},
	// Smart default: use active file if user doesn't specify
	resolveDefaults: (ctx) => {
		const defaults: Partial<Record<string, unknown>> = {};
		if (ctx.activeFile) {
			defaults.uri = ctx.activeFile.toString();
		}
		// If there's a visible range, suggest reading that portion for large files
		if (ctx.visibleRange) {
			defaults.startLine = ctx.visibleRange.startLine;
			defaults.endLine = ctx.visibleRange.endLine;
		}
		return defaults;
	}
};

export interface IReadFileToolInput {
	uri: string;
	maxLines?: number;
}

export class ReadFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as IReadFileToolInput;

		// For display purposes, show the input as-is if it's a filename, or the path if it's a full path
		const displayPath = this.isFullPath(args.uri)
			? this.parseUri(args.uri).fsPath
			: args.uri;

		return {
			invocationMessage: localize('readFileTool.invocationMessage', 'Reading file: {0}', displayPath),
			pastTenseMessage: localize('readFileTool.pastTenseMessage', 'Read file: {0}', displayPath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IReadFileToolInput;

		try {
			// Check if input is a full path/URI or just a filename
			if (this.isFullPath(args.uri)) {
				// Full path/URI - use existing logic
				const uri = this.parseUri(args.uri);
				return await this.readFileByUri(uri, args.maxLines, token);
			} else {
				// Filename - search workspace for matches
				const matches = await this.searchFilesByName(args.uri, token);

				if (matches.length === 0) {
					return {
						content: [{
							kind: 'text',
							value: localize('readFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
						}],
						toolResultMessage: localize('readFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
					};
				} else if (matches.length === 1) {
					// Single match - read it directly
					return await this.readFileByUri(matches[0], args.maxLines, token);
				} else {
					// Multiple matches - return list for model to choose
					const workspace = this.workspaceService.getWorkspace();
					const matchList = matches.map((uri, index) => {
						const relativePath = workspace.folders.length > 0
							? this.getRelativePath(uri, workspace.folders[0].uri)
							: uri.fsPath;
						return `${index + 1}. ${relativePath}`;
					}).join('\n');

					const fullMessage = localize('readFileTool.multipleMatches', 'Found {0} files matching "{1}":\n\n{2}\n\nPlease specify which file to read by providing the full path or a more specific filename.', matches.length, args.uri, matchList);
					return {
						content: [{
							kind: 'text',
							value: fullMessage
						}],
						toolResultMessage: localize('readFileTool.multipleMatchesShort', 'Found {0} files matching "{1}". Please specify which file to read.', matches.length, args.uri)
					};
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('readFileTool.error', 'Error reading file {0}: {1}', args.uri, errorMessage)
				}],
				toolResultMessage: localize('readFileTool.error', 'Error reading file {0}: {1}', args.uri, errorMessage)
			};
		}
	}

	private async readFileByUri(uri: URI, maxLines: number | undefined, token: CancellationToken): Promise<IToolResult> {
		// Check if file exists
		const exists = await this.fileService.exists(uri);
		if (!exists) {
			return {
				content: [{
					kind: 'text',
					value: localize('readFileTool.fileNotFound', 'File not found: {0}', uri.fsPath)
				}],
				toolResultMessage: localize('readFileTool.fileNotFound', 'File not found: {0}', uri.fsPath)
			};
		}

		// Read file content
		const fileContent = await this.fileService.readFile(uri, undefined, token);
		let content = fileContent.value.toString();

		// Apply maxLines limit if specified
		if (maxLines && maxLines > 0) {
			const lines = content.split(/\r?\n/);
			if (lines.length > maxLines) {
				content = lines.slice(0, maxLines).join('\n');
				content += `\n... (${lines.length - maxLines} more lines)`;
			}
		}

		return {
			content: [{
				kind: 'text',
				value: content
			}],
			toolResultMessage: localize('readFileTool.success', 'Read {0} characters from {1}', content.length, uri.fsPath)
		};
	}

	private isFullPath(uriString: string): boolean {
		// Check if it's a URI
		if (uriString.includes('://') || uriString.startsWith('file://')) {
			return true;
		}

		// Check if it's an absolute path
		if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
			return true;
		}

		// Check if it contains path separators (likely a relative path, not just a filename)
		if (uriString.includes('/') || (isWindows && uriString.includes('\\'))) {
			return true;
		}

		// Otherwise, treat as a filename
		return false;
	}

	private parseUri(uriString: string): URI {
		try {
			// Try parsing as URI first
			if (uriString.includes('://') || uriString.startsWith('file://')) {
				return URI.parse(uriString);
			}

			// If it's a relative path, try to resolve it relative to workspace
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri;
				// Check if it's already an absolute path
				if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
					return URI.file(uriString);
				}
				// Relative path - resolve against workspace root
				return URI.joinPath(workspaceRoot, uriString);
			}

			// Fallback to file URI
			return URI.file(uriString);
		} catch {
			// If parsing fails, treat as file path
			return URI.file(uriString);
		}
	}

	private fuzzyMatchingGlobPattern(pattern: string): string {
		if (!pattern) {
			return '*';
		}
		return '*' + pattern.split('').join('*') + '*';
	}

	private caseInsensitiveGlobPattern(pattern: string): string {
		let caseInsensitiveFilePattern = '';
		for (let i = 0; i < pattern.length; i++) {
			const char = pattern[i];
			if (/[a-zA-Z]/.test(char)) {
				caseInsensitiveFilePattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
			} else {
				caseInsensitiveFilePattern += char;
			}
		}
		return caseInsensitiveFilePattern;
	}

	private async searchFilesByName(pattern: string, token: CancellationToken): Promise<URI[]> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}

		// Create fuzzy matching pattern
		const fuzzyPattern = this.fuzzyMatchingGlobPattern(pattern);
		const caseInsensitivePattern = this.caseInsensitiveGlobPattern(fuzzyPattern);

		// Search across all workspace folders
		const allMatches: URI[] = [];
		const maxResults = 50; // Limit to avoid performance issues

		for (const folder of workspace.folders) {
			const searchExcludePattern = getExcludes(this.configurationService.getValue<ISearchConfiguration>({ resource: folder.uri })) || {};
			const disregardIgnoreFiles = this.configurationService.getValue<boolean>('explorer.excludeGitIgnore');

			const searchOptions: IFileQuery = {
				folderQueries: [{
					folder: folder.uri,
					disregardIgnoreFiles,
				}],
				type: QueryType.File,
				shouldGlobMatchFilePattern: true,
				excludePattern: searchExcludePattern,
				sortByScore: true,
				maxResults,
				filePattern: `**/${caseInsensitivePattern}`
			};

			try {
				const searchResult = await this.searchService.fileSearch(searchOptions, token);
				if (token.isCancellationRequested) {
					break;
				}

				const fileResources = searchResult.results.map(result => result.resource);
				allMatches.push(...fileResources);

				// Stop if we've reached the limit
				if (allMatches.length >= maxResults) {
					break;
				}
			} catch (e) {
				// Continue with other folders if one fails
				if (token.isCancellationRequested) {
					break;
				}
			}
		}

		// Remove duplicates and limit results
		const uniqueMatches = Array.from(new Set(allMatches.map(uri => uri.toString())))
			.map(uriString => URI.parse(uriString))
			.slice(0, maxResults);

		return uniqueMatches;
	}

	private getRelativePath(uri: URI, workspaceRoot: URI): string {
		const relative = uri.toString().substring(workspaceRoot.toString().length);
		return relative.startsWith('/') ? relative.substring(1) : relative;
	}
}

