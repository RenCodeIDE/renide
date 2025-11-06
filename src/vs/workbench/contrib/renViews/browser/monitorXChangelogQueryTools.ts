/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CountTokensCallback, ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../chat/common/languageModelToolsService.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from '../common/renWorkspaceStore.js';
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraft } from '../common/renChangelogBuffer.js';
import { IMonitorXChangelogFilter } from '../common/renChangelogFilter.js';

const MAX_RESULTS = 50;

function isConfirmedEntry(entry: IMonitorXChangelogEntry | IMonitorXChangelogDraft): entry is IMonitorXChangelogEntry {
	return 'timestamp' in entry && typeof (entry as IMonitorXChangelogEntry).timestamp === 'number';
}

function parseDate(dateInput: string | number | undefined): number | undefined {
	if (dateInput === undefined || dateInput === null) {
		return undefined;
	}
	if (typeof dateInput === 'number') {
		return dateInput;
	}
	if (typeof dateInput !== 'string') {
		return undefined;
	}
	const trimmed = dateInput.trim();
	if (!trimmed) {
		return undefined;
	}
	const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/);
	if (isoMatch) {
		const date = new Date(trimmed);
		return isNaN(date.getTime()) ? undefined : date.getTime();
	}
	const relativeMatch = trimmed.match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)\s*ago$/i);
	if (relativeMatch) {
		const amount = parseInt(relativeMatch[1], 10);
		const unit = relativeMatch[2].toLowerCase();
		const now = Date.now();
		let ms = 0;
		if (unit === 'day' || unit === 'days') {
			ms = amount * 24 * 60 * 60 * 1000;
		} else if (unit === 'week' || unit === 'weeks') {
			ms = amount * 7 * 24 * 60 * 60 * 1000;
		} else if (unit === 'month' || unit === 'months') {
			ms = amount * 30 * 24 * 60 * 60 * 1000;
		} else if (unit === 'year' || unit === 'years') {
			ms = amount * 365 * 24 * 60 * 60 * 1000;
		}
		return now - ms;
	}
	if (trimmed.toLowerCase() === 'last week') {
		return Date.now() - (7 * 24 * 60 * 60 * 1000);
	}
	if (trimmed.toLowerCase() === 'last month') {
		return Date.now() - (30 * 24 * 60 * 60 * 1000);
	}
	const parsed = new Date(trimmed);
	return isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function formatEntrySummary(entry: IMonitorXChangelogEntry | IMonitorXChangelogDraft, type: 'confirmed' | 'pending'): {
	id: string;
	subject: string;
	description: string;
	timestamp: string;
	files: Array<{ path: string; hasDiff: boolean }>;
	metadata?: Record<string, unknown>;
	type: 'confirmed' | 'pending';
} {
	const timestamp = isConfirmedEntry(entry) ? entry.timestamp : entry.updatedAt;
	return {
		id: isConfirmedEntry(entry) ? entry.id : entry.sessionId,
		subject: entry.subject,
		description: entry.description,
		timestamp: formatTimestamp(timestamp),
		files: entry.files.map(f => ({ path: f.path, hasDiff: !!f.diff })),
		metadata: entry.metadata,
		type
	};
}

function formatEntryDetail(entry: IMonitorXChangelogEntry | IMonitorXChangelogDraft, type: 'confirmed' | 'pending'): {
	id: string;
	subject: string;
	description: string;
	timestamp: string;
	files: Array<{ path: string; diff: string }>;
	graph?: { uri?: string; summary?: string };
	metadata?: Record<string, unknown>;
	type: 'confirmed' | 'pending';
} {
	const timestamp = isConfirmedEntry(entry) ? entry.timestamp : entry.updatedAt;
	return {
		id: isConfirmedEntry(entry) ? entry.id : entry.sessionId,
		subject: entry.subject,
		description: entry.description,
		timestamp: formatTimestamp(timestamp),
		files: entry.files.map(f => ({ path: f.path, diff: f.diff })),
		graph: entry.graph,
		metadata: entry.metadata,
		type
	};
}

