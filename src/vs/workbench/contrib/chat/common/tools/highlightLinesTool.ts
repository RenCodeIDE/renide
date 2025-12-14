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
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const HighlightLinesToolId = 'vscode_highlightLines';

export const HighlightLinesToolData: IToolData = {
	id: HighlightLinesToolId,
	toolReferenceName: 'highlightLines',
	displayName: localize('highlightLinesTool.displayName', 'Highlight Lines'),
	modelDescription: localize('highlightLinesTool.modelDescription', 'Highlights a range of lines in the editor to draw attention to specific code. The highlighting is temporary and helps focus the user on important code sections during explanations. The highlight automatically clears after a few seconds.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	tags: ['ask-mode'],
	when: ContextKeyExpr.equals('chatAgentKind', 'ask'),
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: localize('highlightLinesTool.filePath', 'Optional: The file path to highlight in. If not specified, uses the currently active file.')
			},
			startLine: {
				type: 'number',
				description: localize('highlightLinesTool.startLine', 'The starting line number to highlight (1-indexed).')
			},
			endLine: {
				type: 'number',
				description: localize('highlightLinesTool.endLine', 'The ending line number to highlight (1-indexed). Same as startLine for single line.')
			},
			color: {
				type: 'string',
				enum: ['yellow', 'blue', 'green', 'red'],
				description: localize('highlightLinesTool.color', 'Optional: The highlight color. Default: yellow.')
			}
		},
		required: ['startLine', 'endLine'],
		additionalProperties: false
	},
	// Smart default: use selection or cursor position
	resolveDefaults: (ctx) => {
		const defaults: Partial<Record<string, unknown>> = {};
		if (ctx.activeFile) {
			defaults.filePath = ctx.activeFile.fsPath;
		}
		// If there's a selection, highlight that
		if (ctx.selectionRange) {
			defaults.startLine = ctx.selectionRange.startLine;
			defaults.endLine = ctx.selectionRange.endLine;
		} else if (ctx.cursorPosition) {
			// Otherwise use cursor line
			defaults.startLine = ctx.cursorPosition.line;
			defaults.endLine = ctx.cursorPosition.line;
		}
		return defaults;
	}
};

export interface IHighlightLinesToolParams {
	filePath?: string;
	startLine: number;
	endLine: number;
	color?: 'yellow' | 'blue' | 'green' | 'red';
}

// Color mapping for decorations
const HIGHLIGHT_COLORS: Record<string, string> = {
	yellow: 'rgba(255, 255, 0, 0.3)',
	blue: 'rgba(0, 100, 255, 0.2)',
	green: 'rgba(0, 255, 100, 0.2)',
	red: 'rgba(255, 100, 100, 0.2)'
};

export class HighlightLinesTool implements IToolImpl {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IHighlightLinesToolParams;

		const lineRange = parameters.startLine === parameters.endLine
			? `line ${parameters.startLine}`
			: `lines ${parameters.startLine}-${parameters.endLine}`;
		const fileInfo = parameters.filePath ? ` in ${parameters.filePath}` : '';

		return {
			invocationMessage: localize('highlightLinesTool.invocationMessage', 'Highlighting {0}{1}...', lineRange, fileInfo),
			pastTenseMessage: localize('highlightLinesTool.pastTenseMessage', 'Highlighted {0}{1}', lineRange, fileInfo),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IHighlightLinesToolParams;

		if (!args.startLine || args.startLine < 1) {
			return {
				content: [{
					kind: 'text',
					value: localize('highlightLinesTool.invalidStartLine', 'Start line must be a positive integer')
				}],
				toolResultMessage: localize('highlightLinesTool.error', 'Failed to highlight: invalid start line')
			};
		}

		if (!args.endLine || args.endLine < args.startLine) {
			return {
				content: [{
					kind: 'text',
					value: localize('highlightLinesTool.invalidEndLine', 'End line must be greater than or equal to start line')
				}],
				toolResultMessage: localize('highlightLinesTool.error', 'Failed to highlight: invalid end line')
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
						value: localize('highlightLinesTool.noFile', 'No file specified and no active file to highlight in')
					}],
					toolResultMessage: localize('highlightLinesTool.error', 'Failed to highlight: no file available')
				};
			}

			// Open the file first if not already open
			await this.editorService.openEditor({
				resource: fileUri,
				options: {
					revealIfOpened: true,
					preserveFocus: false
				}
			});

			// Get the active code editor
			const codeEditor = this.codeEditorService.getActiveCodeEditor();
			if (!codeEditor) {
				return {
					content: [{
						kind: 'text',
						value: localize('highlightLinesTool.noEditor', 'No active code editor available')
					}],
					toolResultMessage: localize('highlightLinesTool.error', 'Failed to highlight: no editor')
				};
			}

			// Create decoration for highlighting
			const color = args.color || 'yellow';
			const backgroundColor = HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;

			this.applyHighlightDecoration(codeEditor, args.startLine, args.endLine, backgroundColor);

			const lineRange = args.startLine === args.endLine
				? `line ${args.startLine}`
				: `lines ${args.startLine}-${args.endLine}`;
			const fileInfo = args.filePath ? ` in ${args.filePath}` : '';
			const message = localize('highlightLinesTool.success', 'Highlighted {0}{1}', lineRange, fileInfo);

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
					value: localize('highlightLinesTool.error', 'Error highlighting lines: {0}', errorMessage)
				}],
				toolResultMessage: localize('highlightLinesTool.error', 'Error highlighting lines: {0}', errorMessage)
			};
		}
	}

	private applyHighlightDecoration(editor: ICodeEditor, startLine: number, endLine: number, backgroundColor: string): void {
		// Create a decoration type
		const decorationType = editor.createDecorationsCollection([
			{
				range: {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine,
					endColumn: 1
				},
				options: {
					description: 'ask-mode-line-highlight',
					isWholeLine: true,
					className: 'ask-mode-highlight',
					overviewRuler: {
						color: backgroundColor,
						position: 4 // OverviewRulerLane.Full
					}
				}
			}
		]);

		// Also set the selection to highlight the lines visually
		editor.setSelection({
			startLineNumber: startLine,
			startColumn: 1,
			endLineNumber: endLine,
			endColumn: Number.MAX_SAFE_INTEGER
		});

		// Reveal the highlighted lines
		editor.revealLineInCenter(Math.floor((startLine + endLine) / 2));

		// Auto-clear decoration after 10 seconds
		setTimeout(() => {
			decorationType.clear();
		}, 10000);
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
