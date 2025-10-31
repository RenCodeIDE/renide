# VS Code Global Store Setup Guide

This guide explains how to set up a global store in VS Code that can be accessed by all components and agents, with support for persisting data to disk (hidden from users).

## Overview

VS Code uses a **dependency injection (DI) pattern** with a **service-based architecture**. The recommended approach is to:

1. **Create a service** that implements your global store
2. **Register it as a singleton** so it's available throughout the application
3. **Use IStorageService** for disk persistence (it handles persistence automatically)
4. **Access the service** via dependency injection in any component

## Architecture Components

### 1. Service Registration System

VS Code uses `ServiceCollection` and `IInstantiationService` for dependency injection:

- **ServiceCollection**: Holds all registered services
- **IInstantiationService**: Creates instances and resolves dependencies
- **registerSingleton()**: Registers a service that will be instantiated once and reused

### 2. Storage System

VS Code provides `IStorageService` which handles:

- **StorageScope**: APPLICATION (global), PROFILE (user profile), WORKSPACE (workspace-specific)
- **StorageTarget**: USER (syncs across machines), MACHINE (local only)
- **Automatic persistence**: Data is automatically saved to disk
- **Storage locations**: Hidden in user data directories

### 3. Memento Pattern

For component-specific state, VS Code uses the `Memento` pattern:

- Wraps `IStorageService` with a convenient API
- Automatically handles saving/loading state
- Used by the `Component` base class

## Step-by-Step Implementation

### Step 1: Create Your Service Interface

Create a service interface in your feature directory:

```typescript
// src/vs/workbench/contrib/renViews/common/renGlobalStore.ts

import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import { Event, Emitter } from "../../../../base/common/event.js";

export const IRenGlobalStore =
	createDecorator<IRenGlobalStore>("renGlobalStore");

export interface IRenGlobalStore {
	readonly _serviceBrand: undefined;

	// Example: Store a value
	setValue(key: string, value: any): void;
	getValue<T>(key: string, defaultValue?: T): T | undefined;

	// Example: Store complex objects
	setObject(key: string, obj: object): void;
	getObject<T extends object>(key: string, defaultValue?: T): T | undefined;

	// Example: Event when data changes
	readonly onDidChangeValue: Event<{ key: string; value: any }>;

	// Example: Clear all data
	clear(): void;
}
```

### Step 2: Implement Your Service

Implement the service with storage integration:

```typescript
// src/vs/workbench/contrib/renViews/browser/renGlobalStore.ts

import { IRenGlobalStore } from "../common/renGlobalStore.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import { Emitter, Event } from "../../../../base/common/event.js";

export class RenGlobalStore extends Disposable implements IRenGlobalStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeValue = this._register(
		new Emitter<{ key: string; value: any }>()
	);
	readonly onDidChangeValue: Event<{ key: string; value: any }> =
		this._onDidChangeValue.event;

	// Prefix for all storage keys to avoid conflicts
	private static readonly STORAGE_PREFIX = "ren.globalStore.";

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		// Listen to storage changes to detect external updates
		this._register(
			this.storageService.onDidChangeValue(
				StorageScope.APPLICATION,
				undefined,
				this._store
			)
		);
	}

	setValue(key: string, value: any): void {
		const storageKey = this.getStorageKey(key);

		// Store as JSON string
		const jsonValue = JSON.stringify(value);
		this.storageService.store(
			storageKey,
			jsonValue,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);

		// Emit change event
		this._onDidChangeValue.fire({ key, value });
	}

	getValue<T>(key: string, defaultValue?: T): T | undefined {
		const storageKey = this.getStorageKey(key);
		const stored = this.storageService.get(
			storageKey,
			StorageScope.APPLICATION
		);

		if (stored === undefined) {
			return defaultValue;
		}

		try {
			return JSON.parse(stored) as T;
		} catch {
			return defaultValue;
		}
	}

	setObject(key: string, obj: object): void {
		const storageKey = this.getStorageKey(key);
		this.storageService.store(
			storageKey,
			obj,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
		this._onDidChangeValue.fire({ key, value: obj });
	}

	getObject<T extends object>(key: string, defaultValue?: T): T | undefined {
		const storageKey = this.getStorageKey(key);
		return this.storageService.getObject<T>(
			storageKey,
			StorageScope.APPLICATION,
			defaultValue
		);
	}

	clear(): void {
		// Get all keys with our prefix
		const keys = this.storageService.keys(
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
		const ourKeys = keys.filter((k) =>
			k.startsWith(RenGlobalStore.STORAGE_PREFIX)
		);

		for (const key of ourKeys) {
			this.storageService.remove(key, StorageScope.APPLICATION);
		}
	}

	private getStorageKey(key: string): string {
		return `${RenGlobalStore.STORAGE_PREFIX}${key}`;
	}
}
```

