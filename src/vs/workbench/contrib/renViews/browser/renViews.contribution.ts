import {
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions,
} from "../../../common/contributions.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { IEditorGroupsService } from "../../../services/editor/common/editorGroupsService.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../../../platform/instantiation/common/serviceCollection.js";
import {
	DisposableStore,
	DisposableMap,
	combinedDisposable,
} from "../../../../base/common/lifecycle.js";
import { Event } from "../../../../base/common/event.js";
import {
	observableFromEvent,
	autorun,
} from "../../../../base/common/observable.js";
import { EditorGroupView } from "../../../browser/parts/editor/editorGroupView.js";
import {
	EditorResourceAccessor,
	SideBySideEditor,
} from "../../../common/editor.js";
import "./styles/renViews.css";
import { EnvOverlay } from "./envOverlay.js";
import { RenMainWindowOverlay } from "./renMainWindowOverlay.js";
import { ViewButtons } from "./components/viewButtons.js";
import { localize, localize2 } from "../../../../nls.js";
import { registerIcon } from "../../../../platform/theme/common/iconRegistry.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { URI } from "../../../../base/common/uri.js";
import { ViewPaneContainer } from "../../../browser/parts/views/viewPaneContainer.js";
import {
	ViewContainerLocation,
	IViewContainersRegistry,
	IViewsRegistry,
	Extensions as ViewExtensions,
	ViewContainer,
} from "../../../common/views.js";
import { MonitorXChangelogViewPane } from "./views/monitorXChangelogViewPane.js";
import { DocsViewPane } from "./views/docsView/docsViewPane.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry as PlatformRegistry } from "../../../../platform/registry/common/platform.js";
import {
	IRenWorkspaceStore,
	IMonitorXChangelogEntryInput,
	IMonitorXChangelogFileChange,
} from "../common/renWorkspaceStore.js";
import { IDocsService } from "./services/docsService.js";
import { IChunkIndexService } from "./services/chunkIndexService.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import "./renWorkspaceStore.js";
import "./renChangelogBuffer.js";
import { MonitorXChangelogToolContribution } from "./monitorXChangelogTool.js";
import { isWeb } from "../../../../base/common/platform.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../platform/instantiation/common/extensions.js";
import {
	IGitHeatmapService,
	NullGitHeatmapService,
} from "../../../../platform/gitHeatmap/common/gitHeatmapService.js";
import { IRenViewManager, RenViewManager } from "./managers/renViewManager.js";
import { IGraphService, GraphService } from "./services/graphService.js";
import { GraphToolsContribution } from "./tools/graphToolsContribution.js";

if (isWeb) {
	registerSingleton(
		IGitHeatmapService,
		NullGitHeatmapService,
		InstantiationType.Delayed
	);
}

registerSingleton(IRenViewManager, RenViewManager, InstantiationType.Delayed);
registerSingleton(IGraphService, GraphService, InstantiationType.Delayed);

export class RenViewsContribution implements IWorkbenchContribution {
	static readonly ID = "ren.views.contribution";

	private readonly _store = new DisposableStore();

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		console.log("[RenViewsContribution] Constructor called, initializing...");
		// Set up EnvOverlay for each editor group (for .env file overlays)
		const editorGroups = observableFromEvent(
			this,
			Event.any(
				editorGroupsService.onDidAddGroup,
				editorGroupsService.onDidRemoveGroup
			),
			() => editorGroupsService.groups
		);

		const overlayWidgets = new DisposableMap<EditorGroupView>();
		const viewOverlays = new DisposableMap<EditorGroupView>();
		const viewButtonsWidgets = new Map<EditorGroupView, ViewButtons>();

