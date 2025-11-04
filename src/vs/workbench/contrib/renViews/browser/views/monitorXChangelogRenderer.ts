/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMonitorXChangelogEntry, IMonitorXChangelogFileChange } from '../../common/renWorkspaceStore.js';
import { IMonitorXChangelogDraft } from '../../common/renChangelogBuffer.js';

export interface IMonitorXRenderOptions {
	readonly limit?: number;
	readonly emptyMessage?: string;
	readonly onFileClick?: (filePath: string) => void;
	readonly onViewDiff?: (file: IMonitorXChangelogFileChange) => void;
}

export interface IMonitorXDraftRenderOptions extends IMonitorXRenderOptions {
	readonly onSubjectChange?: (sessionId: string, subject: string) => void;
	readonly onDescriptionChange?: (sessionId: string, description: string) => void;
}

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

		const subjectLabel = document.createElement('span');
		subjectLabel.className = 'ren-monitorx-changelog-entry-subject';
		subjectLabel.textContent = entry.subject || 'Untitled change';

		const timeLabel = document.createElement('time');
		timeLabel.className = 'ren-monitorx-changelog-entry-time';
		timeLabel.dateTime = new Date(entry.timestamp).toISOString();
		timeLabel.textContent = new Date(entry.timestamp).toLocaleString();

		header.appendChild(subjectLabel);
		header.appendChild(timeLabel);
		item.appendChild(header);

		const description = document.createElement('p');
		description.className = 'ren-monitorx-changelog-entry-description';
		description.textContent = entry.description || '--';
		item.appendChild(description);

		for (const file of entry.files) {
			appendFileSection(item, file, options);
		}

		list.appendChild(item);
	}

	target.appendChild(list);
}

function appendFileSection(container: HTMLElement, file: IMonitorXChangelogFileChange, options: IMonitorXRenderOptions): void {
	const section = document.createElement('section');
	section.className = 'ren-monitorx-changelog-file';

	const header = document.createElement('div');
	header.className = 'ren-monitorx-changelog-file-header';

	const label = document.createElement('span');
	label.className = 'ren-monitorx-changelog-entry-file';
	const fileUri = URI.file(file.path);
	const fileName = basename(fileUri);
	label.textContent = fileName;
	label.setAttribute('title', file.path);
	if (options.onFileClick) {
		label.classList.add('clickable');
		label.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			options.onFileClick!(file.path);
		};
	}

	header.appendChild(label);

	const viewBtn = document.createElement('button');
	viewBtn.type = 'button';
	viewBtn.className = 'ren-monitorx-view-diff';
	viewBtn.textContent = 'View diff';
	if (options.onViewDiff && file.diff) {
		viewBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			options.onViewDiff!(file);
		};
	} else {
		viewBtn.disabled = true;
	}
	header.appendChild(viewBtn);

	section.appendChild(header);

	container.appendChild(section);
}

export function renderMonitorXChangelogDrafts(target: HTMLElement, drafts: readonly IMonitorXChangelogDraft[], options: IMonitorXDraftRenderOptions = {}): void {
	target.textContent = '';

	if (!drafts.length) {
		const empty = document.createElement('div');
		empty.className = 'ren-monitorx-draft-empty';
		empty.textContent = options.emptyMessage ?? 'No pending MonitorX drafts. Apply AI edits to stage a changelog entry.';
		target.appendChild(empty);
		return;
	}

	const list = document.createElement('div');
	list.className = 'ren-monitorx-draft-list';

	for (const draft of drafts.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
		const item = document.createElement('article');
		item.className = 'ren-monitorx-draft-entry';

		const header = document.createElement('header');
		header.className = 'ren-monitorx-draft-entry-header';

		const status = document.createElement('span');
		status.className = 'ren-monitorx-draft-status';
		status.textContent = 'Pending';

		const timeLabel = document.createElement('time');
		timeLabel.className = 'ren-monitorx-draft-entry-time';
		timeLabel.dateTime = new Date(draft.updatedAt).toISOString();
		timeLabel.textContent = new Date(draft.updatedAt).toLocaleString();

		header.appendChild(status);
		header.appendChild(timeLabel);
		item.appendChild(header);

		const subjectInput = document.createElement('input');
		subjectInput.className = 'ren-monitorx-draft-subject';
		subjectInput.value = draft.subject;
		subjectInput.placeholder = 'Changelog subject';
		subjectInput.addEventListener('change', () => {
			if (options.onSubjectChange) {
				options.onSubjectChange(draft.sessionId, subjectInput.value.trim());
			}
		});
		item.appendChild(subjectInput);

		const descriptionArea = document.createElement('textarea');
		descriptionArea.className = 'ren-monitorx-draft-description';
		descriptionArea.value = draft.description;
		descriptionArea.rows = Math.min(8, Math.max(3, draft.description.split(/\r?\n/).length));
		descriptionArea.placeholder = 'Describe what changed';
		descriptionArea.addEventListener('change', () => {
			if (options.onDescriptionChange) {
				options.onDescriptionChange(draft.sessionId, descriptionArea.value.trim());
			}
		});
		item.appendChild(descriptionArea);

		for (const file of draft.files) {
			appendFileSection(item, file, options);
		}

		list.appendChild(item);
	}

	target.appendChild(list);
}
