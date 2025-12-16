/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';
import { IPlanTodoSyncService } from '../planTodoSyncService.js';

const DEFAULT_PLAN_FILE_NAME = 'plan.plan.md';
const PLAN_ROOT_DIRECTORY = '.ren/plans';

export interface IPlanFileToolInput {
	filename?: string;
	directory?: string;
	content: string;
	mode?: 'overwrite' | 'append';
}

export const PlanFileToolData: IToolData = {
	id: 'plan.writeFile',
	toolReferenceName: 'writePlan',
	displayName: localize('planFileTool.displayName', "Write Plan File"),
	userDescription: localize('planFileTool.userDescription', "Create or update the markdown plan file in the workspace. Always call this tool when in Plan mode."),
	modelDescription: localize('planFileTool.modelDescription', "Creates or updates the markdown plan file. Provide the desired filename (e.g. feature-plan.md) and the full content you want to persist. Use mode=\"append\" to add to the existing file or omit it to overwrite the file."),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			filename: {
				type: 'string',
				description: localize('planFileTool.filename', "The markdown filename to create or update, e.g. `feature.plan.md`. Defaults to plan.plan.md.")
			},
			directory: {
				type: 'string',
				description: localize('planFileTool.directory', "Optional directory (relative to workspace root) where the plan file should live. Defaults to workspace root.")
			},
			content: {
				type: 'string',
				description: localize('planFileTool.content', "The full markdown content to write to the plan file. Include all sections you want the user to see.")
			},
			mode: {
				type: 'string',
				enum: ['overwrite', 'append'],
				description: localize('planFileTool.mode', "Set to `append` to add to the existing file instead of replacing it. Default is overwrite.")
			}
		},
		required: ['content']
	}
};

export class PlanFileTool extends Disposable implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService _instaService: IInstantiationService,
		@IPlanTodoSyncService private readonly planTodoSyncService: IPlanTodoSyncService,
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as IPlanFileToolInput;
		const uri = this.resolveUri(args.filename, args.directory);
		return {
			invocationMessage: localize('planFileTool.invocationMessage', "Writing plan file: {0}", uri.fsPath),
			pastTenseMessage: localize('planFileTool.pastTenseMessage', "Updated plan file: {0}", uri.fsPath)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IPlanFileToolInput;
		const uri = this.resolveUri(args.filename, args.directory);
		const mode = args.mode ?? 'overwrite';

		try {
			// Ensure the plan directory exists before writing
			const parentDir = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
			try {
				await this.fileService.createFolder(parentDir);
			} catch (error) {
				if (!(error instanceof Error && error.message.includes('already exists'))) {
					this.logService.debug(`[PlanFileTool] Error creating parent directory: ${error}`);
				}
			}

			let contentToWrite = args.content;
			const exists = await this.fileService.exists(uri);
			if (exists && mode === 'append') {
				const existing = await this.fileService.readFile(uri);
				const decoded = existing.value.toString();
				contentToWrite = decoded ? `${decoded.trimEnd()}\n\n${args.content}` : args.content;
			}

			const buffer = VSBuffer.fromString(contentToWrite);
			await this.fileService.writeFile(uri, buffer);

			// Automatically open the plan file in the editor
			try {
				await this.editorService.openEditor({
					resource: uri,
					options: {
						pinned: true,
						preserveFocus: false,
						revealIfVisible: true
					}
				});
				this.logService.debug(`[PlanFileTool] Opened plan file: ${uri.toString()}`);
			} catch (error) {
				this.logService.warn(`[PlanFileTool] Failed to open plan file: ${error}`);
				// Continue even if opening fails
			}

			// Sync plan todos with the chat todo widget
			const sessionId = invocation.context?.sessionId;
			if (sessionId) {
				try {
					this.planTodoSyncService.registerPlanFile(uri, sessionId);
					this.logService.debug(`[PlanFileTool] Synced plan todos for session: ${sessionId}`);
				} catch (syncError) {
					this.logService.warn(`[PlanFileTool] Failed to sync plan todos: ${syncError}`);
				}
			}

			const workspaceRelative = this.getWorkspaceRelativePath(uri);

			// Create a rich markdown preview of the plan
			const markdownPreview = new MarkdownString();
			markdownPreview.isTrusted = true;
			markdownPreview.supportThemeIcons = true;

			markdownPreview.appendMarkdown(`### Plan Updated: [${workspaceRelative ?? uri.fsPath}](${uri.toString(true)})\n\n`);
			markdownPreview.appendMarkdown(contentToWrite);

			return {
				content: [
				],
				toolResultMessage: markdownPreview
			};
		} catch (error) {
			this.logService.error('[PlanFileTool] Failed to write plan file', error);
			return {
				content: [{
					kind: 'text',
					value: localize('planFileTool.error', "Failed to write plan file: {0}", error instanceof Error ? error.message : String(error))
				}]
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


