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

export const NavigateToLineToolId = 'vscode_navigateToLine';

export const NavigateToLineToolData: IToolData = {
	id: NavigateToLineToolId,
	toolReferenceName: 'navigateToLine',
	displayName: localize('navigateToLineTool.displayName', 'Navigate to Line'),
	modelDescription: localize('navigateToLineTool.modelDescription', 'Navigates to a specific line number in a file and reveals it in the editor. Can work with the currently active file or open a new file first. Useful for guiding the user to specific code locations during explanations.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	tags: ['ask-mode'],
	when: ContextKeyExpr.equals('chatAgentKind', 'ask'),
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: localize('navigateToLineTool.filePath', 'Optional: The file path to navigate in. If not specified, uses the currently active file.')
			},
			lineNumber: {
				type: 'number',
				description: localize('navigateToLineTool.lineNumber', 'The line number to navigate to (1-indexed).')
			},
			revealType: {
				type: 'string',
				enum: ['center', 'top', 'bottom'],
				description: localize('navigateToLineTool.revealType', 'How to reveal the line in the editor. Default: center.')
			}
		},
		required: ['lineNumber'],
		additionalProperties: false
	}
};

export interface INavigateToLineToolParams {
	filePath?: string;
	lineNumber: number;
	revealType?: 'center' | 'top' | 'bottom';
}

export class NavigateToLineTool implements IToolImpl {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as INavigateToLineToolParams;
		
		const fileInfo = parameters.filePath ? ` in ${parameters.filePath}` : '';

		return {
			invocationMessage: localize('navigateToLineTool.invocationMessage', 'Navigating to line {0}{1}...', parameters.lineNumber, fileInfo),
			pastTenseMessage: localize('navigateToLineTool.pastTenseMessage', 'Navigated to line {0}{1}', parameters.lineNumber, fileInfo),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as INavigateToLineToolParams;

		if (!args.lineNumber || args.lineNumber < 1) {
			return {
				content: [{
					kind: 'text',
					value: localize('navigateToLineTool.invalidLine', 'Line number must be a positive integer')
				}],
				toolResultMessage: localize('navigateToLineTool.error', 'Failed to navigate: invalid line number')
			};
		}

		try {
			let fileUri: URI | undefined;
			
			// If filePath is provided, parse it
			if (args.filePath) {
				fileUri = this.parseFilePath(args.filePath);
			} else {
				// Use the currently active editor
				const activeEditor = this.editorService.activeEditor;
				if (activeEditor?.resource) {
					fileUri = activeEditor.resource;
				}
			}

			if (!fileUri) {
				return {
					content: [{
						kind: 'text',
						value: localize('navigateToLineTool.noFile', 'No file specified and no active file to navigate in')
					}],
					toolResultMessage: localize('navigateToLineTool.error', 'Failed to navigate: no file available')
				};
			}

			// Open the file at the specified line
			await this.editorService.openEditor({
				resource: fileUri,
				options: {
					selection: {
						startLineNumber: args.lineNumber,
						startColumn: 1,
						endLineNumber: args.lineNumber,
						endColumn: 1
					},
					revealIfOpened: true,
					preserveFocus: false
				}
			});

			const fileInfo = args.filePath ? ` in ${args.filePath}` : '';
			const message = localize('navigateToLineTool.success', 'Navigated to line {0}{1}', args.lineNumber, fileInfo);

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
					value: localize('navigateToLineTool.error', 'Error navigating to line: {0}', errorMessage)
				}],
				toolResultMessage: localize('navigateToLineTool.error', 'Error navigating to line: {0}', errorMessage)
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
