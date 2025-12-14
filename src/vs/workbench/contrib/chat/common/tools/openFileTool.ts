/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const OpenFileToolId = 'vscode_openFile';

export const OpenFileToolData: IToolData = {
	id: OpenFileToolId,
	toolReferenceName: 'openFile',
	displayName: localize('openFileTool.displayName', 'Open File'),
	modelDescription: localize('openFileTool.modelDescription', 'Opens a file in the editor. Can optionally navigate to a specific line number. Useful for showing the user specific code files when explaining concepts.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	tags: ['ask-mode'],
	when: ContextKeyExpr.equals('chatAgentKind', 'ask'),
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: localize('openFileTool.filePath', 'The file path to open. Can be absolute or workspace-relative.')
			},
			lineNumber: {
				type: 'number',
				description: localize('openFileTool.lineNumber', 'Optional: The line number to navigate to and highlight. 1-indexed.')
			},
			preview: {
				type: 'boolean',
				description: localize('openFileTool.preview', 'Optional: Whether to open in preview mode (default: true). Set to false to pin the file.')
			}
		},
		required: ['filePath'],
		additionalProperties: false
	}
};

export interface IOpenFileToolParams {
	filePath: string;
	lineNumber?: number;
	preview?: boolean;
}

export class OpenFileTool implements IToolImpl {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IOpenFileToolParams;
		
		const lineInfo = parameters.lineNumber ? ` at line ${parameters.lineNumber}` : '';

		return {
			invocationMessage: localize('openFileTool.invocationMessage', 'Opening {0}{1}...', parameters.filePath, lineInfo),
			pastTenseMessage: localize('openFileTool.pastTenseMessage', 'Opened {0}{1}', parameters.filePath, lineInfo),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IOpenFileToolParams;

		if (!args.filePath) {
			return {
				content: [{
					kind: 'text',
					value: localize('openFileTool.missingPath', 'File path is required')
				}],
				toolResultMessage: localize('openFileTool.error', 'Failed to open file: missing path')
			};
		}

		try {
			// Parse the file path to URI
			const fileUri = this.parseFilePath(args.filePath);

			// Prepare editor options
			const options: any = {
				preserveFocus: false,
				revealIfOpened: true,
				pinned: args.preview === false,
			};

			// Add selection if line number is provided
			if (args.lineNumber && args.lineNumber > 0) {
				options.selection = {
					startLineNumber: args.lineNumber,
					startColumn: 1,
					endLineNumber: args.lineNumber,
					endColumn: 1
				};
			}

			// Open the file
			await this.editorService.openEditor({
				resource: fileUri,
				options
			});

			const lineInfo = args.lineNumber ? ` at line ${args.lineNumber}` : '';
			const message = localize('openFileTool.success', 'Opened {0}{1}', args.filePath, lineInfo);

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
					value: localize('openFileTool.error', 'Error opening file: {0}', errorMessage)
				}],
				toolResultMessage: localize('openFileTool.error', 'Error opening file: {0}', errorMessage)
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
