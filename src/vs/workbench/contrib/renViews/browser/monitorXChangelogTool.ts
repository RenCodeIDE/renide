/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CountTokensCallback, ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../chat/common/languageModelToolsService.js';
import { IRenMonitorXChangelogBuffer } from '../common/renChangelogBuffer.js';

interface IMonitorXLogDraftToolParams {
	targetUri: string;
	subject: string;
	description: string;
	files: ReadonlyArray<{ path: string; diff: string }>;
	graph?: { uri?: string; summary?: string };
	metadata?: Record<string, unknown>;
}

export class MonitorXChangelogToolContribution extends Disposable {
	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IRenMonitorXChangelogBuffer monitorxBuffer: IRenMonitorXChangelogBuffer,
	) {
		super();
		const tool = new MonitorXLogDraftTool(monitorxBuffer);
		this._register(toolsService.registerTool(MonitorXLogDraftTool.DEFINITION, tool));
	}
}

class MonitorXLogDraftTool implements IToolImpl {
	public static readonly ID = 'monitorx.logDraft';
	public static readonly DEFINITION: IToolData = {
		id: MonitorXLogDraftTool.ID,
		toolReferenceName: 'monitorx.logDraft',
		canBeReferencedInPrompt: true,
		displayName: localize('monitorxChangelogTool.displayName', "Stage MonitorX changelog draft"),
		modelDescription: localize('monitorxChangelogTool.modelDescription', "Stages or updates a MonitorX changelog draft for the current editing session. Provide the subject, description, and file diffs that summarize the proposed changes."),
		userDescription: localize('monitorxChangelogTool.userDescription', "Stage a MonitorX changelog draft"),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: 'object',
			required: ['targetUri', 'subject', 'description', 'files'],
			properties: {
				targetUri: {
					type: 'string',
					description: localize('monitorxChangelogTool.targetUri', "URI of the file being edited. Use the same URI returned by the code-edit tool."),
				},
				subject: {
					type: 'string',
					description: localize('monitorxChangelogTool.subject', "Short subject summarizing the change."),
				},
				description: {
					type: 'string',
					description: localize('monitorxChangelogTool.description', "Detailed description of the change."),
				},
				files: {
					type: 'array',
					items: {
						type: 'object',
						required: ['path', 'diff'],
						properties: {
							path: {
								type: 'string',
								description: localize('monitorxChangelogTool.filePath', "Workspace-relative or absolute path of the file."),
							},
							diff: {
								type: 'string',
								description: localize('monitorxChangelogTool.diff', "Unified diff representing the changes."),
							},
						},
					},
				},
				graph: {
					type: 'object',
					properties: {
						uri: { type: 'string' },
						summary: { type: 'string' }
					}
				},
				metadata: {
					type: 'object',
					description: localize('monitorxChangelogTool.metadata', "Optional metadata object to include extra key-value pairs."),
				}
			}
		},
	};

	constructor(
		private readonly _changelogBuffer: IRenMonitorXChangelogBuffer,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const ctxSession = invocation.context?.sessionId;
		if (!ctxSession) {
			return {
				content: [{ kind: 'text', value: localize('monitorxChangelogTool.noSession', "Unable to stage MonitorX changelog draft because the editing session could not be determined.") }],
				toolResultError: localize('monitorxChangelogTool.noSession.error', 'Missing editing session context for MonitorX changelog tool'),
			};
		}

		const params = invocation.parameters as Partial<IMonitorXLogDraftToolParams>;
		const targetUri = typeof params?.targetUri === 'string' ? params.targetUri.trim() : '';
		const subject = typeof params?.subject === 'string' ? params.subject.trim() : '';
		const description = typeof params?.description === 'string' ? params.description.trim() : '';
		const filesInput = Array.isArray(params?.files) ? params.files : [];

		const normalizedFiles = filesInput
			.map(file => (file && typeof file === 'object') ? { path: String(file.path ?? '').trim(), diff: String(file.diff ?? '') } : { path: '', diff: '' })
			.filter(file => !!file.path);

		if (!targetUri || !subject || !normalizedFiles.length) {
			return {
				content: [{ kind: 'text', value: localize('monitorxChangelogTool.invalidInput', "MonitorX changelog tool requires targetUri, subject, and at least one file change.") }],
				toolResultError: localize('monitorxChangelogTool.invalidInput.error', 'MonitorX changelog tool missing required parameters'),
			};
		}

		const graphRecord = params?.graph && typeof params.graph === 'object' ? {
			uri: typeof params.graph.uri === 'string' ? params.graph.uri : undefined,
			summary: typeof params.graph.summary === 'string' ? params.graph.summary : undefined,
		} : undefined;
		const metadataRecord = params?.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
			? params.metadata as Record<string, unknown>
			: undefined;

		const draftKey = `${ctxSession}:${targetUri}`;
		const existing = this._changelogBuffer.getDraft(draftKey);

		const seed = {
			subject,
			description,
			files: normalizedFiles,
			...(graphRecord ? { graph: graphRecord } : {}),
			...(metadataRecord ? { metadata: metadataRecord } : {}),
			createdAt: existing?.createdAt,
			updatedAt: Date.now()
		};

		this._changelogBuffer.setDraft(draftKey, seed);

		return {
			content: [{ kind: 'text', value: localize('monitorxChangelogTool.success', "MonitorX pending changelog updated for {0}.", targetUri) }],
		};
	}
}

