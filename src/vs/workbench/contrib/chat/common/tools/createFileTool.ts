/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IMerkleTreeService } from '../../../../../platform/merkleTree/common/merkleTreeService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';

export const CreateFileToolData: IToolData = {
	id: 'create_file',
	toolReferenceName: 'createFile',
	displayName: localize('createFileTool.displayName', 'Create File'),
	modelDescription: localize('createFileTool.modelDescription', 'Creates a new file with the specified content. The uri parameter can be a full path/URI or just a filename. If just a filename is provided, use the directory parameter to specify where to create it, otherwise it defaults to the workspace root.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			uri: {
				type: 'string',
				description: localize('createFileTool.uri', 'The URI, file path, or filename to create. Can be a full path/URI or just a filename. If just a filename, use the directory parameter to specify the target directory.')
			},
			content: {
				type: 'string',
				description: localize('createFileTool.content', 'The content to write to the file.')
			},
			directory: {
				type: 'string',
				description: localize('createFileTool.directory', 'Optional: The directory where the file should be created. Can be a relative path from workspace root or an absolute path. If uri is just a filename and directory is not specified, defaults to workspace root.')
			},
			overwrite: {
				type: 'boolean',
				description: localize('createFileTool.overwrite', 'Optional: Whether to overwrite the file if it already exists. Defaults to false.')
			}
		},
		required: ['uri', 'content']
	}
};

export interface ICreateFileToolInput {
	uri: string;
	content: string;
	directory?: string;
	overwrite?: boolean;
}

export class CreateFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@ILogService private readonly logService: ILogService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ICreateFileToolInput;
		const uri = this.resolveFileUri(args.uri, args.directory);

		return {
			invocationMessage: localize('createFileTool.invocationMessage', 'Creating file: {0}', uri.fsPath),
			pastTenseMessage: localize('createFileTool.pastTenseMessage', 'Created file: {0}', uri.fsPath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ICreateFileToolInput;
		const uri = this.resolveFileUri(args.uri, args.directory);

		try {
			// Check if file already exists
			const exists = await this.fileService.exists(uri);
			if (exists && !args.overwrite) {
				return {
					content: [{
						kind: 'text',
						value: localize('createFileTool.fileExists', 'File already exists: {0}. Use overwrite: true to replace it.', uri.fsPath)
					}],
					toolResultMessage: localize('createFileTool.fileExists', 'File already exists: {0}. Use overwrite: true to replace it.', uri.fsPath)
				};
			}

			// Ensure parent directory exists (mkdirp semantics)
			const parentDir = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
			try {
				await this.fileService.createFolder(parentDir);
			} catch (error) {
				// Ignore error if directory already exists
				if (!(error instanceof Error && error.message.includes('already exists'))) {
					this.logService.debug(`[CreateFileTool] Error creating parent directory: ${error}`);
				}
			}

			// Create file with content
			const buffer = VSBuffer.fromString(args.content);
			if (args.overwrite) {
				// If overwrite is true, use writeFile which will overwrite existing files
				await this.fileService.writeFile(uri, buffer);
			} else {
				// Use createFile for new files
				await this.fileService.createFile(uri, buffer);
			}

			// CRITICAL: Ensure file is tracked in merkle tree
			// This is required because lazy tracking is enabled by default
			// Without ensureTracked(), the file won't be in merkle tree and won't have chunks
			try {
				await this.merkleTreeService.ensureTracked(uri);
				this.logService.debug(`[CreateFileTool] File tracked in merkle tree: ${uri.fsPath}`);
			} catch (error) {
				// Don't fail the tool if merkle tree tracking fails
				this.logService.warn(`[CreateFileTool] Failed to track file in merkle tree: ${error}`);
			}

			return {
				content: [{
					kind: 'text',
					value: localize('createFileTool.success', 'File created successfully: {0}', uri.fsPath)
				}],
				toolResultMessage: localize('createFileTool.success', 'File created successfully: {0}', uri.fsPath)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('createFileTool.error', 'Error creating file {0}: {1}', uri.fsPath, errorMessage)
				}],
				toolResultMessage: localize('createFileTool.error', 'Error creating file {0}: {1}', uri.fsPath, errorMessage)
			};
		}
	}

	private resolveFileUri(uriString: string, directory?: string): URI {
		try {
			// Try parsing as URI first
			if (uriString.includes('://') || uriString.startsWith('file://')) {
				return URI.parse(uriString);
			}

			const workspace = this.workspaceService.getWorkspace();
			const workspaceRoot = workspace.folders.length > 0 ? workspace.folders[0].uri : undefined;

			// Check if it's already an absolute path
			if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
				return URI.file(uriString);
			}

			// Check if uri contains path separators (has directory info)
			const hasPath = uriString.includes('/') || (isWindows && uriString.includes('\\'));

			if (hasPath) {
				// uri contains path - resolve against workspace root if relative
				if (workspaceRoot) {
					return URI.joinPath(workspaceRoot, uriString);
				}
				return URI.file(uriString);
			}

			// Just a filename - use directory parameter or default to workspace root
			if (directory) {
				// Parse directory
				let dirUri: URI;
				if (directory.includes('://') || directory.startsWith('file://')) {
					dirUri = URI.parse(directory);
				} else if (directory.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(directory))) {
					dirUri = URI.file(directory);
				} else if (workspaceRoot) {
					// Relative directory path
					dirUri = URI.joinPath(workspaceRoot, directory);
				} else {
					dirUri = URI.file(directory);
				}
				return URI.joinPath(dirUri, uriString);
			}

			// No directory specified, default to workspace root
			if (workspaceRoot) {
				return URI.joinPath(workspaceRoot, uriString);
			}

			// Fallback to file URI
			return URI.file(uriString);
		} catch {
			// If parsing fails, treat as file path
			return URI.file(uriString);
		}
	}

}