		this._store.add(
			autorun((r) => {
				console.log(
					"[RenViewsContribution] Autorun executing, processing editor groups..."
				);
				const toDelete = new Set(overlayWidgets.keys());
				const toDeleteViewOverlays = new Set(viewOverlays.keys());
				const toDeleteViewButtons = new Set(viewButtonsWidgets.keys());
				const groups = editorGroups.read(r);
				console.log(
					`[RenViewsContribution] Found ${groups.length} editor groups`
				);

				for (const group of groups) {
					if (!(group instanceof EditorGroupView)) {
						console.log(
							"[RenViewsContribution] Skipping non-EditorGroupView:",
							group
						);
						continue;
					}

					toDelete.delete(group);
					toDeleteViewOverlays.delete(group);
					toDeleteViewButtons.delete(group);

					if (!overlayWidgets.has(group)) {
						const scopedInstaService = instantiationService.createChild(
							new ServiceCollection()
						);
						const container = group.element;
						const editorContent = container.querySelector(
							".editor-container"
						) as HTMLElement | null;
						const getGroupResource = () =>
							EditorResourceAccessor.getOriginalUri(group.activeEditor, {
								supportSideBySide: SideBySideEditor.PRIMARY,
							});
						const envOverlay = scopedInstaService.createInstance(
							EnvOverlay,
							editorContent ?? container,
							getGroupResource
						);
						overlayWidgets.set(
							group,
							combinedDisposable(envOverlay, scopedInstaService)
						);
					}

					// Create RenMainWindowOverlay for each editor group
					if (!viewOverlays.has(group)) {
						const container = group.element;
						const scopedInstaService = instantiationService.createChild(
							new ServiceCollection()
						);
						const viewOverlay = scopedInstaService.createInstance(
							RenMainWindowOverlay,
							container
						);
						viewOverlays.set(
							group,
							combinedDisposable(viewOverlay, scopedInstaService)
						);
					}

					// Attach ViewButtons to each editor group container
					if (!viewButtonsWidgets.has(group)) {
						const container = group.element;
						console.log(
							"[RenViewsContribution] Creating ViewButtons for editor group:",
							container
						);
						// Ensure container has relative positioning for absolute positioning of buttons
						if (
							container.style.position !== "relative" &&
							container.style.position !== "absolute"
						) {
							container.style.position = "relative";
						}
						const viewButtons = new ViewButtons(container);
						viewButtonsWidgets.set(group, viewButtons);
						console.log(
							"[RenViewsContribution] ViewButtons created and attached:",
							viewButtons.element
						);
					}
				}

				for (const group of toDelete) {
					overlayWidgets.deleteAndDispose(group);
				}

				for (const group of toDeleteViewOverlays) {
					viewOverlays.deleteAndDispose(group);
				}

				for (const group of toDeleteViewButtons) {
					const viewButtons = viewButtonsWidgets.get(group);
					if (viewButtons) {
						viewButtons.dispose();
					}
					viewButtonsWidgets.delete(group);
				}
			})
		);

		// Clean up view buttons on dispose
		this._store.add({
			dispose: () => {
				for (const viewButtons of viewButtonsWidgets.values()) {
					viewButtons.dispose();
				}
				viewButtonsWidgets.clear();
			},
		});
	}

	dispose(): void {
		this._store.dispose();
	}
}

// Register the contribution
console.log("[RenViewsContribution] Registering workbench contribution...");
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench
);
workbenchRegistry.registerWorkbenchContribution(
	RenViewsContribution,
	LifecyclePhase.Restored
);
workbenchRegistry.registerWorkbenchContribution(
	MonitorXChangelogToolContribution,
	LifecyclePhase.Restored
);
workbenchRegistry.registerWorkbenchContribution(
	GraphToolsContribution,
	LifecyclePhase.Restored
);
console.log(
	"[RenViewsContribution] Workbench contribution registered successfully"
);

const MONITORX_CHANGELOG_CONTAINER_ID = "workbench.view.monitorxChangelog";
const MONITORX_CHANGELOG_VIEW_ID = "workbench.view.monitorxChangelog.entries";
const monitorXChangelogIcon = registerIcon(
	"monitorx-changelog-view-icon",
	Codicon.history,
	localize("monitorxChangelogIcon", "MonitorX changelog view icon.")
);

const monitorXChangelogContainer: ViewContainer =
	Registry.as<IViewContainersRegistry>(
		ViewExtensions.ViewContainersRegistry
	).registerViewContainer(
		{
			id: MONITORX_CHANGELOG_CONTAINER_ID,
			title: localize2("monitorxActivityTitle", "MonitorX"),
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
				MONITORX_CHANGELOG_CONTAINER_ID,
				{ mergeViewWithContainerWhenSingleView: true },
			]),
			icon: monitorXChangelogIcon,
			hideIfEmpty: false,
		},
		ViewContainerLocation.Sidebar
	);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: MONITORX_CHANGELOG_VIEW_ID,
			name: localize2("monitorxChangelogViewTitle", "MonitorX Changelog"),
			ctorDescriptor: new SyncDescriptor(MonitorXChangelogViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: false,
			order: 10,
		},
	],
	monitorXChangelogContainer
);

const MONITORX_ADD_CHANGELOG_COMMAND = "ren.monitorx.addChangelogEntry";
const MONITORX_GET_CHANGELOG_COMMAND = "ren.monitorx.getRecentChangelogEntries";

