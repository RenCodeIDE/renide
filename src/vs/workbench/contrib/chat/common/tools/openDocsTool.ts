/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const OpenDocsToolId = 'vscode_openDocs';
const DOCS_VIEW_ID = 'workbench.view.renDocs.main';

export const OpenDocsToolData: IToolData = {
	id: OpenDocsToolId,
	toolReferenceName: 'openDocs',
	displayName: localize('openDocsTool.displayName', 'Open Documentation'),
	modelDescription: localize('openDocsTool.modelDescription', 'Opens the documentation panel in the sidebar and displays AI-generated documentation for a specific file. The docs panel opens without obstructing the main editor view, making it perfect for showing documentation alongside code.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: localize('openDocsTool.filePath', 'The file path to show documentation for. Can be absolute or workspace-relative.')
			}
		},
		required: ['filePath'],
		additionalProperties: false
	}
};

export interface IOpenDocsToolParams {
	filePath: string;
}

export class OpenDocsTool implements IToolImpl {
	constructor(
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IOpenDocsToolParams;

		return {
			invocationMessage: localize('openDocsTool.invocationMessage', 'Opening documentation for {0}...', parameters.filePath),
			pastTenseMessage: localize('openDocsTool.pastTenseMessage', 'Opened documentation for {0}', parameters.filePath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IOpenDocsToolParams;

		if (!args.filePath) {
			return {
				content: [{
					kind: 'text',
					value: localize('openDocsTool.missingPath', 'File path is required')
				}],
				toolResultMessage: localize('openDocsTool.error', 'Failed to open docs: missing path')
			};
		}

		try {
			// Parse the file path to URI
			const fileUri = this.parseFilePath(args.filePath);

			// Open the docs view
			const view = await this.viewsService.openView(DOCS_VIEW_ID, true);
			
			if (!view) {
				return {
					content: [{
						kind: 'text',
						value: localize('openDocsTool.noDocsView', 'Documentation view is not available')
					}],
					toolResultMessage: localize('openDocsTool.error', 'Documentation view not available')
				};
			}

			// Call renderFileDocs if available
			if (typeof (view as any).renderFileDocs === 'function') {
				await (view as any).renderFileDocs(fileUri);
			}

			const message = localize('openDocsTool.success', 'Opened documentation for {0}', args.filePath);

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
					value: localize('openDocsTool.error', 'Error opening documentation: {0}', errorMessage)
				}],
				toolResultMessage: localize('openDocsTool.error', 'Error opening documentation: {0}', errorMessage)
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
