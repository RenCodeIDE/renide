/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMonitorXChangelogEntry } from '../../common/renWorkspaceStore.js';

export interface IMonitorXRenderOptions {
	readonly limit?: number;
	readonly emptyMessage?: string;
}

const MAX_DIFF_DISPLAY_LENGTH = 800;

export function renderMonitorXChangelog(target: HTMLElement, entries: IMonitorXChangelogEntry[], options: IMonitorXRenderOptions = {}): void {
	target.textContent = '';

	const limit = options.limit ?? entries.length;
	const visibleEntries = limit > 0 ? entries.slice(-limit).reverse() : [];

	if (!visibleEntries.length) {
		const empty = document.createElement('div');
		empty.className = 'ren-monitorx-changelog-empty';
		empty.textContent = options.emptyMessage ?? 'No MonitorX activity recorded yet.';
		target.appendChild(empty);
		return;
	}

	const list = document.createElement('div');
	list.className = 'ren-monitorx-changelog-list';

	for (const entry of visibleEntries) {
		const item = document.createElement('article');
		item.className = 'ren-monitorx-changelog-entry';

		const header = document.createElement('header');
		header.className = 'ren-monitorx-changelog-entry-header';

		const fileLabel = document.createElement('span');
		fileLabel.className = 'ren-monitorx-changelog-entry-file';
		fileLabel.textContent = entry.filePath;

		const timeLabel = document.createElement('time');
		timeLabel.className = 'ren-monitorx-changelog-entry-time';
		timeLabel.dateTime = new Date(entry.timestamp).toISOString();
		timeLabel.textContent = new Date(entry.timestamp).toLocaleString();

		header.appendChild(fileLabel);
		header.appendChild(timeLabel);
		item.appendChild(header);

		const reason = document.createElement('p');
		reason.className = 'ren-monitorx-changelog-entry-reason';
		reason.textContent = entry.reason;
		item.appendChild(reason);

		if (entry.diff) {
			const diffBlock = document.createElement('pre');
			diffBlock.className = 'ren-monitorx-changelog-entry-diff';
			const diffText = entry.diff.length > MAX_DIFF_DISPLAY_LENGTH
				? `${entry.diff.slice(0, MAX_DIFF_DISPLAY_LENGTH)}…`
				: entry.diff;
			diffBlock.textContent = diffText;
			item.appendChild(diffBlock);
		}

		list.appendChild(item);
	}

	target.appendChild(list);
}