if (!CommandsRegistry.getCommand(MONITORX_ADD_CHANGELOG_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: MONITORX_ADD_CHANGELOG_COMMAND,
		handler: async (
			accessor,
			args: Partial<IMonitorXChangelogEntryInput> | undefined
		) => {
			const workspaceStore = accessor.get(IRenWorkspaceStore);
			if (!args) {
				throw new Error(
					"monitorx.addChangelogEntry requires an argument payload."
				);
			}

			const subject =
				typeof args.subject === "string" ? args.subject.trim() : "";
			if (!subject) {
				throw new Error(
					"monitorx.addChangelogEntry requires a non-empty subject string."
				);
			}

			const description =
				typeof args.description === "string" ? args.description : "";
			const filesInput = Array.isArray(args.files) ? args.files : [];
			const files: IMonitorXChangelogFileChange[] = [];
			for (const file of filesInput) {
				if (!file || typeof file !== "object") {
					continue;
				}
				const record = file as Record<string, unknown>;
				const path = typeof record.path === "string" ? record.path : undefined;
				const diff = typeof record.diff === "string" ? record.diff : undefined;
				if (path && diff !== undefined) {
					files.push({ path, diff });
				}
			}
			if (!files.length) {
				throw new Error(
					"monitorx.addChangelogEntry requires at least one file change with path and diff."
				);
			}

			const graphRecord =
				args.graph &&
				typeof args.graph === "object" &&
				!Array.isArray(args.graph)
					? (args.graph as Record<string, unknown>)
					: undefined;
			const graphInput = graphRecord
				? {
						uri:
							typeof graphRecord.uri === "string" ? graphRecord.uri : undefined,
						summary:
							typeof graphRecord.summary === "string"
								? graphRecord.summary
								: undefined,
				  }
				: undefined;
			const metadata =
				args.metadata &&
				typeof args.metadata === "object" &&
				!Array.isArray(args.metadata)
					? (args.metadata as Record<string, unknown>)
					: undefined;

			const entryInput: IMonitorXChangelogEntryInput = {
				subject,
				description,
				files,
				...(graphInput &&
				(graphInput.uri || (graphInput.summary && graphInput.summary.trim()))
					? { graph: graphInput }
					: {}),
				...(metadata ? { metadata } : {}),
				timestamp:
					typeof args.timestamp === "number" ? args.timestamp : undefined,
			};

			const entry = await workspaceStore.addChangelogEntry(entryInput);
			return { ...entry };
		},
	});
}

if (!CommandsRegistry.getCommand(MONITORX_GET_CHANGELOG_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: MONITORX_GET_CHANGELOG_COMMAND,
		handler: async (accessor, args: { limit?: number } | undefined) => {
			const workspaceStore = accessor.get(IRenWorkspaceStore);
			const limit =
				args && typeof args.limit === "number"
					? Math.max(1, Math.floor(args.limit))
					: 10;
			const entries = await workspaceStore.getRecentChangelogEntries(limit);
			return entries.map((entry) => ({ ...entry }));
		},
	});
}

// --- Docs Container & View Registration ---
const DOCS_CONTAINER_ID = "workbench.view.renDocs";
const DOCS_VIEW_ID = "workbench.view.renDocs.main";
const docsIcon = registerIcon(
	"ren-docs-view-icon",
	Codicon.book,
	localize("renDocsIcon", "Docs view icon.")
);

const docsContainer: ViewContainer = Registry.as<IViewContainersRegistry>(
	ViewExtensions.ViewContainersRegistry
).registerViewContainer(
	{
		id: DOCS_CONTAINER_ID,
		title: localize2("renDocsActivityTitle", "Docs"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			DOCS_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		icon: docsIcon,
		hideIfEmpty: false,
	},
	ViewContainerLocation.Sidebar
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: DOCS_VIEW_ID,
			name: localize2("renDocsViewTitle", "Docs"),
			ctorDescriptor: new SyncDescriptor(DocsViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: false,
			order: 1,
		},
	],
	docsContainer
);

// --- Docs Commands ---
const DOCS_INITIALIZE_COMMAND = "ren.docs.initialize";
const DOCS_REGENERATE_FILE_COMMAND = "ren.docs.regenerateFile";
const DOCS_REGENERATE_CHUNK_COMMAND = "ren.docs.regenerateChunk";
const REN_SYMBOL_OPEN_COMMAND = "ren.symbol.open";

