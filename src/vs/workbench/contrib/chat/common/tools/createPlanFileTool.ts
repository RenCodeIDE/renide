/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IMerkleTreeService } from '../../../../../platform/merkleTree/common/merkleTreeService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';
import { IPlanTodoSyncService } from '../planTodoSyncService.js';

const DEFAULT_PLAN_FILE_NAME = 'plan.plan.md';
const PLAN_ROOT_DIRECTORY = '.ren/plans';

export interface ICreatePlanFileToolInput {
	filename?: string;
	directory?: string;
	content: string;
	overwrite?: boolean;
}

export const CreatePlanFileToolData: IToolData = {
	id: 'plan.createFile',
	toolReferenceName: 'createPlanFile',
	displayName: localize('createPlanFileTool.displayName', 'Create Plan File'),
	userDescription: localize('createPlanFileTool.userDescription', 'Create a new .plan.md file in the workspace. Use this tool to create plan files in Plan mode.'),
	modelDescription: localize('createPlanFileTool.modelDescription', 'Creates a new .plan.md file with the specified content. Provide the desired filename (e.g. feature-plan.md) which will be automatically normalized to .plan.md extension, and the content to write. This tool does NOT register changelog entries - plan files are meant for planning, not version control.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			filename: {
				type: 'string',
				description: localize('createPlanFileTool.filename', 'The filename for the plan file, e.g. `feature-plan.md` or `feature.plan.md`. Will be normalized to end with .plan.md. Defaults to plan.plan.md if not provided.')
			},
			directory: {
				type: 'string',
				description: localize('createPlanFileTool.directory', 'Optional directory (relative to workspace root) where the plan file should be created. Defaults to workspace root.')
			},
			content: {
				type: 'string',
				description: localize('createPlanFileTool.content', 'The content to write to the plan file.')
			},
			overwrite: {
				type: 'boolean',
				description: localize('createPlanFileTool.overwrite', 'Optional: Whether to overwrite the file if it already exists. Defaults to false.')
			}
		},
		required: ['content']
	}
};

