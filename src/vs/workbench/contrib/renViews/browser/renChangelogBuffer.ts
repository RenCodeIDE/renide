/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraft, IMonitorXChangelogDraftSeed, IMonitorXChangelogDraftUpdate, IMonitorXDraftChangeEvent } from '../common/renChangelogBuffer.js';
import { IMonitorXChangelogEntryInput, IMonitorXChangelogFileChange, IMonitorXChangelogGraphReference } from '../common/renWorkspaceStore.js';
import { IMonitorXChangelogFilter, matchesFilter } from '../common/renChangelogFilter.js';

interface IInternalDraft {
	readonly sessionId: string;
	readonly createdAt: number;
	readonly subject: string;
	readonly description: string;
	readonly files: readonly IMonitorXChangelogFileChange[];
	readonly graph?: IMonitorXChangelogGraphReference;
	readonly metadata?: Record<string, unknown>;
	readonly updatedAt: number;
}

export class RenMonitorXChangelogBuffer extends Disposable implements IRenMonitorXChangelogBuffer {
	declare readonly _serviceBrand: undefined;

	private readonly drafts = new Map<string, IInternalDraft>();
	private readonly _onDidChangeDraft = this._register(new Emitter<IMonitorXDraftChangeEvent>());
	readonly onDidChangeDraft: Event<IMonitorXDraftChangeEvent> = this._onDidChangeDraft.event;

	getDraft(sessionId: string): IMonitorXChangelogDraft | undefined {
		const draft = this.drafts.get(sessionId);
		return draft ? this.toExternalDraft(draft) : undefined;
	}

	listDrafts(filter?: IMonitorXChangelogFilter): readonly IMonitorXChangelogDraft[] {
		const allDrafts = Array.from(this.drafts.values(), draft => this.toExternalDraft(draft));
		if (!filter) {
			return allDrafts;
		}
		return allDrafts.filter(draft => {
			return matchesFilter({
				subject: draft.subject,
				description: draft.description,
				files: draft.files,
				metadata: draft.metadata,
				createdAt: draft.createdAt,
				updatedAt: draft.updatedAt
			}, filter);
		});
	}

