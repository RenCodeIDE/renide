/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMonitorXChangelogEntry } from '../../common/renWorkspaceStore.js';

export interface IMonitorXRenderOptions {
	readonly limit?: number;
	readonly emptyMessage?: string;
	readonly onFileClick?: (filePath: string) => void;
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
		// Extract just the filename from the full path
		const fileUri = URI.file(entry.filePath);
		const fileName = basename(fileUri);
		fileLabel.className = 'ren-monitorx-changelog-entry-file';
		if (options.onFileClick) {
			fileLabel.classList.add('clickable');
			fileLabel.style.cursor = 'pointer';
			fileLabel.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				options.onFileClick!(entry.filePath);
			};
		}
		fileLabel.textContent = fileName;
		fileLabel.setAttribute('title', entry.filePath); // Show full path on hover

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
			const diffBlock = document.createElement('div');
			diffBlock.className = 'ren-monitorx-changelog-entry-diff';

			// Truncate before parsing if needed
			let diffText = entry.diff;
			const truncated = diffText.length > MAX_DIFF_DISPLAY_LENGTH;
			if (truncated) {
				// Try to truncate at a line boundary
				const truncatedText = diffText.slice(0, MAX_DIFF_DISPLAY_LENGTH);
				const lastNewline = truncatedText.lastIndexOf('\n');
				diffText = lastNewline > 0 ? truncatedText.slice(0, lastNewline + 1) : truncatedText;
			}

			// Parse and render diff with colors
			const diffLines = diffText.split('\n');
			for (const line of diffLines) {
				const lineSpan = document.createElement('span');
				lineSpan.className = 'monitorx-diff-line';

				if (line.startsWith('+')) {
					lineSpan.classList.add('monitorx-diff-line-add');
					lineSpan.textContent = line;
				} else if (line.startsWith('-')) {
					lineSpan.classList.add('monitorx-diff-line-delete');
					lineSpan.textContent = line;
				} else if (line.startsWith('@@')) {
					lineSpan.classList.add('monitorx-diff-hunk-header');
					lineSpan.textContent = line;
				} else {
					// Context line or other (space, empty, etc.)
					lineSpan.textContent = line;
				}

				diffBlock.appendChild(lineSpan);
				diffBlock.appendChild(document.createElement('br'));
			}

			if (truncated) {
				const ellipsis = document.createElement('span');
				ellipsis.className = 'monitorx-diff-line';
				ellipsis.textContent = '…';
				diffBlock.appendChild(ellipsis);
			}

			item.appendChild(diffBlock);
		}

		list.appendChild(item);
	}

	target.appendChild(list);
}

