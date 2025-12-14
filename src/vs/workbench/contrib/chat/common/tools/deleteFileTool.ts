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
import { IRenMonitorXChangelogBuffer } from '../../../renViews/common/renChangelogBuffer.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';
import { IChatService } from '../../common/chatService.js';
import { ChatModel } from '../../common/chatModel.js';

export const DeleteFileToolData: IToolData = {
	id: 'delete_file',
	toolReferenceName: 'deleteFile',
	displayName: localize('deleteFileTool.displayName', 'Delete File'),
	modelDescription: localize('deleteFileTool.modelDescription', 'Deletes a file or directory. Supports both full paths/URIs and filenames. When given a filename, searches recursively across the entire workspace with fuzzy matching (e.g., "config" will find "config.json", "config.yaml", etc.). If multiple matches are found, returns a list for you to specify which one to delete.'),
	source: ToolDataSource.Internal,
	category: 'file_operations',
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
			},
			subject: {
				type: 'string',
				description: localize('deleteFileTool.subject', 'Optional: Short subject (4-10 words) for the changelog entry. If not provided, a default subject will be generated.')
			},
			description: {
				type: 'string',
				description: localize('deleteFileTool.description', 'Optional: Description (2-5 sentences) for the changelog entry explaining what was deleted and why. If not provided, a default description will be generated.')
			}
		},
		required: ['uri']
	}
};

export interface IDeleteFileToolInput {
	uri: string;
	recursive?: boolean;
	subject?: string;
	description?: string;
}

export class DeleteFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer,
		@IChatService private readonly chatService: IChatService,
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
		const sessionId = invocation.context?.sessionId;

		try {
			// Check if input is a full path/URI or just a filename
			if (this.isFullPath(args.uri)) {
				// Full path/URI - use existing logic
				const uri = this.parseUri(args.uri);
				return await this.deleteFileByUri(uri, args.recursive ?? false, args.subject, args.description, sessionId);
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
					return await this.deleteFileByUri(matches[0], args.recursive ?? false, args.subject, args.description, sessionId);
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

	private async deleteFileByUri(uri: URI, recursive: boolean, subject?: string, description?: string, sessionId?: string): Promise<IToolResult> {
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

		// Read file content before deletion for changelog
		let fileContent: string | null = null;
		let isFile = false;
		try {
			const stat = await this.fileService.resolve(uri);
			if (stat && !stat.isDirectory) {
				isFile = true;
				const content = await this.fileService.readFile(uri);
				fileContent = content.value.toString();
			}
		} catch (error) {
			// If we can't read the file, continue with deletion but skip changelog entry
			this.logService.warn(`[DeleteFileTool] Failed to read file content for changelog: ${error}`);
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

		// Create changelog draft in buffer and file operation entry in ChatEditingSession (only for files, not directories)
		if (isFile && fileContent !== null) {
			try {
				if (!sessionId) {
					this.logService.warn(`[DeleteFileTool] No sessionId available, skipping changelog entry`);
				} else {
					const workspaceRelativePath = this.getWorkspaceRelativePath(uri);
					const diff = this.generateDeleteFileDiff(fileContent);
					const changelogSubject = subject || this.generateDefaultSubject('delete', workspaceRelativePath);
					const changelogDescription = description || this.generateDefaultDescription('delete', workspaceRelativePath);

					// Create draft key: sessionId:uri (similar to EditTool)
					const draftKey = `${sessionId}:${uri.toString()}`;

					// Store draft in buffer (will be finalized later when user accepts or session ends)
					this.changelogBuffer.setDraft(draftKey, {
						subject: changelogSubject,
						description: changelogDescription,
						files: [{
							path: workspaceRelativePath,
							diff
						}]
					});

					this.logService.debug(`[DeleteFileTool] Changelog draft created in buffer for: ${workspaceRelativePath}`);

					// Create file operation entry in ChatEditingSession
					try {
						const model = this.chatService.getSession(sessionId) as ChatModel | undefined;
						if (model && model.editingSession) {
							const editingSession = model.editingSession;
							const request = model.getRequests().at(-1);
							if (request) {
								const responseModel = request.response;
								const agent = responseModel?.agent;
								const telemetryInfo = {
									agentId: agent?.id,
									command: undefined, // File operations don't have a specific command
									requestId: request.id,
									sessionId: sessionId,
									modelId: request.modelId,
									modeId: request.modeInfo?.modeId,
									applyCodeBlockSuggestionId: request.modeInfo?.applyCodeBlockSuggestionId,
									result: undefined,
									feature: undefined,
								};

								// Create file operation entry with original content for restore
								await editingSession.createFileOperationEntry(
									uri,
									'delete',
									telemetryInfo,
									fileContent
								);

								this.logService.debug(`[DeleteFileTool] File operation entry created in editing session for: ${workspaceRelativePath}`);
							}
						}
					} catch (error) {
						// Don't fail the tool if entry creation fails
						this.logService.warn(`[DeleteFileTool] Failed to create file operation entry: ${error}`);
					}
				}
			} catch (error) {
				// Don't fail the tool if changelog draft creation fails
				this.logService.warn(`[DeleteFileTool] Failed to create changelog draft: ${error}`);
			}
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

	private generateDeleteFileDiff(content: string): string {
		if (!content || content.trim().length === 0) {
			return '';
		}
		// Simple line-by-line diff: each line prefixed with -
		const lines = content.split(/\r?\n/);
		return lines.map(line => '-' + line).join('\n');
	}

	private generateDefaultSubject(action: 'create' | 'delete', filePath: string): string {
		const fileName = filePath.split('/').pop() || filePath;
		if (action === 'create') {
			return `Create ${fileName}`;
		}
		return `Delete ${fileName}`;
	}

	private generateDefaultDescription(action: 'create' | 'delete', filePath: string, content?: string): string {
		if (action === 'create') {
			if (content && content.trim().length > 0) {
				const lineCount = content.split(/\r?\n/).length;
				return `Created file ${filePath} with ${lineCount} line${lineCount !== 1 ? 's' : ''}.`;
			}
			return `Created empty file ${filePath}.`;
		}
		return `Deleted file ${filePath}.`;
	}

	private getWorkspaceRelativePath(uri: URI): string {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return uri.fsPath;
		}
		const workspaceRoot = workspace.folders[0].uri;
		const relative = uri.toString().substring(workspaceRoot.toString().length);
		return relative.startsWith('/') ? relative.substring(1) : relative;
	}
}