### Step 3: Register Your Service

Register the service as a singleton in `workbench.common.main.ts`:

```typescript
// Add to src/vs/workbench/workbench.common.main.ts

// At the top with other imports
import "./contrib/renViews/browser/renGlobalStore.js";

// Later in the file where other services are registered (around line 180-200)
import { registerSingleton } from "../../platform/instantiation/common/extensions.js";
import { IRenGlobalStore } from "./contrib/renViews/common/renGlobalStore.js";
import { RenGlobalStore } from "./contrib/renViews/browser/renGlobalStore.js";
import { InstantiationType } from "../../platform/instantiation/common/extensions.js";

// Register as delayed singleton (lazy initialization)
registerSingleton(IRenGlobalStore, RenGlobalStore, InstantiationType.Delayed);
```

**Note**: Choose the instantiation type:

- `InstantiationType.Eager`: Created immediately when workbench starts
- `InstantiationType.Delayed`: Created when first accessed (recommended for most cases)

### Step 4: Access Your Service in Components

Now you can access your service anywhere using dependency injection:

#### Option A: Constructor Injection (Recommended)

```typescript
import { IRenGlobalStore } from "../common/renGlobalStore.js";

export class MyComponent extends Disposable {
	constructor(@IRenGlobalStore private readonly globalStore: IRenGlobalStore) {
		super();

		// Use the store
		this.globalStore.setValue("myKey", { data: "value" });
		const value = this.globalStore.getValue("myKey");
	}
}
```

#### Option B: Using InstantiationService

```typescript
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IRenGlobalStore } from "../common/renGlobalStore.js";

export class MyComponent {
	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService
	) {
		const globalStore = this.instantiationService.invokeFunction((accessor) =>
			accessor.get(IRenGlobalStore)
		);

		globalStore.setValue("myKey", "value");
	}
}
```

#### Option C: Direct Access via invokeFunction

```typescript
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IRenGlobalStore } from "../common/renGlobalStore.js";

// In any function with access to instantiationService
instantiationService.invokeFunction((accessor) => {
	const globalStore = accessor.get(IRenGlobalStore);
	globalStore.setValue("key", "value");
});
```

### Step 5: Using in Workbench Contributions

For workbench contributions (like your `RenViewsContribution`):

```typescript
import { IRenGlobalStore } from "../common/renGlobalStore.js";

export class RenViewsContribution implements IWorkbenchContribution {
	constructor(
		@IRenGlobalStore private readonly globalStore: IRenGlobalStore,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		// Access the global store
		this.globalStore.setValue("initialized", true);

		// Listen to changes
		this._store.add(
			this.globalStore.onDidChangeValue(({ key, value }) => {
				console.log(`Store changed: ${key} = ${value}`);
			})
		);
	}
}
```

## Storage Scopes Explained

### StorageScope.APPLICATION

- **Use for**: Global application state, cross-workspace data
- **Persists**: Across all workspaces and profiles
- **Location**: `<userData>/globalStorage/` (hidden from user)
- **Best for**: Your global store that needs to persist everywhere

### StorageScope.PROFILE

- **Use for**: User profile-specific data
- **Persists**: Across workspaces but specific to user profile
- **Location**: Profile-specific storage directory
- **Best for**: User preferences, profile settings

### StorageScope.WORKSPACE

- **Use for**: Workspace-specific data
- **Persists**: Only for current workspace
- **Location**: Workspace storage directory
- **Best for**: Workspace-specific state

