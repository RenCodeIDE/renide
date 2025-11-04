/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMonitorXChangelogEntryInput, IMonitorXChangelogFileChange, IMonitorXChangelogGraphReference } from './renWorkspaceStore.js';
import { IMonitorXChangelogFilter } from './renChangelogFilter.js';

export interface IMonitorXChangelogDraft {
	readonly sessionId: string;
	readonly subject: string;
	readonly description: string;
	readonly files: readonly IMonitorXChangelogFileChange[];
	readonly graph?: IMonitorXChangelogGraphReference;
	readonly metadata?: Record<string, unknown>;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface IMonitorXChangelogDraftSeed {
	readonly subject: string;
	readonly description: string;
	readonly files: readonly IMonitorXChangelogFileChange[];
	readonly graph?: IMonitorXChangelogGraphReference;
	readonly metadata?: Record<string, unknown>;
	readonly createdAt?: number;
	readonly updatedAt?: number;
}

export interface IMonitorXChangelogDraftUpdate {
	readonly subject?: string;
	readonly description?: string;
	readonly files?: readonly IMonitorXChangelogFileChange[];
	readonly graph?: IMonitorXChangelogGraphReference | null;
	readonly metadata?: Record<string, unknown> | null;
}

export interface IMonitorXDraftChangeEvent {
	readonly sessionId: string;
	readonly draft: IMonitorXChangelogDraft | undefined;
}

export const IRenMonitorXChangelogBuffer = createDecorator<IRenMonitorXChangelogBuffer>('renMonitorXChangelogBuffer');

export interface IRenMonitorXChangelogBuffer {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDraft: Event<IMonitorXDraftChangeEvent>;

	getDraft(sessionId: string): IMonitorXChangelogDraft | undefined;
	listDrafts(filter?: IMonitorXChangelogFilter): readonly IMonitorXChangelogDraft[];
	setDraft(sessionId: string, seed: IMonitorXChangelogDraftSeed): IMonitorXChangelogDraft;
	updateDraft(sessionId: string, update: IMonitorXChangelogDraftUpdate): IMonitorXChangelogDraft | undefined;
	deleteDraft(sessionId: string): void;
	clear(): void;
	finalizeDraft(sessionId: string): IMonitorXChangelogEntryInput | undefined;
}

interface IInternalDraft {
	readonly sessionId: string;
	readonly subject: string;
	readonly description: string;
	readonly files: readonly IMonitorXChangelogFileChange[];
	readonly graph?: IMonitorXChangelogGraphReference;
	readonly metadata?: Record<string, unknown>;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export class RenMonitorXChangelogBuffer extends Disposable implements IRenMonitorXChangelogBuffer {
	declare readonly _serviceBrand: undefined;

	private readonly drafts = new Map<string, IInternalDraft>();
	private readonly seeds = new Map<string, IMonitorXChangelogDraftSeed>();
	private readonly _onDidChangeDraft = this._register(new Emitter<IMonitorXDraftChangeEvent>());
	readonly onDidChangeDraft: Event<IMonitorXDraftChangeEvent> = this._onDidChangeDraft.event;

	getDraft(sessionId: string): IMonitorXChangelogDraft | undefined {
		const draft = this.drafts.get(sessionId);
		return draft ? this.toExternalDraft(draft) : undefined;
	}

	listDrafts(): readonly IMonitorXChangelogDraft[] {
		return Array.from(this.drafts.values(), draft => this.toExternalDraft(draft));
	}

	setDraft(sessionId: string, seed: IMonitorXChangelogDraftSeed): IMonitorXChangelogDraft {
		const sanitized = this.sanitizeSeed(seed);
		const now = Date.now();
		const draft: IInternalDraft = {
			sessionId,
			subject: sanitized.subject,
			description: sanitized.description,
			files: sanitized.files,
			...(sanitized.graph ? { graph: sanitized.graph } : {}),
			...(sanitized.metadata ? { metadata: sanitized.metadata } : {}),
			createdAt: sanitized.createdAt ?? now,
			updatedAt: sanitized.updatedAt ?? now
		};
		this.drafts.set(sessionId, draft);
		this.seeds.set(sessionId, {
			subject: draft.subject,
			description: draft.description,
			files: draft.files.map(file => ({ ...file })),
			...(draft.graph ? { graph: { ...draft.graph } } : {}),
			...(draft.metadata ? { metadata: { ...draft.metadata } } : {}),
			createdAt: draft.createdAt,
			updatedAt: draft.updatedAt
		});
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
			subject,
			description,
			files,
			...(graph ? { graph } : {}),
			...(metadata ? { metadata } : {}),
			createdAt: existing.createdAt,
			updatedAt: Date.now()
		};
		this.drafts.set(sessionId, updated);
		this.seeds.set(sessionId, {
			subject: updated.subject,
			description: updated.description,
			files: updated.files.map(file => ({ ...file })),
			...(updated.graph ? { graph: { ...updated.graph } } : {}),
			...(updated.metadata ? { metadata: { ...updated.metadata } } : {}),
			createdAt: updated.createdAt,
			updatedAt: updated.updatedAt
		});
		this.emitChange(sessionId, updated);
		return this.toExternalDraft(updated);
	}