function buildFilter(params: {
	text?: string;
	filePath?: string;
	fromDate?: string | number;
	toDate?: string | number;
	agentId?: string;
	modelId?: string;
	command?: string;
	modeId?: string;
	minLinesAdded?: number;
	maxLinesAdded?: number;
	minLinesRemoved?: number;
	maxLinesRemoved?: number;
	minFiles?: number;
	maxFiles?: number;
}): IMonitorXChangelogFilter {
	const filter: IMonitorXChangelogFilter = {};
	if (params.text) {
		filter.text = params.text;
	}
	if (params.filePath) {
		filter.filePath = params.filePath;
	}
	const fromDate = parseDate(params.fromDate);
	if (fromDate !== undefined) {
		filter.fromDate = fromDate;
	}
	const toDate = parseDate(params.toDate);
	if (toDate !== undefined) {
		filter.toDate = toDate;
	}
	if (params.agentId) {
		filter.agentId = params.agentId;
	}
	if (params.modelId) {
		filter.modelId = params.modelId;
	}
	if (params.command) {
		filter.command = params.command;
	}
	if (params.modeId) {
		filter.modeId = params.modeId;
	}
	if (params.minLinesAdded !== undefined) {
		filter.minLinesAdded = params.minLinesAdded;
	}
	if (params.maxLinesAdded !== undefined) {
		filter.maxLinesAdded = params.maxLinesAdded;
	}
	if (params.minLinesRemoved !== undefined) {
		filter.minLinesRemoved = params.minLinesRemoved;
	}
	if (params.maxLinesRemoved !== undefined) {
		filter.maxLinesRemoved = params.maxLinesRemoved;
	}
	if (params.minFiles !== undefined) {
		filter.minFiles = params.minFiles;
	}
	if (params.maxFiles !== undefined) {
		filter.maxFiles = params.maxFiles;
	}
	return filter;
}

interface ISearchChangelogParams {
	type?: 'confirmed' | 'pending' | 'both';
	text?: string;
	filePath?: string;
	fromDate?: string | number;
	toDate?: string | number;
	agentId?: string;
	modelId?: string;
	command?: string;
	modeId?: string;
	minLinesAdded?: number;
	maxLinesAdded?: number;
	minLinesRemoved?: number;
	maxLinesRemoved?: number;
	minFiles?: number;
	maxFiles?: number;
	limit?: number;
}

interface IGetChangelogDetailsParams {
	ids: string[];
	type?: 'confirmed' | 'pending' | 'both';
}

interface IGetRecentChangelogParams {
	limit?: number;
}

interface IGetChangelogStatsParams {
	type?: 'confirmed' | 'pending' | 'both';
	fromDate?: string | number;
	toDate?: string | number;
	filePath?: string;
}

export class MonitorXChangelogQueryToolContribution extends Disposable {
	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IRenWorkspaceStore workspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer changelogBuffer: IRenMonitorXChangelogBuffer,
	) {
		super();
		const searchTool = new MonitorXSearchChangelogTool(workspaceStore, changelogBuffer);
		const detailsTool = new MonitorXGetChangelogDetailsTool(workspaceStore, changelogBuffer);
		const recentTool = new MonitorXGetRecentChangelogTool(workspaceStore);
		const statsTool = new MonitorXGetChangelogStatsTool(workspaceStore, changelogBuffer);
		this._register(toolsService.registerTool(MonitorXSearchChangelogTool.DEFINITION, searchTool));
		this._register(toolsService.registerTool(MonitorXGetChangelogDetailsTool.DEFINITION, detailsTool));
		this._register(toolsService.registerTool(MonitorXGetRecentChangelogTool.DEFINITION, recentTool));
		this._register(toolsService.registerTool(MonitorXGetChangelogStatsTool.DEFINITION, statsTool));
	}
}

