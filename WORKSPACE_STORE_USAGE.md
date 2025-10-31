# How to Use RenWorkspaceStore

## Step 1: Register the Service

Add to `src/vs/workbench/workbench.common.main.ts`:

```typescript
// At the top with other imports (around line 180-200)
import "./contrib/renViews/browser/renWorkspaceStore.js";

// Later in the file where services are registered
import { registerSingleton } from "../../platform/instantiation/common/extensions.js";
import { IRenWorkspaceStore } from "./contrib/renViews/common/renWorkspaceStore.js";
import { RenWorkspaceStore } from "./contrib/renViews/browser/renWorkspaceStore.js";
import { InstantiationType } from "../../platform/instantiation/common/extensions.js";

// Register as delayed singleton (lazy initialization)
registerSingleton(
	IRenWorkspaceStore,
	RenWorkspaceStore,
	InstantiationType.Delayed
);
```

## Step 2: Use in Your Components

### Example 1: In GraphView (Constructor Injection)

```typescript
// src/vs/workbench/contrib/renViews/browser/views/graphView/graphView.ts

import { IRenWorkspaceStore } from "../../common/renWorkspaceStore.js";

export class GraphView extends Disposable implements IRenView {
	constructor(
		// ... existing dependencies ...
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
	) {
		super();

		// Load saved graph state
		const savedMode = this.workspaceStore.getString("graph.mode");
		if (savedMode) {
			this._mode = savedMode as GraphMode;
		}

		// Load saved graph data
		const savedGraphData = this.workspaceStore.getObject("graph.data");
		if (savedGraphData) {
			this.restoreGraph(savedGraphData);
		}

		// Listen for changes
		this._register(
			this.workspaceStore.onDidChangeValue(({ key, value }) => {
				if (key === "graph.mode") {
					this.updateMode(value as GraphMode);
				}
			})
		);
	}

	private saveGraphState(): void {
		// Save current mode
		this.workspaceStore.setString("graph.mode", this._mode);

		// Save graph data
		const graphData = this.buildGraphData();
		this.workspaceStore.setObject("graph.data", graphData);
	}
}
```

### Example 2: In RenViewsContribution

```typescript
// src/vs/workbench/contrib/renViews/browser/renViews.contribution.ts

import { IRenWorkspaceStore } from "./common/renWorkspaceStore.js";

export class RenViewsContribution implements IWorkbenchContribution {
	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
	) {
		// Save workspace-specific settings
		this.workspaceStore.setBoolean("renViews.initialized", true);

		// Load saved view preferences
		const preferredView = this.workspaceStore.getString(
			"renViews.preferredView"
		);
		if (preferredView) {
			// Apply preference
		}
	}
}
```

### Example 3: In MonitorXView

```typescript
// src/vs/workbench/contrib/renViews/browser/views/monitorXView.ts

import { IRenWorkspaceStore } from "../common/renWorkspaceStore.js";

export class MonitorXView extends Disposable implements IRenView {
    constructor(
        // ... existing dependencies ...
        @IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
    ) {
        super();

        // Load saved MonitorX settings
        const autoRefresh = this.workspaceStore.getBoolean(
            "monitorx.autoRefresh",
            true
        );
        const zoomLevel = this.workspaceStore.getNumber("monitorx.zoomLevel", 100);

        // Apply settings
        this.setAutoRefresh(autoRefresh);
        this.setZoomLevel(zoomLevel);
    }

    private saveSettings(): void {
        this.workspaceStore.setBoolean("monitorx.autoRefresh", this._autoRefresh);
        this.workspaceStore.setNumber("monitorx.zoomLevel", this._zoomLevel);
    }
}
```

### Example 4: Using InstantiationService (when you can't use constructor injection)

```typescript
// In any component that has access to IInstantiationService

import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IRenWorkspaceStore } from "../common/renWorkspaceStore.js";

export class SomeComponent {
	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService
	) {
		// Access store via instantiation service
		const store = this.instantiationService.invokeFunction((accessor) =>
			accessor.get(IRenWorkspaceStore)
		);

		// Use the store
		store.setValue("myKey", { data: "value" });
		const value = store.getValue("myKey");
	}
}
```

