/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from '../../common/languageModelToolsService.js';

export const CheckLinterToolData: IToolData = {
	id: 'check_linter',
	toolReferenceName: 'checkLinter',
	displayName: localize('checkLinterTool.displayName', 'Check Linter'),
	modelDescription: localize(
		'checkLinterTool.modelDescription',
		'Checks for linter errors, warnings, and other diagnostics in files. Returns detailed information about each issue including file path, line number, column, severity, message, and source. Use this tool after editing files to verify correctness and identify issues that need to be fixed.'
	),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: localize(
					'checkLinterTool.path',
					'Optional: Specific file path or URI to check. If not provided, returns all errors in the workspace (limited to top 20).'
				),
			},
			severity: {
				type: 'string',
				enum: ['Error', 'Warning', 'Info'],
				description: localize(
					'checkLinterTool.severity',
					'Optional: Filter by severity level. Defaults to "Error" if not specified.'
				),
			},
		},
		required: [],
	},
};

export interface ICheckLinterToolInput {
	path?: string;
	severity?: 'Error' | 'Warning' | 'Info';
}

export class CheckLinterTool implements IToolImpl {
	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) {}

	async prepareToolInvocation(
		context: IToolInvocationPreparationContext,
		token: CancellationToken
	): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ICheckLinterToolInput;
		const target = args.path || localize('checkLinterTool.allFiles', 'all files');
		return {
			invocationMessage: localize(
				'checkLinterTool.invocationMessage',
				'Checking linter diagnostics for: {0}',
				target
			),
			pastTenseMessage: localize(
				'checkLinterTool.pastTenseMessage',
				'Checked linter diagnostics for: {0}',
				target
			),
		};
	}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		token: CancellationToken
	): Promise<IToolResult> {
		const args = invocation.parameters as ICheckLinterToolInput;

		try {
			// Determine severity filter
			let severityFilter: number | undefined;
			if (args.severity) {
				switch (args.severity) {
					case 'Error':
						severityFilter = MarkerSeverity.Error;
						break;
					case 'Warning':
						severityFilter = MarkerSeverity.Warning;
						break;
					case 'Info':
						severityFilter = MarkerSeverity.Info;
						break;
				}
			} else {
				// Default to Error if not specified
				severityFilter = MarkerSeverity.Error;
			}

			let markers: import('../../../../../platform/markers/common/markers.js').IMarker[];

			if (args.path) {
				// Check specific file
				const uri = this.parseUri(args.path);
				markers = this.markerService.read({
					resource: uri,
					severities: severityFilter,
				});
			} else {
				// Check all files in workspace (limited to top 20)
				markers = this.markerService.read({
					severities: severityFilter,
					take: 20,
				});
			}

			if (markers.length === 0) {
				const severityText = args.severity || 'Error';
				const pathText = args.path || localize('checkLinterTool.workspace', 'workspace');
				return {
					content: [
						{
							kind: 'text',
							value: localize(
								'checkLinterTool.noIssues',
								'No {0} issues found in {1}.',
								severityText.toLowerCase(),
								pathText
							),
						},
					],
					toolResultMessage: localize(
						'checkLinterTool.noIssues',
						'No {0} issues found in {1}.',
						severityText.toLowerCase(),
						pathText
					),
				};
			}

			// Format markers for output
			const workspace = this.workspaceService.getWorkspace();
			const formattedIssues = markers.map((marker) => {
				const relativePath =
					workspace.folders.length > 0
						? this.getRelativePath(marker.resource, workspace.folders[0].uri)
						: marker.resource.fsPath;
				const severityName = MarkerSeverity.toString(marker.severity);
				const source = marker.source ? ` (${marker.source})` : '';
				const code = marker.code
					? typeof marker.code === 'string'
						? ` [${marker.code}]`
						: ` [${marker.code.value}]`
					: '';

				return `[${relativePath}] [${marker.startLineNumber}:${marker.startColumn}] [${severityName}]${code} ${marker.message}${source}`;
			});

			const summary = localize(
				'checkLinterTool.summary',
				'Found {0} issue(s):',
				markers.length
			);
			const output = [summary, '', ...formattedIssues].join('\n');

			return {
				content: [
					{
						kind: 'text',
						value: output,
					},
				],
				toolResultMessage: localize(
					'checkLinterTool.foundIssues',
					'Found {0} issue(s)',
					markers.length
				),
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: localize('checkLinterTool.unknownError', 'Unknown error occurred');
			return {
				content: [
					{
						kind: 'text',
						value: localize('checkLinterTool.error', 'Error checking linter: {0}', message),
					},
				],
				toolResultMessage: localize('checkLinterTool.error', 'Error checking linter: {0}', message),
			};
		}
	}

	private parseUri(pathOrUri: string): URI {
		try {
			// Try parsing as URI first
			if (pathOrUri.includes('://') || pathOrUri.startsWith('file://')) {
				return URI.parse(pathOrUri);
			}

			// If it's a relative path, try to resolve it relative to workspace
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri;
				// Check if it's already an absolute path
				if (pathOrUri.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(pathOrUri))) {
					return URI.file(pathOrUri);
				}
				// Relative path - resolve against workspace root
				return URI.joinPath(workspaceRoot, pathOrUri);
			}

			// Fallback to file URI
			return URI.file(pathOrUri);
		} catch {
			// If parsing fails, try as file path
			return URI.file(pathOrUri);
		}
	}

	private getRelativePath(uri: URI, workspaceRoot: URI): string {
		const rootPath = workspaceRoot.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, '');
		}

		return uri.fsPath;
	}
}