	setDraft(sessionId: string, seed: IMonitorXChangelogDraftSeed): IMonitorXChangelogDraft {
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX Buffer] setDraft called', { sessionId, hasSubject: !!seed.subject, filesCount: seed.files?.length, subject: seed.subject?.substring(0, 50) });
		}
		const subject = this.normalizeSubject(seed.subject);
		const files = this.normalizeFiles(seed.files);
		if (!files.length) {
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.error('[MonitorX Buffer] setDraft: No files', { sessionId, filesInput: seed.files });
			}
			throw new Error('MonitorX changelog drafts require at least one file change.');
		}
		if (!subject) {
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.error('[MonitorX Buffer] setDraft: Empty subject', { sessionId, subjectInput: seed.subject });
			}
			throw new Error('MonitorX changelog drafts require a non-empty subject.');
		}
		const description = this.normalizeDescription(seed.description);
		const graph = this.normalizeGraph(seed.graph);
		const metadata = this.normalizeMetadata(seed.metadata);
		const now = Date.now();
		const draft: IInternalDraft = {
			sessionId,
			createdAt: seed.createdAt ?? now,
			updatedAt: seed.updatedAt ?? now,
			subject,
			description,
			files,
			...(graph ? { graph } : {}),
			...(metadata ? { metadata } : {})
		};
		this.drafts.set(sessionId, draft);
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX Buffer] setDraft: draft stored, emitting change', { sessionId, draftCount: this.drafts.size });
		}
		this.emitChange(sessionId, draft);
		return this.toExternalDraft(draft);
	}

	updateDraft(sessionId: string, update: IMonitorXChangelogDraftUpdate): IMonitorXChangelogDraft | undefined {
		const existing = this.drafts.get(sessionId);
		if (!existing) {
			return undefined;
		}

		const subject = typeof update.subject === 'string' ? this.normalizeSubject(update.subject) : existing.subject;
		const description = typeof update.description === 'string' ? this.normalizeDescription(update.description) : existing.description;
		const files = update.files ? this.normalizeFiles(update.files) : existing.files;
		if (!files.length) {
			throw new Error('MonitorX changelog drafts require at least one file change.');
		}
		if (!subject) {
			throw new Error('MonitorX changelog drafts require a non-empty subject.');
		}
		const graph = update.graph === null ? undefined : (update.graph ? this.normalizeGraph(update.graph) : existing.graph);
		const metadata = update.metadata === null ? undefined : (update.metadata ? this.normalizeMetadata(update.metadata) : existing.metadata);
		const updated: IInternalDraft = {
			sessionId: existing.sessionId,
			createdAt: existing.createdAt,
			subject,
			description,
			files,
			updatedAt: Date.now(),
			...(graph ? { graph } : {}),
			...(metadata ? { metadata } : {})
		};

		this.drafts.set(sessionId, updated);
		this.emitChange(sessionId, updated);
		return this.toExternalDraft(updated);
	}

	deleteDraft(sessionId: string): void {
		if (!this.drafts.has(sessionId)) {
			return;
		}
		this.drafts.delete(sessionId);
		this.emitChange(sessionId, undefined);
	}

	clear(): void {
		if (!this.drafts.size) {
			return;
		}
		const sessionIds = Array.from(this.drafts.keys());
		this.drafts.clear();
		for (const sessionId of sessionIds) {
			this.emitChange(sessionId, undefined);
		}
	}

	finalizeDraft(sessionId: string): IMonitorXChangelogEntryInput | undefined {
		const draft = this.drafts.get(sessionId);
		if (!draft) {
			return undefined;
		}
		// Extract the actual chat session ID from the key (format: "chatSessionId:fileUri")
		const chatSessionId = sessionId.includes(':') ? sessionId.split(':')[0] : sessionId;
		const entry: IMonitorXChangelogEntryInput = {
			sessionId: chatSessionId,
			subject: draft.subject,
			description: draft.description,
			files: draft.files.map(file => ({ ...file })),
			...(draft.graph ? { graph: { ...draft.graph } } : {}),
			...(draft.metadata ? { metadata: { ...draft.metadata } } : {}),
			timestamp: draft.updatedAt
		};
		this.drafts.delete(sessionId);
		this.emitChange(sessionId, undefined);
		return entry;
	}

	private emitChange(sessionId: string, draft: IInternalDraft | undefined): void {
		if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
			console.log('[MonitorX Buffer] emitChange: firing event', { sessionId, hasDraft: !!draft, draftSubject: draft?.subject?.substring(0, 50) });
		}
		this._onDidChangeDraft.fire({ sessionId, draft: draft ? this.toExternalDraft(draft) : undefined });
	}

	private toExternalDraft(draft: IInternalDraft): IMonitorXChangelogDraft {
		return {
			sessionId: draft.sessionId,
			subject: draft.subject,
			description: draft.description,
			files: draft.files.map(file => ({ ...file })),
			...(draft.graph ? { graph: { ...draft.graph } } : {}),
			...(draft.metadata ? { metadata: { ...draft.metadata } } : {}),
			createdAt: draft.createdAt,
			updatedAt: draft.updatedAt
		};
	}

	private normalizeSubject(subject: string): string {
		return subject ? subject.trim() : '';
	}

	private normalizeDescription(description: string): string {
		return description ? description.trim() : '';
	}

	private normalizeFiles(files: readonly IMonitorXChangelogFileChange[]): IMonitorXChangelogFileChange[] {
		const output: IMonitorXChangelogFileChange[] = [];
		for (const file of files) {
			if (!file) {
				continue;
			}
			const path = typeof file.path === 'string' ? file.path : undefined;
			const diff = typeof file.diff === 'string' ? file.diff : '';
			if (path) {
				output.push({ path, diff });
			}
		}
		return output;
	}

	private normalizeGraph(graph: IMonitorXChangelogGraphReference | undefined): IMonitorXChangelogGraphReference | undefined {
		if (!graph) {
			return undefined;
		}
		const uri = typeof graph.uri === 'string' ? graph.uri : undefined;
		const summary = typeof graph.summary === 'string' ? graph.summary : undefined;
		if (!uri && (!summary || !summary.trim())) {
			return undefined;
		}
		return {
			...(uri ? { uri } : {}),
			...(summary ? { summary } : {})
		};
	}

	private normalizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
		if (!metadata) {
			return undefined;
		}
		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(metadata)) {
			if (typeof key !== 'string') {
				continue;
			}
			if (value === undefined) {
				continue;
			}
			clean[key] = value;
		}
		return Object.keys(clean).length ? clean : undefined;
	}
}

registerSingleton(IRenMonitorXChangelogBuffer, RenMonitorXChangelogBuffer, InstantiationType.Delayed);