class MonitorXSearchChangelogTool implements IToolImpl {
	public static readonly ID = 'monitorx.searchChangelog';
	public static readonly DEFINITION: IToolData = {
		id: MonitorXSearchChangelogTool.ID,
		toolReferenceName: 'monitorx.searchChangelog',
		canBeReferencedInPrompt: true,
		displayName: localize('monitorxSearchChangelogTool.displayName', "Search MonitorX changelog"),
		modelDescription: localize('monitorxSearchChangelogTool.modelDescription', "Search and filter changelog entries (confirmed and/or pending). Returns summaries without diffs. Use monitorx.getChangelogDetails to get full details with diffs."),
		userDescription: localize('monitorxSearchChangelogTool.userDescription', "Search MonitorX changelog"),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: 'object',
			properties: {
				type: {
					type: 'string',
					enum: ['confirmed', 'pending', 'both'],
					description: localize('monitorxSearchChangelogTool.type', "Type of changelog to search: 'confirmed', 'pending', or 'both' (default: 'both')"),
				},
				text: {
					type: 'string',
					description: localize('monitorxSearchChangelogTool.text', "Search text in subject and description"),
				},
				filePath: {
					type: 'string',
					description: localize('monitorxSearchChangelogTool.filePath', "Filter by file path (partial match)"),
				},
				fromDate: {
					type: ['string', 'number'],
					description: localize('monitorxSearchChangelogTool.fromDate', "Start date (ISO string, timestamp, or relative like '7 days ago')"),
				},
				toDate: {
					type: ['string', 'number'],
					description: localize('monitorxSearchChangelogTool.toDate', "End date (ISO string, timestamp, or relative like '7 days ago')"),
				},
				agentId: { type: 'string', description: localize('monitorxSearchChangelogTool.agentId', "Filter by agent ID") },
				modelId: { type: 'string', description: localize('monitorxSearchChangelogTool.modelId', "Filter by model ID") },
				command: { type: 'string', description: localize('monitorxSearchChangelogTool.command', "Filter by command") },
				modeId: { type: 'string', description: localize('monitorxSearchChangelogTool.modeId', "Filter by mode ID") },
				minLinesAdded: { type: 'number', description: localize('monitorxSearchChangelogTool.minLinesAdded', "Minimum lines added") },
				maxLinesAdded: { type: 'number', description: localize('monitorxSearchChangelogTool.maxLinesAdded', "Maximum lines added") },
				minLinesRemoved: { type: 'number', description: localize('monitorxSearchChangelogTool.minLinesRemoved', "Minimum lines removed") },
				maxLinesRemoved: { type: 'number', description: localize('monitorxSearchChangelogTool.maxLinesRemoved', "Maximum lines removed") },
				minFiles: { type: 'number', description: localize('monitorxSearchChangelogTool.minFiles', "Minimum number of files") },
				maxFiles: { type: 'number', description: localize('monitorxSearchChangelogTool.maxFiles', "Maximum number of files") },
				limit: {
					type: 'number',
					description: localize('monitorxSearchChangelogTool.limit', "Maximum number of results (max 50, default: return all matches up to 50)"),
				},
			},
		},
	};

	constructor(
		private readonly _workspaceStore: IRenWorkspaceStore,
		private readonly _changelogBuffer: IRenMonitorXChangelogBuffer,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as Partial<ISearchChangelogParams>;
		const type = params?.type === 'confirmed' || params?.type === 'pending' ? params.type : 'both';
		const limit = params?.limit !== undefined ? Math.min(Math.max(1, params.limit), MAX_RESULTS) : MAX_RESULTS;

		const filter = buildFilter(params);
		const results: Array<ReturnType<typeof formatEntrySummary>> = [];

		if (type === 'confirmed' || type === 'both') {
			const confirmed = await this._workspaceStore.getAllChangelogEntries(filter);
			for (const entry of confirmed) {
				results.push(formatEntrySummary(entry, 'confirmed'));
			}
		}

		if (type === 'pending' || type === 'both') {
			const pending = this._changelogBuffer.listDrafts(filter);
			for (const draft of pending) {
				results.push(formatEntrySummary(draft, 'pending'));
			}
		}

		results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		const limited = results.slice(0, limit);

		return {
			content: [{ kind: 'text', value: JSON.stringify(limited, null, 2) }],
		};
	}
}

