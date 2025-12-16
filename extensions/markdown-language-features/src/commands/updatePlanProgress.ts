/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command } from '../commandManager';
import { MarkdownPreviewManager } from '../preview/previewManager';
import { ToWebviewMessage } from '../../types/previewMessaging';

export class UpdatePlanProgressCommand implements Command {
	public readonly id = 'markdown.updatePlanProgress';

	constructor(
		private readonly _previewManager: MarkdownPreviewManager
	) { }

	public execute(uri: string, progress: number, completedTodos: number, totalTodos: number, status?: 'not-started' | 'starting' | 'in-progress' | 'completed' | 'failed', todos?: Array<{ id: string; text: string; status: string }>) {
		const resource = vscode.Uri.parse(uri);
		const preview = this._previewManager.findPreview(resource);

		if (preview) {
			const message: ToWebviewMessage.UpdatePlanProgress = {
				type: 'updatePlanProgress',
				source: resource.toString(),
				progress,
				completedTodos,
				totalTodos,
				status,
				todos
			};
			preview.postMessage(message);
		}
	}
}

