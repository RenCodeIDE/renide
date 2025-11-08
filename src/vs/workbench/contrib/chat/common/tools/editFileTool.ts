/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { CellUri } from '../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../notebook/common/notebookService.js';
import { ICodeMapperService } from '../../common/chatCodeMapperService.js';
import { ChatModel } from '../../common/chatModel.js';
import { IChatService } from '../../common/chatService.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolInvocationPresentation, ToolProgress } from '../../common/languageModelToolsService.js';

export const ExtensionEditToolId = 'vscode_editFile';
export const InternalEditToolId = 'vscode_editFile_internal';
export const EditToolData: IToolData = {
	id: InternalEditToolId,
	displayName: '', // not used
	modelDescription: 'REQUIRED: Always provide clear, descriptive changelog information. Subject: REQUIRED, 4-10 words, action-oriented (e.g., "Add user authentication module", "Fix memory leak in data processing", "Refactor database connection handling"). Description: REQUIRED, 2-5 sentences explaining what changed and why. UNACCEPTABLE subjects: "Update file", "Make changes", "Fix code", "Edit file" - these are too vague. GOOD examples: "Add error handling for network requests", "Fix race condition in async operations", "Refactor authentication to use JWT tokens". Use the explanation parameter for full context, and provide a clear subject and description for high-quality changelog entries.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	// Note: inputSchema is not defined here as this is an internal tool.
	// The schema is provided by the language model/agent.
	//
	// IMPORTANT: This is the PREFERRED method for making file edits. Agents should:
	// - Use EditTool for all file modifications (rather than streaming textEdit progress)
	// - Always provide the 'explanation' parameter with a full description of the change
	// - Optionally provide a 'subject' parameter with a short 5-6 word one-liner for the changelog subject
	//   If subject is not provided, it will be extracted from the explanation
	// - This ensures reliable changelog tracking with proper subject/description
	//
	// The agent MUST provide the 'explanation' parameter. The 'subject' parameter is optional but recommended.
};

export interface EditToolParams {
	uri: UriComponents;
	explanation: string; // Required: Full description of the change
	subject?: string; // Optional: Short subject (5–8 words)
	description?: string; // Optional: Concise 2–4 line description; preferred for changelog
	code: string;
	// Enhanced parameters for better edit accuracy
	contextFiles?: Array<{
		uri: UriComponents;
		content: string;
		relevance?: 'high' | 'medium' | 'low';
	}>; // Optional: Related files for context (imports, dependencies, etc.)
	editType?: 'replace' | 'insert' | 'delete' | 'modify'; // Optional: Type of edit operation
	anchorContext?: {
		lineNumber?: number; // Optional: Target line number for the edit
		beforeText?: string; // Optional: Text that should appear before the edit
		afterText?: string; // Optional: Text that should appear after the edit
	}; // Optional: Anchor context for precise edit placement
}

export class EditTool implements IToolImpl {