class MonitorXGetChangelogDetailsTool implements IToolImpl {
	public static readonly ID = 'monitorx.getChangelogDetails';
	public static readonly DEFINITION: IToolData = {
		id: MonitorXGetChangelogDetailsTool.ID,
		toolReferenceName: 'monitorx.getChangelogDetails',
		canBeReferencedInPrompt: true,
		displayName: localize('monitorxGetChangelogDetailsTool.displayName', "Get MonitorX changelog entry details"),
		modelDescription: localize('monitorxGetChangelogDetailsTool.modelDescription', "Get full details including diffs for specific changelog entry IDs. Use monitorx.searchChangelog first to find entry IDs."),
		userDescription: localize('monitorxGetChangelogDetailsTool.userDescription', "Get MonitorX changelog entry details"),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: 'object',
			required: ['ids'],
			properties: {
				ids: {
					type: 'array',
					items: { type: 'string' },
					description: localize('monitorxGetChangelogDetailsTool.ids', "Array of entry IDs to retrieve"),
				},
				type: {
					type: 'string',
					enum: ['confirmed', 'pending', 'both'],
					description: localize('monitorxGetChangelogDetailsTool.type', "Type of changelog: 'confirmed', 'pending', or 'both' (default: 'both')"),
				},
			},
		},
	};

	constructor(
		private readonly _workspaceStore: IRenWorkspaceStore,
		private readonly _changelogBuffer: IRenMonitorXChangelogBuffer,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as Partial<IGetChangelogDetailsParams>;
		const ids = Array.isArray(params?.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [];
		const type = params?.type === 'confirmed' || params?.type === 'pending' ? params.type : 'both';

		if (!ids.length) {
			return {
				content: [{ kind: 'text', value: localize('monitorxGetChangelogDetailsTool.noIds', "No entry IDs provided.") }],
				toolResultError: localize('monitorxGetChangelogDetailsTool.noIds.error', 'Missing entry IDs'),
			};
		}

		if (ids.length > MAX_RESULTS) {
			return {
				content: [{ kind: 'text', value: localize('monitorxGetChangelogDetailsTool.tooManyIds', "Maximum {0} entry IDs allowed.", MAX_RESULTS) }],
				toolResultError: localize('monitorxGetChangelogDetailsTool.tooManyIds.error', 'Too many entry IDs'),
			};
		}

		const results: Array<ReturnType<typeof formatEntryDetail>> = [];
		const idSet = new Set(ids);

		if (type === 'confirmed' || type === 'both') {
			const allConfirmed = await this._workspaceStore.getAllChangelogEntries();
			for (const entry of allConfirmed) {
				if (idSet.has(entry.id)) {
					results.push(formatEntryDetail(entry, 'confirmed'));
					idSet.delete(entry.id);
				}
			}
		}

		if (type === 'pending' || type === 'both') {
			const allPending = this._changelogBuffer.listDrafts();
			for (const draft of allPending) {
				if (idSet.has(draft.sessionId)) {
					results.push(formatEntryDetail(draft, 'pending'));
					idSet.delete(draft.sessionId);
				}
			}
		}

		return {
			content: [{ kind: 'text', value: JSON.stringify(results, null, 2) }],
		};
	}
}

class MonitorXGetRecentChangelogTool implements IToolImpl {
	public static readonly ID = 'monitorx.getRecentChangelog';
	public static readonly DEFINITION: IToolData = {
		id: MonitorXGetRecentChangelogTool.ID,
		toolReferenceName: 'monitorx.getRecentChangelog',
		canBeReferencedInPrompt: true,
		displayName: localize('monitorxGetRecentChangelogTool.displayName', "Get recent MonitorX changelog entries"),
		modelDescription: localize('monitorxGetRecentChangelogTool.modelDescription', "Get the most recent confirmed changelog entries. Returns summaries without diffs."),
		userDescription: localize('monitorxGetRecentChangelogTool.userDescription', "Get recent MonitorX changelog entries"),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: 'object',
			properties: {
				limit: {
					type: 'number',
					description: localize('monitorxGetRecentChangelogTool.limit', "Number of recent entries (max 50, default: 10)"),
				},
			},
		},
	};

	constructor(
		private readonly _workspaceStore: IRenWorkspaceStore,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as Partial<IGetRecentChangelogParams>;
		const limit = params?.limit !== undefined ? Math.min(Math.max(1, params.limit), MAX_RESULTS) : 10;

		const recent = await this._workspaceStore.getRecentChangelogEntries(limit);
		const results = recent.map(entry => formatEntrySummary(entry, 'confirmed'));

		return {
			content: [{ kind: 'text', value: JSON.stringify(results, null, 2) }],
		};
	}
}

