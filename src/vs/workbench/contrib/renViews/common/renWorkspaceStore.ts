/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

export const IRenWorkspaceStore = createDecorator<IRenWorkspaceStore>('renWorkspaceStore');

export interface IMonitorXChangelogEntry {
	readonly id: string;
	readonly filePath: string;
	readonly diff: string;
	readonly reason: string;
	readonly timestamp: number;
}

export interface IMonitorXChangelogEntryInput {
	readonly filePath: string;
	readonly diff: string;
	readonly reason: string;
	readonly timestamp?: number;
}

/**
 * Workspace-scoped global store service.
 * All data persisted here is specific to the current workspace.
 */
export interface IRenWorkspaceStore {
	readonly _serviceBrand: undefined;

	// Basic value operations
	setValue(key: string, value: unknown): void;
	getValue<T>(key: string, defaultValue?: T): T | undefined;

	// Object operations
	setObject(key: string, obj: object): void;
	getObject<T extends object>(key: string, defaultValue?: T): T | undefined;

	// Boolean operations
	setBoolean(key: string, value: boolean): void;
	getBoolean(key: string, defaultValue?: boolean): boolean | undefined;

	// Number operations
	setNumber(key: string, value: number): void;
	getNumber(key: string, defaultValue?: number): number | undefined;

	// String operations
	setString(key: string, value: string): void;
	getString(key: string, defaultValue?: string): string | undefined;

	// Remove operations
	remove(key: string): void;
	clear(): void;

	// Check if key exists
	has(key: string): boolean;

	// Get all keys
	getKeys(): string[];

	// Events
	readonly onDidChangeValue: Event<{ key: string; value: unknown }>;
	readonly onDidChangeChangelog: Event<IMonitorXChangelogEntry[]>;

	// MonitorX changelog APIs
	addChangelogEntry(entry: IMonitorXChangelogEntryInput): Promise<IMonitorXChangelogEntry>;
	getRecentChangelogEntries(limit?: number): Promise<IMonitorXChangelogEntry[]>;
	getAllChangelogEntries(): Promise<IMonitorXChangelogEntry[]>;
}