if (!CommandsRegistry.getCommand(DOCS_INITIALIZE_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: DOCS_INITIALIZE_COMMAND,
		handler: async (accessor) => {
			const docsService = accessor.get(IDocsService);
			const editorService = accessor.get(IEditorService);
			const chunkIndexService = accessor.get(IChunkIndexService);
			const activeEditor = editorService.activeEditor;
			const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
				supportSideBySide: SideBySideEditor.PRIMARY,
			});

			if (!uri || uri.scheme !== "file") {
				throw new Error("No active file to initialize docs for.");
			}

			// Ensure chunks exist
			const chunks = await chunkIndexService.getChunksForFile(uri);
			if (chunks.length === 0) {
				throw new Error(
					"No chunks found for file. Chunks should be created automatically when file is opened."
				);
			}

			await docsService.generateDocsForFile(uri, "initialize");
		},
	});
}

if (!CommandsRegistry.getCommand(DOCS_REGENERATE_FILE_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: DOCS_REGENERATE_FILE_COMMAND,
		handler: async (accessor) => {
			const docsService = accessor.get(IDocsService);
			const editorService = accessor.get(IEditorService);
			const activeEditor = editorService.activeEditor;
			const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
				supportSideBySide: SideBySideEditor.PRIMARY,
			});

			if (!uri || uri.scheme !== "file") {
				throw new Error("No active file to regenerate docs for.");
			}

			await docsService.generateDocsForFile(uri, "regenerate");
		},
	});
}

if (!CommandsRegistry.getCommand(DOCS_REGENERATE_CHUNK_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: DOCS_REGENERATE_CHUNK_COMMAND,
		handler: async (accessor, chunkId: string) => {
			const docsService = accessor.get(IDocsService);

			if (!chunkId || typeof chunkId !== "string") {
				throw new Error("Chunk ID required.");
			}

			const result = await docsService.regenerateChunk(chunkId);
			if (!result) {
				throw new Error("Failed to regenerate chunk. Chunk may not exist.");
			}
		},
	});
}

// --- Configuration: clickable symbols flag ---
const configurationRegistry = PlatformRegistry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: "renDocs",
    title: localize("renDocsConfigurationTitle", "Ren Docs"),
	type: "object",
	properties: {
		"ren.docs.clickableSymbols.enabled": {
			type: "boolean",
            markdownDescription: localize(
				"renDocs.clickableSymbols.enabled",
				"Controls whether symbol mentions in Docs are clickable to open source or docs."
			),
			default: true,
		},
	},
});

// --- Symbol command: open source / docs ---
if (!CommandsRegistry.getCommand(REN_SYMBOL_OPEN_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: REN_SYMBOL_OPEN_COMMAND,
		handler: async (accessor, args?: {
			uri: { scheme: string; path: string; fsPath?: string; fragment?: string } | string;
			position?: { lineNumber: number; column: number };
			symbolName?: string;
			chunkId?: string;
		}) => {
            const editorService = accessor.get(IEditorService);
            const quickInput = accessor.get(IQuickInputService) as import("../../../../platform/quickinput/common/quickInput.js").IQuickInputService;
            const viewsService = accessor.get(IViewsService);

			if (!args || !args.uri) {
				throw new Error("ren.symbol.open requires args with a uri");
			}

			const uriObj = typeof args.uri === "string" ? URI.parse(args.uri) : URI.from(args.uri as any);

			const picks = [
				{ label: localize("renDocs.openSource", "Open Source"), id: "openSource" },
				{ label: localize("renDocs.openDocs", "Open Docs"), id: "openDocs" },
			] as const;

			const pick = await new Promise<{ id: string } | undefined>((resolve) => {
				const qp = quickInput.createQuickPick();
				qp.items = picks;
				qp.onDidAccept(() => {
					const sel = qp.selectedItems[0];
					qp.hide();
					resolve(sel as any);
				});
				qp.onDidHide(() => resolve(undefined));
				qp.title = localize("renDocs.symbolActions", "Symbol Actions");
				qp.show();
			});

			const action = pick?.id || "openSource";
			if (action === "openSource") {
				await editorService.openEditor({
					resource: uriObj,
					options: args.position
						? { selection: { startLineNumber: args.position.lineNumber, startColumn: args.position.column } }
						: undefined,
				});
				return;
			}

			// Open Docs view and attempt to reveal
			const view = await viewsService.openView<DocsViewPane>(DOCS_VIEW_ID, true);
			if (view && typeof (view as any).revealSymbol === "function") {
				(view as any).revealSymbol(args.chunkId, args.symbolName);
			}
		},
	});
}