class MonitorXGetChangelogStatsTool implements IToolImpl {
	public static readonly ID = 'monitorx.getChangelogStats';
	public static readonly DEFINITION: IToolData = {
		id: MonitorXGetChangelogStatsTool.ID,
		toolReferenceName: 'monitorx.getChangelogStats',
		canBeReferencedInPrompt: true,
		displayName: localize('monitorxGetChangelogStatsTool.displayName', "Get MonitorX changelog statistics"),
		modelDescription: localize('monitorxGetChangelogStatsTool.modelDescription', "Get aggregated statistics about changelog entries including file frequency, activity patterns, and metadata breakdowns."),
		userDescription: localize('monitorxGetChangelogStatsTool.userDescription', "Get MonitorX changelog statistics"),
		source: ToolDataSource.Internal,
		inputSchema: {
			type: 'object',
			properties: {
				type: {
					type: 'string',
					enum: ['confirmed', 'pending', 'both'],
					description: localize('monitorxGetChangelogStatsTool.type', "Type of changelog: 'confirmed', 'pending', or 'both' (default: 'both')"),
				},
				fromDate: {
					type: ['string', 'number'],
					description: localize('monitorxGetChangelogStatsTool.fromDate', "Start date for statistics (ISO string, timestamp, or relative)"),
				},
				toDate: {
					type: ['string', 'number'],
					description: localize('monitorxGetChangelogStatsTool.toDate', "End date for statistics (ISO string, timestamp, or relative)"),
				},
				filePath: {
					type: 'string',
					description: localize('monitorxGetChangelogStatsTool.filePath', "Filter by file path"),
				},
			},
		},
	};

	constructor(
		private readonly _workspaceStore: IRenWorkspaceStore,
		private readonly _changelogBuffer: IRenMonitorXChangelogBuffer,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as Partial<IGetChangelogStatsParams>;
		const type = params?.type === 'confirmed' || params?.type === 'pending' ? params.type : 'both';

		const filter = buildFilter(params);
		const entries: Array<IMonitorXChangelogEntry | IMonitorXChangelogDraft> = [];

		if (type === 'confirmed' || type === 'both') {
			const confirmed = await this._workspaceStore.getAllChangelogEntries(filter);
			entries.push(...confirmed);
		}

		if (type === 'pending' || type === 'both') {
			const pending = this._changelogBuffer.listDrafts(filter);
			entries.push(...pending);
		}

		const fileFrequency = new Map<string, number>();
		const agentCount = new Map<string, number>();
		const modelCount = new Map<string, number>();
		const commandCount = new Map<string, number>();
		let totalLinesAdded = 0;
		let totalLinesRemoved = 0;

		for (const entry of entries) {
			for (const file of entry.files) {
				fileFrequency.set(file.path, (fileFrequency.get(file.path) || 0) + 1);
			}
			const agentId = entry.metadata?.agentId as string | undefined;
			if (agentId) {
				agentCount.set(agentId, (agentCount.get(agentId) || 0) + 1);
			}
			const modelId = entry.metadata?.modelId as string | undefined;
			if (modelId) {
				modelCount.set(modelId, (modelCount.get(modelId) || 0) + 1);
			}
			const command = entry.metadata?.command as string | undefined;
			if (command) {
				commandCount.set(command, (commandCount.get(command) || 0) + 1);
			}
			const linesAdded = typeof entry.metadata?.linesAdded === 'number' ? entry.metadata.linesAdded : 0;
			const linesRemoved = typeof entry.metadata?.linesRemoved === 'number' ? entry.metadata.linesRemoved : 0;
			totalLinesAdded += linesAdded;
			totalLinesRemoved += linesRemoved;
		}

		const topFiles = Array.from(fileFrequency.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([path, count]) => ({ path, count }));

		let confirmedCount = 0;
		let pendingCount = 0;
		if (type === 'confirmed') {
			confirmedCount = entries.length;
		} else if (type === 'pending') {
			pendingCount = entries.length;
		} else {
			for (const entry of entries) {
				if (isConfirmedEntry(entry)) {
					confirmedCount++;
				} else {
					pendingCount++;
				}
			}
		}

		const stats = {
			totalEntries: entries.length,
			confirmedEntries: confirmedCount,
			pendingEntries: pendingCount,
			totalFilesChanged: fileFrequency.size,
			totalLinesAdded,
			totalLinesRemoved,
			topFilesChanged: topFiles,
			agentBreakdown: Object.fromEntries(agentCount),
			modelBreakdown: Object.fromEntries(modelCount),
			commandBreakdown: Object.fromEntries(commandCount),
		};

		return {
			content: [{ kind: 'text', value: JSON.stringify(stats, null, 2) }],
		};
	}
}