	deleteDraft(sessionId: string): void {
		if (!this.drafts.delete(sessionId)) {
			return;
		}
		this.seeds.delete(sessionId);
		this.emitChange(sessionId, undefined);
	}

	clear(): void {
		if (!this.drafts.size && !this.seeds.size) {
			return;
		}
		const sessionIds = new Set([...this.drafts.keys(), ...this.seeds.keys()]);
		this.drafts.clear();
		this.seeds.clear();
		for (const sessionId of sessionIds) {
			this.emitChange(sessionId, undefined);
		}
	}

	finalizeDraft(sessionId: string): IMonitorXChangelogEntryInput | undefined {
		const draft = this.drafts.get(sessionId);
		let entry: IMonitorXChangelogEntryInput | undefined;
		if (draft) {
			entry = {
				subject: draft.subject,
				description: draft.description,
				files: draft.files.map(file => ({ ...file })),
				...(draft.graph ? { graph: { ...draft.graph } } : {}),
				...(draft.metadata ? { metadata: { ...draft.metadata } } : {}),
				timestamp: draft.updatedAt
			};
		} else {
			const seed = this.seeds.get(sessionId);
			if (seed) {
				entry = {
					subject: seed.subject,
					description: seed.description,
					files: seed.files.map(file => ({ ...file })),
					...(seed.graph ? { graph: { ...seed.graph } } : {}),
					...(seed.metadata ? { metadata: { ...seed.metadata } } : {}),
					timestamp: seed.updatedAt ?? Date.now()
				};
			}
		}
		if (!entry) {
			return undefined;
		}
		this.drafts.delete(sessionId);
		this.seeds.delete(sessionId);
		this.emitChange(sessionId, undefined);
		return entry;
	}

	private emitChange(sessionId: string, draft: IInternalDraft | undefined): void {
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

	private sanitizeSeed(seed: IMonitorXChangelogDraftSeed): {
		subject: string;
		description: string;
		files: IMonitorXChangelogFileChange[];
		graph?: IMonitorXChangelogGraphReference;
		metadata?: Record<string, unknown>;
		createdAt?: number;
		updatedAt?: number;
	} {
		const subject = this.normalizeSubject(seed.subject);
		const description = this.normalizeDescription(seed.description);
		const files = this.normalizeFiles(seed.files);
		if (!files.length) {
			throw new Error('MonitorX changelog drafts require at least one file change.');
		}
		if (!subject) {
			throw new Error('MonitorX changelog drafts require a non-empty subject.');
		}
		const graph = this.normalizeGraph(seed.graph);
		const metadata = this.normalizeMetadata(seed.metadata);
		return {
			subject,
			description,
			files,
			graph,
			metadata,
			createdAt: seed.createdAt ?? Date.now(),
			updatedAt: seed.updatedAt ?? Date.now()
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
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
			return undefined;
		}
		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(metadata)) {
			if (value === undefined) {
				continue;
			}
			clean[key] = value;
		}
		return Object.keys(clean).length ? clean : undefined;
	}
}

registerSingleton(IRenMonitorXChangelogBuffer, RenMonitorXChangelogBuffer, InstantiationType.Delayed);