### StorageTarget Explained

- **StorageTarget.USER**: Data syncs across machines (if sync is enabled)
- **StorageTarget.MACHINE**: Data stays on local machine only

## Advanced: Direct File System Access

If you need to store files directly (not just key-value pairs), use `IFileService`:

```typescript
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { joinPath } from "../../../../base/common/resources.js";

export class RenGlobalStore extends Disposable implements IRenGlobalStore {
	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService
		private readonly environmentService: IEnvironmentService
	) {
		super();
	}

	async saveFile(filename: string, content: string): Promise<void> {
		// Use globalStorage home - hidden from user
		const storagePath = this.environmentService.globalStorageHome;
		const filePath = joinPath(storagePath, "renStore", filename);

		await this.fileService.writeFile(filePath, VSBuffer.fromString(content));
	}

	async readFile(filename: string): Promise<string | undefined> {
		const storagePath = this.environmentService.globalStorageHome;
		const filePath = joinPath(storagePath, "renStore", filename);

		try {
			const content = await this.fileService.readFile(filePath);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}
}
```

## Example: Complete Implementation

Here's a complete example for your renViews feature:

```typescript
// src/vs/workbench/contrib/renViews/common/renGlobalStore.ts
export const IRenGlobalStore =
	createDecorator<IRenGlobalStore>("renGlobalStore");

export interface IRenGlobalStore {
	readonly _serviceBrand: undefined;

	// Store graph data
	saveGraphData(graphId: string, data: any): void;
	getGraphData(graphId: string): any | undefined;

	// Store component state
	saveComponentState(componentId: string, state: any): void;
	getComponentState(componentId: string): any | undefined;

	// Listen to changes
	readonly onDidChangeGraphData: Event<{ graphId: string; data: any }>;
}

// src/vs/workbench/contrib/renViews/browser/renGlobalStore.ts
export class RenGlobalStore extends Disposable implements IRenGlobalStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeGraphData = this._register(
		new Emitter<{ graphId: string; data: any }>()
	);
	readonly onDidChangeGraphData = this._onDidChangeGraphData.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();
	}

	saveGraphData(graphId: string, data: any): void {
		const key = `ren.graph.${graphId}`;
		this.storageService.store(
			key,
			data,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
		this._onDidChangeGraphData.fire({ graphId, data });
	}

	getGraphData(graphId: string): any | undefined {
		const key = `ren.graph.${graphId}`;
		return this.storageService.getObject(key, StorageScope.APPLICATION);
	}

	saveComponentState(componentId: string, state: any): void {
		const key = `ren.component.${componentId}`;
		this.storageService.store(
			key,
			state,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}

	getComponentState(componentId: string): any | undefined {
		const key = `ren.component.${componentId}`;
		return this.storageService.getObject(key, StorageScope.APPLICATION);
	}
}
```

## Key Points

1. **Services are singletons**: Once registered, the same instance is used everywhere
2. **Automatic persistence**: `IStorageService` handles saving to disk automatically
3. **Hidden storage**: Data is stored in user data directories, not visible to users
4. **Dependency injection**: Access services via constructor parameters or `IInstantiationService`
5. **Lifecycle management**: Services extend `Disposable` for proper cleanup
6. **Event-driven**: Use events to notify components of changes

## Where Data is Stored

Storage locations (hidden from users):

- **Application scope**: `<userData>/globalStorage/<workspace-id>/state.vscdb`
- **Profile scope**: `<userData>/User/globalStorage/<profile-id>/state.vscdb`
- **Workspace scope**: `<userData>/workspaceStorage/<workspace-id>/state.vscdb`

These are SQLite databases managed by VS Code. You don't need to worry about the implementation details - just use `IStorageService` APIs.

## Testing Your Service

```typescript
// In a test or during development
instantiationService.invokeFunction((accessor) => {
	const store = accessor.get(IRenGlobalStore);

	// Test storing and retrieving
	store.setValue("test", { hello: "world" });
	const value = store.getValue("test");
	console.log(value); // { hello: 'world' }
});
```

This approach gives you a robust, persistent, globally accessible store that integrates seamlessly with VS Code's architecture!
