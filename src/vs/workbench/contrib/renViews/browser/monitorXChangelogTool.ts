/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IToolImpl, IToolInvocation, IToolResult } from '../../chat/common/languageModelToolsService.js';
import { IToolData, ToolDataSource } from '../../chat/common/languageModelToolsService.js';
import { IRenMonitorXChangelogBuffer } from '../common/renChangelogBuffer.js';

export class MonitorXLogDraftTool implements IToolImpl {
	static readonly ID = 'monitorx.logDraft';

	static readonly DEFINITION: IToolData = {
		id: MonitorXLogDraftTool.ID,
		toolReferenceName: 'monitorx.logDraft',
		displayName: 'MonitorX Log Draft',
		modelDescription: 'Stages or updates a MonitorX changelog draft for the current editing session. Provide the subject, description, and file diffs that summarize the proposed changes.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		tags: ['monitorx'],
		inputSchema: {
			type: 'object',
			properties: {
				targetUri: { type: 'string', description: 'URI of the file being edited' },
				subject: { type: 'string', description: 'Short subject summarizing the change' },
				description: { type: 'string', description: 'Detailed description of the change' },
				files: {
					type: 'array',
					description: 'Array of file changes with path and diff',
					items: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Relative path to the file' },
							diff: { type: 'string', description: 'Unified diff string' }
						},
						required: ['path']
					}
				},
				graph: {
					type: 'object',
					description: 'Optional graph information',
					properties: {
						uri: { type: 'string', description: 'URI of the graph node' },
						summary: { type: 'string', description: 'Summary of the graph node' }
					}
				},
				metadata: {
					type: 'object',
					description: 'Optional metadata object'
				}
			},
			required: ['subject', 'description', 'files']
		}
	};

	constructor(
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer
	) { }

	async invoke(invocation: IToolInvocation, countTokens: unknown, progress: unknown, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as any;
		const sessionId = invocation.context?.sessionId;

		if (!sessionId) {
			throw new Error('Session ID is required for logging a draft.');
		}
		
		// Validate input
		if (!params.subject || !params.description || !Array.isArray(params.files) || params.files.length === 0) {
			throw new Error('Missing required parameters: subject, description, and at least one file change are required.');
		}

		try {
			// Use updateDraft to merge or create if not exists, or setDraft for full overwrite.
			// Given the tool description "Stages or updates", and inputs usually being complete, setDraft might be safer to ensure state matches model intent.
			// However, updateDraft allows partial updates if we supported them. The schema requires all fields though.
			// Let's use setDraft to align with "logging" a complete draft state.
			const draft = this.changelogBuffer.setDraft(sessionId, {
				subject: params.subject,
				description: params.description,
				files: params.files,
				graph: params.graph,
				metadata: params.metadata,
				updatedAt: Date.now()
			});

			return {
				content: [{ kind: 'text', value: `Successfully staged changelog draft for session ${sessionId}: "${draft.subject}"` }]
			};
		} catch (error) {
			return {
				content: [{ kind: 'text', value: `Failed to log changelog draft: ${error instanceof Error ? error.message : String(error)}` }]
			};
		}
	}
}

