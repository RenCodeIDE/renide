/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IToolImpl, IToolInvocation, IToolResult, IToolData, ToolDataSource } from '../../chat/common/languageModelToolsService.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from '../common/renWorkspaceStore.js';
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraft } from '../common/renChangelogBuffer.js';
import { IMonitorXChangelogFilter } from '../common/renChangelogFilter.js';

export class MonitorXSearchChangelogTool implements IToolImpl {
	static readonly ID = 'monitorx.searchChangelog';

	static readonly DEFINITION: IToolData = {
		id: MonitorXSearchChangelogTool.ID,
		toolReferenceName: 'monitorx.searchChangelog',
		displayName: 'MonitorX Search Changelog',
		modelDescription: 'Search and filter changelog entries (confirmed and/or pending). Returns summaries without diffs. Use monitorx.getChangelogDetails to get full details with diffs.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		tags: ['monitorx'],
		inputSchema: {
			type: 'object',
			properties: {
				type: { type: 'string', enum: ['confirmed', 'pending', 'both'], description: 'Type of entries to search' },
				text: { type: 'string', description: 'Search text in subject and description' },
				filePath: { type: 'string', description: 'Filter by file path (partial match)' },
				fromDate: { type: 'number', description: 'Start timestamp' },
				toDate: { type: 'number', description: 'End timestamp' },
				limit: { type: 'number', description: 'Maximum number of results (max 50)' }
			}
		}
	};

	constructor(
		@IRenWorkspaceStore private readonly renWorkspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer
	) { }

	async invoke(invocation: IToolInvocation, countTokens: unknown, progress: unknown, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as any;
		const filter: IMonitorXChangelogFilter = {
			text: params.text,
			filePath: params.filePath,
			fromDate: params.fromDate,
			toDate: params.toDate
		};

		const type = params.type || 'both';
		let results: Array<{
			id: string;
			type: 'confirmed' | 'pending';
			timestamp: string;
			subject: string;
			description: string;
			fileCount: number;
			files: string[];
		}> = [];

		if (type === 'confirmed' || type === 'both') {
			const entries = await this.renWorkspaceStore.getAllChangelogEntries(filter);
			results = results.concat(entries.map(e => ({
				id: e.id,
				type: 'confirmed',
				timestamp: new Date(e.timestamp).toISOString(),
				subject: e.subject,
				description: e.description,
				fileCount: e.files.length,
				files: e.files.map(f => f.path)
			})));
		}

		if (type === 'pending' || type === 'both') {
			const drafts = this.changelogBuffer.listDrafts(filter);
			results = results.concat(drafts.map(d => ({
				id: d.sessionId, // Use sessionId as ID for drafts
				type: 'pending',
				timestamp: new Date(d.updatedAt).toISOString(),
				subject: d.subject,
				description: d.description,
				fileCount: d.files.length,
				files: d.files.map(f => f.path)
			})));
		}

		// Sort combined results by timestamp desc
		results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		const limit = Math.min(params.limit || 50, 50);
		const limitedResults = results.slice(0, limit);

		return {
			content: [{ kind: 'text', value: JSON.stringify(limitedResults, null, 2) }]
		};
	}
}

export class MonitorXGetChangelogDetailsTool implements IToolImpl {
	static readonly ID = 'monitorx.getChangelogDetails';

	static readonly DEFINITION: IToolData = {
		id: MonitorXGetChangelogDetailsTool.ID,
		toolReferenceName: 'monitorx.getChangelogDetails',
		displayName: 'MonitorX Get Changelog Details',
		modelDescription: 'Get full details including diffs for specific changelog entry IDs. Use monitorx.searchChangelog first to find entry IDs.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		tags: ['monitorx'],
		inputSchema: {
			type: 'object',
			properties: {
				ids: { type: 'array', items: { type: 'string' }, description: 'Array of entry IDs to retrieve' }
			},
			required: ['ids']
		}
	};

	constructor(
		@IRenWorkspaceStore private readonly renWorkspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer
	) { }

