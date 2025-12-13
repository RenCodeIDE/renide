/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const CloseFileToolId = 'vscode_closeFile';

export const CloseFileToolData: IToolData = {
	id: CloseFileToolId,
	toolReferenceName: 'closeFile',
	displayName: localize('closeFileTool.displayName', 'Close File'),
	modelDescription: localize('closeFileTool.modelDescription', 'Closes a file in the editor. Can close all instances of the file across all editor groups, or just the active instance. Useful for cleaning up the workspace after showing code examples.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: localize('closeFileTool.filePath', 'The file path to close. Can be absolute or workspace-relative.')
			},
			closeAll: {
				type: 'boolean',
				description: localize('closeFileTool.closeAll', 'Optional: Whether to close all instances of the file in all editor groups (default: false). If false, closes only the active instance.')
			}
		},
		required: ['filePath'],
		additionalProperties: false
	}
};

export interface ICloseFileToolParams {
	filePath: string;
	closeAll?: boolean;
}

export class CloseFileTool implements IToolImpl {
	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as ICloseFileToolParams;

		return {
			invocationMessage: localize('closeFileTool.invocationMessage', 'Closing {0}...', parameters.filePath),
			pastTenseMessage: localize('closeFileTool.pastTenseMessage', 'Closed {0}', parameters.filePath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ICloseFileToolParams;

		if (!args.filePath) {
			return {
				content: [{
					kind: 'text',
					value: localize('closeFileTool.missingPath', 'File path is required')
				}],
				toolResultMessage: localize('closeFileTool.error', 'Failed to close file: missing path')
			};
		}

		try {
			// Parse the file path to URI
			const fileUri = this.parseFilePath(args.filePath);
			const closeAll = args.closeAll === true;

			let closedCount = 0;

			if (closeAll) {
				// Close all instances across all editor groups
				for (const group of this.editorGroupsService.groups) {
					// Find all editors matching this resource
					const editors = group.editors.filter(editor => {
						const resource = editor.resource;
						return resource && resource.toString() === fileUri.toString();
					});

					// Close each matching editor
					for (const editor of editors) {
						await group.closeEditor(editor);
						closedCount++;
					}
				}
			} else {
				// Close only in the active group
				const activeGroup = this.editorGroupsService.activeGroup;
				const editors = activeGroup.editors.filter(editor => {
					const resource = editor.resource;
					return resource && resource.toString() === fileUri.toString();
				});

				for (const editor of editors) {
					await activeGroup.closeEditor(editor);
					closedCount++;
				}
			}

			const message = closedCount > 0
				? localize('closeFileTool.success', 'Closed {0} instance(s) of {1}', closedCount, args.filePath)
				: localize('closeFileTool.notOpen', 'File {0} was not open', args.filePath);

			return {
				content: [{
					kind: 'text',
					value: message
				}],
				toolResultMessage: message
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('closeFileTool.error', 'Error closing file: {0}', errorMessage)
				}],
				toolResultMessage: localize('closeFileTool.error', 'Error closing file: {0}', errorMessage)
			};
		}
	}

	private parseFilePath(path: string): URI {
		// Check if it's already a URI
		if (path.includes('://') || path.startsWith('file://')) {
			return URI.parse(path);
		}

		// Check if it's an absolute path
		if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
			return URI.file(path);
		}

		// Treat as workspace-relative path
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length > 0) {
			return URI.joinPath(workspace.folders[0].uri, path);
		}

		// Fallback to file URI
		return URI.file(path);
	}
}
