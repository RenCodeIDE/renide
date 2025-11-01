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
	modelDescription: '', // Not used
	source: ToolDataSource.Internal,
};

export interface EditToolParams {
	uri: UriComponents;
	explanation: string;
	code: string;
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
			const result = await this.codeMapperService.mapCode({
				codeBlocks: [{ code: parameters.code, resource: uri, markdownBeforeBlock: parameters.explanation }],
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