## Step 3: Common Usage Patterns

### Pattern 1: Save/Load Component State

```typescript
// Save state before component is destroyed
saveState(): void {
    this.workspaceStore.setObject('component.state', {
        position: this._position,
        settings: this._settings,
        lastUpdated: Date.now()
    });
}

// Load state when component initializes
loadState(): void {
    const state = this.workspaceStore.getObject<{
        position: { x: number; y: number };
        settings: any;
        lastUpdated: number;
    }>('component.state');

    if (state) {
        this._position = state.position;
        this._settings = state.settings;
    }
}
```

### Pattern 2: Store User Preferences

```typescript
// Store preferences
setPreference(key: string, value: any): void {
    this.workspaceStore.setValue(`preferences.${key}`, value);
}

getPreference<T>(key: string, defaultValue: T): T {
    return this.workspaceStore.getValue<T>(`preferences.${key}`, defaultValue) ?? defaultValue;
}
```

### Pattern 3: Cache Data

```typescript
// Cache expensive computation results
getCachedData(key: string): any | undefined {
    const cached = this.workspaceStore.getObject(`cache.${key}`);
    if (cached && cached.timestamp > Date.now() - 3600000) { // 1 hour
        return cached.data;
    }
    return undefined;
}

setCachedData(key: string, data: any): void {
    this.workspaceStore.setObject(`cache.${key}`, {
        data,
        timestamp: Date.now()
    });
}
```

### Pattern 4: Listen to Changes

```typescript
// Listen to specific key changes
this._register(
	this.workspaceStore.onDidChangeValue(({ key, value }) => {
		if (key === "graph.mode") {
			this.handleModeChange(value);
		} else if (key.startsWith("preferences.")) {
			this.handlePreferenceChange(key, value);
		}
	})
);
```

### Pattern 5: Clear Workspace Data

```typescript
// Clear all workspace data (useful for reset)
resetWorkspace(): void {
    this.workspaceStore.clear();
}

// Clear specific data
clearComponentData(componentId: string): void {
    const keys = this.workspaceStore.getKeys();
    keys.filter(k => k.startsWith(`component.${componentId}.`))
        .forEach(k => this.workspaceStore.remove(k));
}
```

## API Reference

### Basic Operations

- `setValue(key: string, value: any): void` - Store any value
- `getValue<T>(key: string, defaultValue?: T): T | undefined` - Get value with type

### Type-Specific Operations

- `setString(key: string, value: string): void`
- `getString(key: string, defaultValue?: string): string | undefined`
- `setNumber(key: string, value: number): void`
- `getNumber(key: string, defaultValue?: number): number | undefined`
- `setBoolean(key: string, value: boolean): void`
- `getBoolean(key: string, defaultValue?: boolean): boolean | undefined`
- `setObject(key: string, obj: object): void`
- `getObject<T extends object>(key: string, defaultValue?: T): T | undefined`

### Utility Operations

- `remove(key: string): void` - Remove a key
- `has(key: string): boolean` - Check if key exists
- `getKeys(): string[]` - Get all keys
- `clear(): void` - Clear all workspace data

### Events

- `onDidChangeValue: Event<{ key: string; value: any }>` - Emitted when any value changes

## Important Notes

1. **Workspace-Scoped**: All data is scoped to the current workspace. When you switch workspaces, the data is isolated.

2. **Automatic Persistence**: Data is automatically saved to disk. No need to call save methods.

3. **Key Prefixing**: All keys are automatically prefixed with `ren.workspace.` to avoid conflicts.

4. **Type Safety**: Use TypeScript generics for type-safe retrieval:

   ```typescript
   const data = workspaceStore.getObject<MyType>("key", defaultValue);
   ```

5. **Events**: Listen to `onDidChangeValue` to react to storage changes from other components.

6. **Disposal**: The store is a singleton managed by VS Code. You don't need to dispose it manually.
