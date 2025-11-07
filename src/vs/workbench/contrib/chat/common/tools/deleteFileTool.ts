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
import { IMerkleTreeService } from '../../../../../platform/merkleTree/common/merkleTreeService.js';
import { ISearchService, IFileQuery, QueryType, ISearchConfiguration, getExcludes } from '../../../../services/search/common/search.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';

export const DeleteFileToolData: IToolData = {
	id: 'delete_file',
	toolReferenceName: 'deleteFile',
	displayName: localize('deleteFileTool.displayName', 'Delete File'),
	modelDescription: localize('deleteFileTool.modelDescription', 'Deletes a file or directory. Supports both full paths/URIs and filenames. When given a filename, searches recursively across the entire workspace with fuzzy matching (e.g., "config" will find "config.json", "config.yaml", etc.). If multiple matches are found, returns a list for you to specify which one to delete.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			uri: {
				type: 'string',
				description: localize('deleteFileTool.uri', 'The URI, file path, or filename to delete. Can be a full path/URI or just a filename. If a filename is provided, the tool will search the workspace recursively with fuzzy matching.')
			},
			recursive: {
				type: 'boolean',
				description: localize('deleteFileTool.recursive', 'Optional: Whether to recursively delete directories. Defaults to false.')
			}
		},
		required: ['uri']
	}
};

export interface IDeleteFileToolInput {
	uri: string;
	recursive?: boolean;
}

export class DeleteFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@ILogService private readonly logService: ILogService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as IDeleteFileToolInput;

		const displayPath = this.isFullPath(args.uri)
			? this.parseUri(args.uri).fsPath
			: args.uri;

		return {
			invocationMessage: localize('deleteFileTool.invocationMessage', 'Deleting: {0}', displayPath),
			pastTenseMessage: localize('deleteFileTool.pastTenseMessage', 'Deleted: {0}', displayPath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IDeleteFileToolInput;

		try {
			// Check if input is a full path/URI or just a filename
			if (this.isFullPath(args.uri)) {
				// Full path/URI - use existing logic
				const uri = this.parseUri(args.uri);
				return await this.deleteFileByUri(uri, args.recursive ?? false);
			} else {
				// Filename - search workspace for matches
				const matches = await this.searchFilesByName(args.uri, token);

				if (matches.length === 0) {
					return {
						content: [{
							kind: 'text',
							value: localize('deleteFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
						}],
						toolResultMessage: localize('deleteFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
					};
				} else if (matches.length === 1) {
					// Single match - delete it directly
					return await this.deleteFileByUri(matches[0], args.recursive ?? false);
				} else {
					// Multiple matches - return list for model to choose
					const workspace = this.workspaceService.getWorkspace();
					const matchList = matches.map((uri, index) => {
						const relativePath = workspace.folders.length > 0
							? this.getRelativePath(uri, workspace.folders[0].uri)
							: uri.fsPath;
						return `${index + 1}. ${relativePath}`;
					}).join('\n');

					const fullMessage = localize('deleteFileTool.multipleMatches', 'Found {0} files matching "{1}":\n\n{2}\n\nPlease specify which file to delete by providing the full path or a more specific filename.', matches.length, args.uri, matchList);
					return {
						content: [{
							kind: 'text',
							value: fullMessage
						}],
						toolResultMessage: localize('deleteFileTool.multipleMatchesShort', 'Found {0} files matching "{1}". Please specify which file to delete.', matches.length, args.uri)
					};
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('deleteFileTool.error', 'Error deleting file or directory {0}: {1}', args.uri, errorMessage)
				}],
				toolResultMessage: localize('deleteFileTool.error', 'Error deleting file or directory {0}: {1}', args.uri, errorMessage)
			};
		}
	}

	private async deleteFileByUri(uri: URI, recursive: boolean): Promise<IToolResult> {
		// Check if file/directory exists
		const exists = await this.fileService.exists(uri);
		if (!exists) {
			return {
				content: [{
					kind: 'text',
					value: localize('deleteFileTool.notFound', 'File or directory not found: {0}', uri.fsPath)
				}],
				toolResultMessage: localize('deleteFileTool.notFound', 'File or directory not found: {0}', uri.fsPath)
			};
		}

		// Delete the file or directory
		await this.fileService.del(uri, { recursive, useTrash: false });

		// CRITICAL: Invalidate merkle tree path (ensures immediate update)
		try {
			await this.merkleTreeService.invalidatePath(uri);
			this.logService.debug(`[DeleteFileTool] Invalidated merkle tree path: ${uri.fsPath}`);
		} catch (error) {
			this.logService.warn(`[DeleteFileTool] Failed to invalidate merkle tree path: ${error}`);
		}

		return {
			content: [{
				kind: 'text',
				value: localize('deleteFileTool.success', 'File or directory deleted successfully: {0}', uri.fsPath)
			}],
			toolResultMessage: localize('deleteFileTool.success', 'File or directory deleted successfully: {0}', uri.fsPath)
		};
	}

	private isFullPath(uriString: string): boolean {
		if (uriString.includes('://') || uriString.startsWith('file://')) {
			return true;
		}
		if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
			return true;
		}
		if (uriString.includes('/') || (isWindows && uriString.includes('\\'))) {
			return true;
		}
		return false;
	}

	private parseUri(uriString: string): URI {
		try {
			if (uriString.includes('://') || uriString.startsWith('file://')) {
				return URI.parse(uriString);
			}
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri;
				if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
					return URI.file(uriString);
				}
				return URI.joinPath(workspaceRoot, uriString);
			}
			return URI.file(uriString);
		} catch {
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

		const fuzzyPattern = this.fuzzyMatchingGlobPattern(pattern);
		const caseInsensitivePattern = this.caseInsensitiveGlobPattern(fuzzyPattern);
		const allMatches: URI[] = [];
		const maxResults = 50;

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
				if (allMatches.length >= maxResults) {
					break;
				}
			} catch (e) {
				if (token.isCancellationRequested) {
					break;
				}
			}
		}

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

