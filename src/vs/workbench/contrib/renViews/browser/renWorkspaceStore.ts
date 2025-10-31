/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRenWorkspaceStore, IMonitorXChangelogEntry, IMonitorXChangelogEntryInput } from '../common/renWorkspaceStore.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { joinPath, dirname } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';

export class RenWorkspaceStore extends Disposable implements IRenWorkspaceStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeValue = this._register(new Emitter<{ key: string; value: unknown }>());
	readonly onDidChangeValue: Event<{ key: string; value: unknown }> = this._onDidChangeValue.event;

	private readonly _onDidChangeChangelog = this._register(new Emitter<IMonitorXChangelogEntry[]>());
	readonly onDidChangeChangelog: Event<IMonitorXChangelogEntry[]> = this._onDidChangeChangelog.event;

	// Storage key prefix to avoid conflicts
	private static readonly STORAGE_PREFIX = 'ren.workspace.';

	// Storage scope: WORKSPACE - data persists only for current workspace
	private static readonly STORAGE_SCOPE = StorageScope.WORKSPACE;

	// Storage target: USER - data syncs across machines (if sync enabled)
	private static readonly STORAGE_TARGET = StorageTarget.USER;

	private static readonly CHANGELOG_FILENAME = 'monitorx-changelog.json';
	private static readonly CHANGELOG_MAX_ENTRIES = 200;

	private _changelogLoaded = false;
	private _changelogEntries: IMonitorXChangelogEntry[] = [];
	private _changelogFileUri: URI | null = null;
	private _changelogSavePromise: Promise<void> = Promise.resolve();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen to workspace storage changes
		// When IStorageService detects a change, we catch it and forward to our own event emitter
		this._register(
			this.storageService.onDidChangeValue(
				RenWorkspaceStore.STORAGE_SCOPE, // Listen to WORKSPACE scope changes
				undefined, // Listen to ALL keys (not filtered)
				this._store // DisposableStore for automatic cleanup
			)((event) => {
				// Filter: only forward events for keys with our prefix
				if (event.key.startsWith(RenWorkspaceStore.STORAGE_PREFIX)) {
					// Remove prefix to get the original key
					const ourKey = event.key.substring(RenWorkspaceStore.STORAGE_PREFIX.length);
					// Parse value if it's a string
					let value: unknown = event.target ? this.storageService.get(event.key, RenWorkspaceStore.STORAGE_SCOPE) : undefined;
					if (typeof value === 'string') {
						try {
							value = JSON.parse(value);
						} catch {
							// Keep as string if not valid JSON
						}
					}
					// Emit our own event
					this._onDidChangeValue.fire({ key: ourKey, value });
				}
			})
		);
	}

	// Basic value operations
	setValue(key: string, value: unknown): void {
		if (value === undefined || value === null) {
			this.remove(key);
			return;
		}
		this.storageService.store(this.getStorageKey(key), value, RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
	}

	getValue<T>(key: string, defaultValue?: T): T | undefined {
		const storageKey = this.getStorageKey(key);
		const raw = this.storageService.get(storageKey, RenWorkspaceStore.STORAGE_SCOPE);
		if (raw === undefined || raw === null) {
			return defaultValue;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			return raw as unknown as T;
		}
	}

	// Object operations
	setObject(key: string, obj: object): void {
		this.storageService.store(this.getStorageKey(key), obj, RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
	}

	getObject<T extends object>(key: string, defaultValue?: T): T | undefined {
		const value = this.storageService.getObject<T>(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
		return value ?? defaultValue;
	}

	// Boolean operations
	setBoolean(key: string, value: boolean): void {
		this.storageService.store(this.getStorageKey(key), value, RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
	}

	getBoolean(key: string, defaultValue?: boolean): boolean | undefined {
		const value = this.storageService.getBoolean(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
		return value === undefined ? defaultValue : value;
	}

	// Number operations
	setNumber(key: string, value: number): void {
		this.storageService.store(this.getStorageKey(key), value, RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
	}

	getNumber(key: string, defaultValue?: number): number | undefined {
		const value = this.storageService.getNumber(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
		return value === undefined ? defaultValue : value;
	}

	// String operations
	setString(key: string, value: string): void {
		this.storageService.store(this.getStorageKey(key), value, RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
	}

	getString(key: string, defaultValue?: string): string | undefined {
		const value = this.storageService.get(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
		return value === undefined ? defaultValue : value;
	}

	// Remove operations
	remove(key: string): void {
		this.storageService.remove(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
	}

	clear(): void {
		for (const key of this.getKeys()) {
			this.storageService.remove(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE);
		}
	}

	// Check if key exists
	has(key: string): boolean {
		return this.storageService.get(this.getStorageKey(key), RenWorkspaceStore.STORAGE_SCOPE) !== undefined;
	}

	// Get all keys
	getKeys(): string[] {
		const keys = this.storageService.keys(RenWorkspaceStore.STORAGE_SCOPE, RenWorkspaceStore.STORAGE_TARGET);
		return keys
			.filter(key => key.startsWith(RenWorkspaceStore.STORAGE_PREFIX))
			.map(key => key.substring(RenWorkspaceStore.STORAGE_PREFIX.length));
	}

	async addChangelogEntry(entry: IMonitorXChangelogEntryInput): Promise<IMonitorXChangelogEntry> {
		await this.ensureChangelogLoaded();
		const changelogEntry: IMonitorXChangelogEntry = {
			id: generateUuid(),
			filePath: entry.filePath,
			diff: entry.diff,
			reason: entry.reason,
			timestamp: entry.timestamp ?? Date.now()
		};

		this._changelogEntries.push(changelogEntry);
		if (this._changelogEntries.length > RenWorkspaceStore.CHANGELOG_MAX_ENTRIES) {
			this._changelogEntries.splice(0, this._changelogEntries.length - RenWorkspaceStore.CHANGELOG_MAX_ENTRIES);
		}

		try {
			await this.enqueueChangelogSave();
		} catch (error) {
			this.logService.error('[RenWorkspaceStore] Failed to persist MonitorX changelog entry', error);
			throw error;
		}

		this._onDidChangeChangelog.fire(this.cloneChangelogEntries());
		return changelogEntry;
	}

	async getRecentChangelogEntries(limit = 10): Promise<IMonitorXChangelogEntry[]> {
		await this.ensureChangelogLoaded();
		if (limit <= 0) {
			return [];
		}
		const sliceStart = Math.max(this._changelogEntries.length - limit, 0);
		const recent = this._changelogEntries.slice(sliceStart).reverse();
		return this.cloneChangelogEntries(recent);
	}

	async getAllChangelogEntries(): Promise<IMonitorXChangelogEntry[]> {
		await this.ensureChangelogLoaded();
		return this.cloneChangelogEntries();
	}

	// Helper method to get storage key with prefix
	private getStorageKey(key: string): string {
		return `${RenWorkspaceStore.STORAGE_PREFIX}${key}`;
	}

	private async ensureChangelogLoaded(): Promise<void> {
		if (this._changelogLoaded) {
			return;
		}
		this._changelogLoaded = true;

		try {
			const fileUri = this.getChangelogFileUri();
			if (!(await this.fileService.exists(fileUri))) {
				this._changelogEntries = [];
				return;
			}

			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			if (!text) {
				this._changelogEntries = [];
				return;
			}

			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) {
				this._changelogEntries = this.sanitizeChangelogEntries(parsed);
			} else {
				this._changelogEntries = [];
			}
		} catch (error) {
			this.logService.error('[RenWorkspaceStore] Failed to load MonitorX changelog', error);
			this._changelogEntries = [];
		}
	}

	private sanitizeChangelogEntries(raw: unknown[]): IMonitorXChangelogEntry[] {
		const entries: IMonitorXChangelogEntry[] = [];
		for (const candidate of raw) {
			if (!candidate || typeof candidate !== 'object') {
				continue;
			}
			const value = candidate as Record<string, unknown>;
			const filePath = typeof value.filePath === 'string' ? value.filePath : undefined;
			const diff = typeof value.diff === 'string' ? value.diff : undefined;
			const reason = typeof value.reason === 'string' ? value.reason : undefined;
			const timestampCandidate = typeof value.timestamp === 'number' ? value.timestamp : typeof value.timestamp === 'string' ? Number(value.timestamp) : NaN;
			if (!filePath || !diff || !reason || !Number.isFinite(timestampCandidate)) {
				continue;
			}
			const id = typeof value.id === 'string' ? value.id : generateUuid();
			entries.push({
				id,
				filePath,
				diff,
				reason,
				timestamp: timestampCandidate
			});
		}

		entries.sort((a, b) => a.timestamp - b.timestamp);
		if (entries.length > RenWorkspaceStore.CHANGELOG_MAX_ENTRIES) {
			return entries.slice(entries.length - RenWorkspaceStore.CHANGELOG_MAX_ENTRIES);
		}
		return entries;
	}

	private cloneChangelogEntries(entries: IMonitorXChangelogEntry[] = this._changelogEntries): IMonitorXChangelogEntry[] {
		return entries.map(entry => ({ ...entry }));
	}

	private getChangelogFileUri(): URI {
		if (!this._changelogFileUri) {
			const workspaceId = this.workspaceService.getWorkspace().id;
			this._changelogFileUri = joinPath(this.environmentService.workspaceStorageHome, workspaceId, RenWorkspaceStore.CHANGELOG_FILENAME);
		}
		return this._changelogFileUri;
	}

	private enqueueChangelogSave(): Promise<void> {
		const next = this._changelogSavePromise.then(() => this.writeChangelogFile());
		this._changelogSavePromise = next.then(undefined, () => undefined);
		return next;
	}

	private async writeChangelogFile(): Promise<void> {
		const fileUri = this.getChangelogFileUri();
		await this.fileService.createFolder(dirname(fileUri));
		const payload = JSON.stringify(this._changelogEntries);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(payload));
	}
}
registerSingleton(IRenWorkspaceStore, RenWorkspaceStore, InstantiationType.Delayed);
