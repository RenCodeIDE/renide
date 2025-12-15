/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IMonitorXChangelogFilter {
	text?: string;
	filePath?: string;
	sessionId?: string;
	agentId?: string;
	modelId?: string;
	command?: string;
	modeId?: string;
	fromDate?: number;
	toDate?: number;
	minLinesAdded?: number;
	maxLinesAdded?: number;
	minLinesRemoved?: number;
	maxLinesRemoved?: number;
	minFiles?: number;
	maxFiles?: number;
}

export function matchesFilter(entry: { sessionId?: string; subject: string; description: string; files: readonly { path: string }[]; metadata?: Record<string, unknown>; timestamp?: number; createdAt?: number; updatedAt?: number }, filter: IMonitorXChangelogFilter): boolean {
	if (filter.text) {
		const searchText = filter.text.toLowerCase();
		const matchesSubject = entry.subject.toLowerCase().includes(searchText);
		const matchesDescription = entry.description.toLowerCase().includes(searchText);
		if (!matchesSubject && !matchesDescription) {
			return false;
		}
	}

	if (filter.filePath) {
		const searchPath = filter.filePath.toLowerCase();
		const matchesFile = entry.files.some(file => file.path.toLowerCase().includes(searchPath));
		if (!matchesFile) {
			return false;
		}
	}

	if (filter.sessionId) {
		// Check top-level sessionId first, then fall back to metadata for backwards compatibility
		const entrySessionId = entry.sessionId ?? (entry.metadata?.sessionId as string | undefined);
		if (entrySessionId !== filter.sessionId) {
			return false;
		}
	}

	if (filter.agentId) {
		const entryAgentId = entry.metadata?.agentId as string | undefined;
		if (!entryAgentId || !entryAgentId.toLowerCase().includes(filter.agentId.toLowerCase())) {
			return false;
		}
	}

	if (filter.modelId) {
		const entryModelId = entry.metadata?.modelId as string | undefined;
		if (!entryModelId || !entryModelId.toLowerCase().includes(filter.modelId.toLowerCase())) {
			return false;
		}
	}

	if (filter.command) {
		const entryCommand = entry.metadata?.command as string | undefined;
		if (!entryCommand || !entryCommand.toLowerCase().includes(filter.command.toLowerCase())) {
			return false;
		}
	}

	if (filter.modeId) {
		const entryModeId = entry.metadata?.modeId as string | undefined;
		if (!entryModeId || !entryModeId.toLowerCase().includes(filter.modeId.toLowerCase())) {
			return false;
		}
	}

	const timestamp = entry.timestamp ?? entry.createdAt ?? entry.updatedAt ?? 0;
	if (filter.fromDate !== undefined && timestamp < filter.fromDate) {
		return false;
	}
	if (filter.toDate !== undefined && timestamp > filter.toDate) {
		return false;
	}

	const linesAdded = typeof entry.metadata?.linesAdded === 'number' ? entry.metadata.linesAdded : 0;
	if (filter.minLinesAdded !== undefined && linesAdded < filter.minLinesAdded) {
		return false;
	}
	if (filter.maxLinesAdded !== undefined && linesAdded > filter.maxLinesAdded) {
		return false;
	}

	const linesRemoved = typeof entry.metadata?.linesRemoved === 'number' ? entry.metadata.linesRemoved : 0;
	if (filter.minLinesRemoved !== undefined && linesRemoved < filter.minLinesRemoved) {
		return false;
	}
	if (filter.maxLinesRemoved !== undefined && linesRemoved > filter.maxLinesRemoved) {
		return false;
	}

	const fileCount = entry.files.length;
	if (filter.minFiles !== undefined && fileCount < filter.minFiles) {
		return false;
	}
	if (filter.maxFiles !== undefined && fileCount > filter.maxFiles) {
		return false;
	}

	return true;
}