	async invoke(invocation: IToolInvocation, countTokens: unknown, progress: unknown, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as any;
		if (!Array.isArray(params.ids) || params.ids.length === 0) {
			throw new Error('ids parameter must be a non-empty array of strings');
		}

		const ids = new Set(params.ids);
		const details: Array<IMonitorXChangelogEntry | (IMonitorXChangelogDraft & { id: string; type: 'pending' })> = [];

		// Check store
		const allEntries = await this.renWorkspaceStore.getAllChangelogEntries();
		for (const entry of allEntries) {
			if (ids.has(entry.id)) {
				details.push(entry);
				ids.delete(entry.id);
			}
		}

		// Check buffer (if any IDs remaining)
		if (ids.size > 0) {
			const allDrafts = this.changelogBuffer.listDrafts();
			for (const draft of allDrafts) {
				if (ids.has(draft.sessionId)) {
					details.push({
						...draft,
						id: draft.sessionId,
						type: 'pending'
					} as any);
					ids.delete(draft.sessionId);
				}
			}
		}

		if (details.length === 0) {
			return { content: [{ kind: 'text', value: 'No entries found for the provided IDs.' }] };
		}

		return {
			content: [{ kind: 'text', value: JSON.stringify(details, null, 2) }]
		};
	}
}

export class MonitorXGetRecentChangelogTool implements IToolImpl {
	static readonly ID = 'monitorx.getRecentChangelog';

	static readonly DEFINITION: IToolData = {
		id: MonitorXGetRecentChangelogTool.ID,
		toolReferenceName: 'monitorx.getRecentChangelog',
		displayName: 'MonitorX Get Recent Changelog',
		modelDescription: 'Get the most recent confirmed changelog entries. Returns summaries without diffs.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		tags: ['monitorx'],
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Number of recent entries (max 50, default: 10)' }
			}
		}
	};

	constructor(@IRenWorkspaceStore private readonly renWorkspaceStore: IRenWorkspaceStore) { }

	async invoke(invocation: IToolInvocation, countTokens: unknown, progress: unknown, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as any;
		const limit = Math.min(params.limit || 10, 50);
		const recent = await this.renWorkspaceStore.getRecentChangelogEntries(limit);

		const summaries = recent.map(e => ({
			id: e.id,
			timestamp: new Date(e.timestamp).toISOString(),
			subject: e.subject,
			description: e.description,
			fileCount: e.files.length,
			files: e.files.map(f => f.path)
		}));

		return {
			content: [{ kind: 'text', value: JSON.stringify(summaries, null, 2) }]
		};
	}
}

export class MonitorXGetChangelogStatsTool implements IToolImpl {
	static readonly ID = 'monitorx.getChangelogStats';

	static readonly DEFINITION: IToolData = {
		id: MonitorXGetChangelogStatsTool.ID,
		toolReferenceName: 'monitorx.getChangelogStats',
		displayName: 'MonitorX Get Changelog Stats',
		modelDescription: 'Get aggregated statistics about changelog entries including file frequency, activity patterns, and metadata breakdowns.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		tags: ['monitorx'],
		inputSchema: {
			type: 'object',
			properties: {
				fromDate: { type: 'number', description: 'Start timestamp' },
				toDate: { type: 'number', description: 'End timestamp' },
				filePath: { type: 'string', description: 'Filter by file path' }
			}
		}
	};

	constructor(@IRenWorkspaceStore private readonly renWorkspaceStore: IRenWorkspaceStore) { }

	async invoke(invocation: IToolInvocation, countTokens: unknown, progress: unknown, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as any;
		const filter: IMonitorXChangelogFilter = {
			fromDate: params.fromDate,
			toDate: params.toDate,
			filePath: params.filePath
		};

		const entries = await this.renWorkspaceStore.getAllChangelogEntries(filter);

		// Calculate stats
		const fileFrequency: Record<string, number> = {};
		let totalFilesChanged = 0;

		for (const entry of entries) {
			for (const file of entry.files) {
				fileFrequency[file.path] = (fileFrequency[file.path] || 0) + 1;
				totalFilesChanged++;
			}
		}

		// Top 10 active files
		const topFiles = Object.entries(fileFrequency)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([path, count]) => ({ path, count }));

		const stats = {
			totalEntries: entries.length,
			totalFilesChanged,
			dateRange: {
				from: params.fromDate ? new Date(params.fromDate).toISOString() : 'earliest',
				to: params.toDate ? new Date(params.toDate).toISOString() : 'latest'
			},
			topFiles
		};

		return {
			content: [{ kind: 'text', value: JSON.stringify(stats, null, 2) }]
		};
	}
}