export class CreatePlanFileTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@ILogService private readonly logService: ILogService,
		@ICommandService private readonly commandService: ICommandService,
		@IPlanTodoSyncService private readonly planTodoSyncService: IPlanTodoSyncService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ICreatePlanFileToolInput;
		const uri = this.resolveUri(args.filename, args.directory);

		return {
			invocationMessage: localize('createPlanFileTool.invocationMessage', 'Creating plan file: {0}', uri.fsPath),
			pastTenseMessage: localize('createPlanFileTool.pastTenseMessage', 'Created plan file: {0}', uri.fsPath)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ICreatePlanFileToolInput;
		const uri = this.resolveUri(args.filename, args.directory);

		try {
			// Check if file already exists
			const exists = await this.fileService.exists(uri);
			if (exists && !args.overwrite) {
				return {
					content: [{
						kind: 'text',
						value: localize('createPlanFileTool.fileExists', 'Plan file already exists: {0}. Use overwrite: true to replace it, or use writePlan tool to update it.', uri.fsPath)
					}],
					toolResultMessage: localize('createPlanFileTool.fileExists', 'Plan file already exists: {0}. Use overwrite: true to replace it, or use writePlan tool to update it.', uri.fsPath)
				};
			}

			// Ensure parent directory exists (mkdirp semantics)
			const parentDir = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
			try {
				await this.fileService.createFolder(parentDir);
			} catch (error) {
				// Ignore error if directory already exists
				if (!(error instanceof Error && error.message.includes('already exists'))) {
					this.logService.debug(`[CreatePlanFileTool] Error creating parent directory: ${error}`);
				}
			}

			// Create file with content
			const buffer = VSBuffer.fromString(args.content);
			if (args.overwrite && exists) {
				// If overwrite is true and file exists, use writeFile which will overwrite
				await this.fileService.writeFile(uri, buffer);
			} else {
				// Use createFile for new files
				await this.fileService.createFile(uri, buffer);
			}

			// CRITICAL: Ensure file is tracked in merkle tree for code search
			// This is required because lazy tracking is enabled by default
			// Without ensureTracked(), the file won't be in merkle tree and won't have chunks
			try {
				await this.merkleTreeService.ensureTracked(uri);
				this.logService.debug(`[CreatePlanFileTool] Plan file tracked in merkle tree: ${uri.fsPath}`);
			} catch (error) {
				// Don't fail the tool if merkle tree tracking fails
				this.logService.warn(`[CreatePlanFileTool] Failed to track plan file in merkle tree: ${error}`);
			}

			// Automatically open and activate the plan file in the editor, then open in preview
			try {
				await this.editorService.openEditor({
					resource: uri,
					options: {
						pinned: true,
						preserveFocus: false, // Give it focus to make it active
						revealIfVisible: true
					}
				});
				this.logService.debug(`[CreatePlanFileTool] Opened and activated plan file: ${uri.toString()}`);

				// Open in markdown preview mode
				try {
					await this.commandService.executeCommand('markdown.showPreview', uri);
					this.logService.debug(`[CreatePlanFileTool] Opened plan file in preview mode: ${uri.toString()}`);
				} catch (previewError) {
					this.logService.warn(`[CreatePlanFileTool] Failed to open plan file in preview: ${previewError}`);
					// Continue even if preview fails
				}
			} catch (error) {
				this.logService.warn(`[CreatePlanFileTool] Failed to open plan file: ${error}`);
				// Continue even if opening fails
			}

			// Sync plan todos with the chat todo widget
			const sessionId = invocation.context?.sessionId;
			if (sessionId) {
				try {
					this.planTodoSyncService.registerPlanFile(uri, sessionId);
					this.logService.debug(`[CreatePlanFileTool] Synced plan todos for session: ${sessionId}`);
				} catch (syncError) {
					this.logService.warn(`[CreatePlanFileTool] Failed to sync plan todos: ${syncError}`);
				}
			}

			const workspaceRelative = this.getWorkspaceRelativePath(uri);
			const markdownLink = new MarkdownString(`[Plan file created: ${workspaceRelative ?? uri.fsPath}](${uri.toString(true)})`);
			markdownLink.isTrusted = true;

			return {
				content: [{
					kind: 'text',
					value: localize('createPlanFileTool.success', 'Plan file created and opened: {0}', workspaceRelative ?? uri.fsPath)
				}],
				toolResultMessage: markdownLink
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error('[CreatePlanFileTool] Failed to create plan file', error);
			return {
				content: [{
					kind: 'text',
					value: localize('createPlanFileTool.error', 'Error creating plan file {0}: {1}', uri.fsPath, errorMessage)
				}],
				toolResultMessage: localize('createPlanFileTool.error', 'Error creating plan file {0}: {1}', uri.fsPath, errorMessage)
			};
		}
	}

	private resolveUri(filename: string | undefined, directory: string | undefined): URI {
		const sanitizedName = this.sanitizeFilename(filename ?? DEFAULT_PLAN_FILE_NAME);
		const workspace = this.workspaceService.getWorkspace();
		const workspaceUri = workspace.folders[0]?.uri ?? URI.file('/');
		const basePlanPath = this.joinPath(workspaceUri.path, PLAN_ROOT_DIRECTORY);
		const normalizedDirectory = this.normalizeDirectory(directory);

		const targetPath = normalizedDirectory
			? this.joinPath(basePlanPath, normalizedDirectory, sanitizedName)
			: this.joinPath(basePlanPath, sanitizedName);

		return workspaceUri.with({ path: targetPath });
	}

	private sanitizeFilename(name: string): string {
		const trimmed = name.trim().toLowerCase();
		const normalized = trimmed.endsWith('.plan.md') ? trimmed : (trimmed.endsWith('.md') ? trimmed.replace(/\.md$/, '.plan.md') : `${trimmed}.plan.md`);
		return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
	}

	private normalizeDirectory(directory: string | undefined): string {
		if (!directory) {
			return '';
		}
		// Keep paths inside the plan root by stripping traversal attempts
		return directory
			.replace(/\\/g, '/')
			.replace(/^\.\//, '')
			.split('/')
			.filter(segment => segment && segment !== '..')
			.join('/');
	}

	private joinPath(...segments: string[]): string {
		const filtered = segments.filter(Boolean);
		let result = filtered.join('/');
		result = result.replace(/\/{2,}/g, '/');
		if (!result.startsWith('/')) {
			result = `/${result}`;
		}
		return result;
	}

	private getWorkspaceRelativePath(uri: URI): string | undefined {
		const workspace = this.workspaceService.getWorkspace();
		const workspaceUri = workspace.folders[0]?.uri;
		if (!workspaceUri) {
			return undefined;
		}

		const workspacePath = workspaceUri.path.endsWith('/') ? workspaceUri.path : `${workspaceUri.path}/`;
		if (uri.path.startsWith(workspacePath)) {
			let relative = uri.path.slice(workspacePath.length);
			if (isWindows) {
				relative = relative.replace(/^\//, '');
			}
			return relative;
		}
		return uri.fsPath;
	}
}