	constructor(
		@IChatService private readonly chatService: IChatService,
		@ICodeMapperService private readonly codeMapperService: ICodeMapperService,
		@INotebookService private readonly notebookService: INotebookService,
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		if (!invocation.context) {
			throw new Error('toolInvocationToken is required for this tool');
		}

		const parameters = invocation.parameters as EditToolParams;
		const fileUri = URI.revive(parameters.uri);
		const uri = CellUri.parse(fileUri)?.notebook || fileUri;

		const model = this.chatService.getSession(invocation.context?.sessionId) as ChatModel;
		const request = model.getRequests().at(-1)!;

		model.acceptResponseProgress(request, {
			kind: 'markdownContent',
			content: new MarkdownString('\n````\n')
		});
		model.acceptResponseProgress(request, {
			kind: 'codeblockUri',
			uri,
			isEdit: true
		});
		model.acceptResponseProgress(request, {
			kind: 'markdownContent',
			content: new MarkdownString('\n````\n')
		});
		// Signal start.
		if (this.notebookService.hasSupportedNotebooks(uri) && (this.notebookService.getNotebookTextModel(uri))) {
			model.acceptResponseProgress(request, {
				kind: 'notebookEdit',
				edits: [],
				uri
			});
		} else {
			model.acceptResponseProgress(request, {
				kind: 'textEdit',
				edits: [],
				uri
			});
		}

		const editSession = model.editingSession;
		if (!editSession) {
			throw new Error('This tool must be called from within an editing session');
		}

		// Store the explanation, subject, and description for later retrieval when edits are accepted
		console.log('[MonitorX] EditTool.invoke: PREFERRED PATH - Using EditTool for edits', {
			hasExplanation: !!parameters.explanation,
			hasSubject: !!parameters.subject,
			hasDescription: !!parameters.description,
			explanationType: typeof parameters.explanation,
			explanationLength: typeof parameters.explanation === 'string' ? parameters.explanation.length : 0,
			explanationPreview: typeof parameters.explanation === 'string' ? parameters.explanation.substring(0, 100) : undefined,
			subjectPreview: typeof parameters.subject === 'string' ? parameters.subject : undefined,
			descriptionPreview: typeof parameters.description === 'string' ? parameters.description.substring(0, 120) : undefined,
			uri: uri.toString(),
			requestId: model.getRequests().at(-1)?.id,
			allParams: Object.keys(parameters)
		});
		if (parameters.explanation) {
			const request = model.getRequests().at(-1)!;
			editSession.storeEditExplanation(request.id, uri, parameters.explanation, parameters.subject, parameters.description);
		} else {
			console.warn('[MonitorX] EditTool.invoke: No explanation parameter provided', {
				uri: uri.toString(),
				parametersKeys: Object.keys(parameters),
				parameters: parameters
			});
		}

		const codeMapper = this.codeMapperService.providers[0];
		if (!codeMapper) {
			// Fallback to direct insertion when no code mapper is available
			// Create a text edit that replaces the entire file content with the new code
			const textEdit: TextEdit = {
				range: new Range(1, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
				text: parameters.code
			};

			if (this.notebookService.hasSupportedNotebooks(uri) && (this.notebookService.getNotebookTextModel(uri))) {
				// For notebooks, we need to handle differently - but for now, just send as text edit
				// The notebook handling will be done by the editing session
				model.acceptResponseProgress(request, { kind: 'notebookEdit', uri, edits: [], done: false });
				model.acceptResponseProgress(request, { kind: 'textEdit', uri: uri, edits: [textEdit], done: false });
				model.acceptResponseProgress(request, { kind: 'notebookEdit', uri, edits: [], done: true });
			} else {
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [textEdit], done: false });
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
			}
		} else {
			// Use code mapper when available
			// Note: contextFiles are available in parameters but not yet used by code mapper
			// They can be used for future enhancements like cross-file awareness
			const result = await this.codeMapperService.mapCode({
				codeBlocks: [{
					code: parameters.code,
					resource: uri,
					markdownBeforeBlock: parameters.explanation,
					editType: parameters.editType,
					anchorContext: parameters.anchorContext,
				}],
				location: 'tool',
				chatRequestId: invocation.chatRequestId,
				chatRequestModel: invocation.modelId,
				chatSessionId: invocation.context.sessionId,
			}, {
				textEdit: (target, edits) => {
					model.acceptResponseProgress(request, { kind: 'textEdit', uri: target, edits });
				},
				notebookEdit(target, edits) {
					model.acceptResponseProgress(request, { kind: 'notebookEdit', uri: target, edits });
				},
			}, token);

			// Signal end.
			if (this.notebookService.hasSupportedNotebooks(uri) && (this.notebookService.getNotebookTextModel(uri))) {
				model.acceptResponseProgress(request, { kind: 'notebookEdit', uri, edits: [], done: true });
			} else {
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
			}

			if (result?.errorMessage) {
				throw new Error(result.errorMessage);
			}
		}

		let dispose: IDisposable;
		await new Promise((resolve) => {
			// The file will not be modified until the first edits start streaming in,
			// so wait until we see that it _was_ modified before waiting for it to be done.
			let wasFileBeingModified = false;

			dispose = autorun((r) => {

				const entries = editSession.entries.read(r);
				const currentFile = entries?.find((e) => e.modifiedURI.toString() === uri.toString());
				if (currentFile) {
					if (currentFile.isCurrentlyBeingModifiedBy.read(r)) {
						wasFileBeingModified = true;
					} else if (wasFileBeingModified) {
						resolve(true);
					}
				}
			});
		}).finally(() => {
			dispose.dispose();
		});

		return {
			content: [{ kind: 'text', value: 'The file was edited successfully' }]
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			presentation: ToolInvocationPresentation.Hidden
		};
	}
}
