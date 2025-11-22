/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRenWorkspaceStore, IMonitorXChangelogEntry, IMonitorXChangelogEntryInput, IMonitorXChangelogFileChange, IMonitorXChangelogGraphReference } from '../common/renWorkspaceStore.js';
import { IMonitorXChangelogFilter, matchesFilter } from '../common/renChangelogFilter.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { joinPath, dirname } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { raceTimeout } from '../../../../base/common/async.js';
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
	private _changelogLoadPromise: Promise<void> | null = null;

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
		const sanitizedFiles: IMonitorXChangelogFileChange[] = [];
		for (const file of entry.files) {
			if (!file || typeof file.path !== 'string') {
				continue;
			}
			const diff = typeof file.diff === 'string' ? file.diff : '';
			sanitizedFiles.push({
				path: file.path,
				diff
			});
		}
		if (!sanitizedFiles.length) {
			throw new Error('MonitorX changelog entry requires at least one file change.');
		}

		const subject = entry.subject.trim();
		if (!subject.length) {
			throw new Error('MonitorX changelog entry requires a non-empty subject.');
		}

		const description = entry.description.trim();
		const graph = entry.graph ? this.sanitizeGraphReference(entry.graph) : undefined;
		const metadata = entry.metadata ? this.sanitizeMetadata(entry.metadata) : undefined;
		const finalizedEntry: IMonitorXChangelogEntry = {
			id: generateUuid(),
			subject,
			description,
			timestamp: entry.timestamp ?? Date.now(),
			files: sanitizedFiles,
			...(graph ? { graph } : {}),
			...(metadata ? { metadata } : {})
		};

		this._changelogEntries.push(finalizedEntry);
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
		return finalizedEntry;
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

	async getAllChangelogEntries(filter?: IMonitorXChangelogFilter): Promise<IMonitorXChangelogEntry[]> {
		try {
			await this.ensureChangelogLoaded();
		} catch (error) {
			// If loading fails, return empty array instead of throwing
			this.logService.error('[RenWorkspaceStore] Failed to ensure changelog loaded in getAllChangelogEntries', error);
			return [];
		}
		const entries = this.cloneChangelogEntries();
		if (!filter) {
			return entries;
		}
		return entries.filter(entry => matchesFilter(entry, filter));
	}

	// Helper method to get storage key with prefix
	private getStorageKey(key: string): string {
		return `${RenWorkspaceStore.STORAGE_PREFIX}${key}`;
	}

	private async ensureChangelogLoaded(): Promise<void> {
		// If already loaded, return immediately
		if (this._changelogLoaded) {
			return;
		}

		// If a load is in progress, wait for it
		if (this._changelogLoadPromise) {
			return this._changelogLoadPromise;
		}

		// Start loading with an overall timeout as a failsafe
		const LOAD_TIMEOUT_MS = 5000; // 5 seconds total timeout as failsafe
		this._changelogLoadPromise = (async () => {
			try {
				const result = await raceTimeout(
					this.doLoadChangelog(),
					LOAD_TIMEOUT_MS,
					() => {
						this.logService.error('[RenWorkspaceStore] Overall timeout loading changelog, using empty changelog');
						// Ensure we mark as loaded even on timeout to prevent retry loops
						this._changelogEntries = [];
						this._changelogLoaded = true;
					}
				);
				
				// If timeout occurred (result is undefined), we've already handled it in onTimeout
				if (result === undefined) {
					// Timeout occurred, onTimeout callback already handled it
					return;
				}
			} catch (error) {
				// Catch any errors from doLoadChangelog or raceTimeout
				this.logService.error('[RenWorkspaceStore] Error loading changelog, using empty changelog', error);
				this._changelogEntries = [];
				this._changelogLoaded = true;
			}
		})();
		
		// Ensure the promise always resolves, even if there's an unhandled error
		this._changelogLoadPromise = this._changelogLoadPromise.catch((error) => {
			// If there's an error, ensure we still mark as loaded to prevent infinite retries
			this.logService.error('[RenWorkspaceStore] Error in changelog load promise, using empty changelog', error);
			this._changelogEntries = [];
			this._changelogLoaded = true;
			// Don't rethrow - we want to resolve successfully with empty changelog
		});
		
		return this._changelogLoadPromise;
	}

	private async doLoadChangelog(): Promise<void> {
		const TIMEOUT_MS = 2000;

		try {
			// Validate workspace storage home is available
			if (!this.environmentService.workspaceStorageHome) {
				this.logService.warn('[RenWorkspaceStore] workspaceStorageHome is not available, using in-memory storage only');
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			// Validate workspace ID
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || !workspace.id) {
				this.logService.warn('[RenWorkspaceStore] Workspace ID is not available, using in-memory storage only');
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			const fileUri = this.getChangelogFileUri();
			if (!fileUri || !fileUri.scheme || !fileUri.path) {
				this.logService.warn('[RenWorkspaceStore] Invalid changelog file URI, using in-memory storage only');
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			// Check if file exists with timeout protection
			let exists = false;
			try {
				const existsResult = await raceTimeout(
					this.fileService.exists(fileUri),
					TIMEOUT_MS,
					() => {
						this.logService.warn('[RenWorkspaceStore] Timeout checking if changelog file exists');
					}
				);
				if (existsResult === undefined) {
					// Timeout occurred
					this.logService.warn('[RenWorkspaceStore] Timeout checking if changelog file exists, assuming it does not exist');
					this._changelogEntries = [];
					this._changelogLoaded = true;
					return;
				}
				exists = existsResult;
			} catch (existsError) {
				this.logService.warn('[RenWorkspaceStore] Failed to check if changelog file exists, assuming it does not exist', existsError);
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			if (!exists) {
				this._changelogEntries = [];
				this.logService.debug('[RenWorkspaceStore] Changelog file does not exist, starting with empty changelog');
				this._changelogLoaded = true;
				return;
			}

			// Read file with timeout protection
			let content;
			try {
				const readResult = await raceTimeout(
					this.fileService.readFile(fileUri),
					TIMEOUT_MS,
					() => {
						this.logService.warn('[RenWorkspaceStore] Timeout reading changelog file');
					}
				);
				if (readResult === undefined) {
					// Timeout occurred
					this.logService.warn('[RenWorkspaceStore] Timeout reading changelog file, using empty changelog');
					this._changelogEntries = [];
					this._changelogLoaded = true;
					return;
				}
				content = readResult;
			} catch (readError) {
				this.logService.error('[RenWorkspaceStore] Failed to read changelog file, using empty changelog', readError);
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			const text = content.value.toString();
			if (!text || !text.trim()) {
				this._changelogEntries = [];
				this.logService.debug('[RenWorkspaceStore] Changelog file is empty, starting with empty changelog');
				this._changelogLoaded = true;
				return;
			}

			// Parse JSON with error handling
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch (parseError) {
				this.logService.error('[RenWorkspaceStore] Failed to parse changelog file JSON, using empty changelog', parseError);
				this._changelogEntries = [];
				this._changelogLoaded = true;
				return;
			}

			if (Array.isArray(parsed)) {
				this._changelogEntries = this.sanitizeChangelogEntries(parsed);
				this.logService.debug(`[RenWorkspaceStore] Successfully loaded ${this._changelogEntries.length} changelog entries`);
			} else {
				this.logService.warn('[RenWorkspaceStore] Changelog file does not contain an array, using empty changelog');
				this._changelogEntries = [];
			}

			this._changelogLoaded = true;
		} catch (error) {
			// Catch-all error handler - ensure we always have an empty array as fallback
			this.logService.error('[RenWorkspaceStore] Unexpected error loading MonitorX changelog, using empty changelog', error);
			this._changelogEntries = [];
			this._changelogLoaded = true;
		}
	}

	private sanitizeChangelogEntries(raw: unknown[]): IMonitorXChangelogEntry[] {
		const entries: IMonitorXChangelogEntry[] = [];
		for (const candidate of raw) {
			const sanitized = this.sanitizeChangelogEntry(candidate);
			if (sanitized) {
				entries.push(sanitized);
			}
		}

		entries.sort((a, b) => a.timestamp - b.timestamp);
		if (entries.length > RenWorkspaceStore.CHANGELOG_MAX_ENTRIES) {
			return entries.slice(entries.length - RenWorkspaceStore.CHANGELOG_MAX_ENTRIES);
		}
		return entries;
	}

	private sanitizeChangelogEntry(candidate: unknown): IMonitorXChangelogEntry | undefined {
		if (!candidate || typeof candidate !== 'object') {
			return undefined;
		}
		const value = candidate as Record<string, unknown>;
		const timestampCandidate = typeof value.timestamp === 'number' ? value.timestamp : typeof value.timestamp === 'string' ? Number(value.timestamp) : NaN;
		if (!Number.isFinite(timestampCandidate)) {
			return undefined;
		}
		const files = this.sanitizeFileChanges(value);
		if (!files.length) {
			return undefined;
		}
		const subject = typeof value.subject === 'string' && value.subject.trim().length ? value.subject.trim() : this.deriveSubject(files, value);
		const description = typeof value.description === 'string' ? value.description : (typeof value.reason === 'string' ? value.reason : '');
		const id = typeof value.id === 'string' ? value.id : generateUuid();
		const graph = this.sanitizeGraphReference(value.graph);
		const metadata = this.sanitizeMetadata(value.metadata);
		return {
			id,
			subject,
			description,
			timestamp: timestampCandidate,
			files,
			...(graph ? { graph } : {}),
			...(metadata ? { metadata } : {})
		};
	}

	private sanitizeFileChanges(value: Record<string, unknown>): IMonitorXChangelogFileChange[] {
		const result: IMonitorXChangelogFileChange[] = [];
		const filesCandidate = Array.isArray(value.files) ? value.files : undefined;
		if (filesCandidate) {
			for (const file of filesCandidate) {
				if (!file || typeof file !== 'object') {
					continue;
				}
				const fileRecord = file as Record<string, unknown>;
				const path = typeof fileRecord.path === 'string' ? fileRecord.path : undefined;
				const diff = typeof fileRecord.diff === 'string' ? fileRecord.diff : undefined;
				if (path && diff !== undefined) {
					result.push({ path, diff });
				}
			}
		}

		// Back-compat with legacy structure
		if (!result.length) {
			const filePath = typeof value.filePath === 'string' ? value.filePath : undefined;
			const diff = typeof value.diff === 'string' ? value.diff : undefined;
			if (filePath && diff !== undefined) {
				result.push({ path: filePath, diff });
			}
		}

		return result;
	}

	private sanitizeGraphReference(graph: unknown): IMonitorXChangelogGraphReference | undefined {
		if (!graph || typeof graph !== 'object') {
			return undefined;
		}
		const record = graph as Record<string, unknown>;
		const uri = typeof record.uri === 'string' ? record.uri : undefined;
		const summary = typeof record.summary === 'string' ? record.summary : undefined;
		if (!uri && (!summary || !summary.trim())) {
			return undefined;
		}
		return {
			...(uri ? { uri } : {}),
			...(summary ? { summary } : {})
		};
	}

	private sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
			return undefined;
		}
		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
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

	private deriveSubject(files: readonly IMonitorXChangelogFileChange[], value: Record<string, unknown>): string {
		if (typeof value.reason === 'string' && value.reason.trim().length) {
			return value.reason.trim();
		}
		const firstFile = files[0];
		return `Update ${firstFile.path}`;
	}

	private cloneChangelogEntries(entries: IMonitorXChangelogEntry[] = this._changelogEntries): IMonitorXChangelogEntry[] {
		return entries.map(entry => ({
			...entry,
			files: entry.files.map(file => ({ ...file })),
			graph: entry.graph ? { ...entry.graph } : undefined,
			metadata: entry.metadata ? { ...entry.metadata } : undefined
		}));
	}

	private getChangelogFileUri(): URI {
		if (!this._changelogFileUri) {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || !workspace.id) {
				throw new Error('Workspace ID is not available');
			}
			if (!this.environmentService.workspaceStorageHome) {
				throw new Error('Workspace storage home is not available');
			}
			this._changelogFileUri = joinPath(this.environmentService.workspaceStorageHome, workspace.id, RenWorkspaceStore.CHANGELOG_FILENAME);
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
