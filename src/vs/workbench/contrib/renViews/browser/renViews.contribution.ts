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
import { DocsViewPane } from "./views/docsView/docsViewPane.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import {
	IQuickInputService,
	IQuickPickItem,
} from "../../../../platform/quickinput/common/quickInput.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import {
	IConfigurationRegistry,
	Extensions as ConfigurationExtensions,
	ConfigurationScope,
} from "../../../../platform/configuration/common/configurationRegistry.js";
import { IDocsService } from "./services/docsService.js";
import { IDocsPreparationService } from "./services/docsPreparationService.js";
import {
	IChunkSearchService,
	ChunkSearchResult,
} from "./services/chunkSearchService.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import "./renWorkspaceStore.js";
import "./renChangelogBuffer.js";
import {
	IProgressService,
	ProgressLocation,
} from "../../../../platform/progress/common/progress.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import {
	MenuId,
	MenuRegistry,
} from "../../../../platform/actions/common/actions.js";
import { joinPath } from "../../../../base/common/resources.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
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
import { MonitorXChangelogToolsContribution } from "./monitorXChangelogToolsContribution.js";
import { MonitorXViewPane } from "./views/monitorXView/monitorXViewPane.js";

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
				const toDelete = new Set(overlayWidgets.keys());
				const toDeleteViewOverlays = new Set(viewOverlays.keys());
				const toDeleteViewButtons = new Set(viewButtonsWidgets.keys());
				const groups = editorGroups.read(r);

				for (const group of groups) {
					if (!(group instanceof EditorGroupView)) {
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
						// Ensure container has relative positioning for absolute positioning of buttons
						if (
							container.style.position !== "relative" &&
							container.style.position !== "absolute"
						) {
							container.style.position = "relative";
						}
						const viewButtons = new ViewButtons(container);
						viewButtonsWidgets.set(group, viewButtons);
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
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench
);
workbenchRegistry.registerWorkbenchContribution(
	RenViewsContribution,
	LifecyclePhase.Restored
);
workbenchRegistry.registerWorkbenchContribution(
	GraphToolsContribution,
	LifecyclePhase.Restored
);
workbenchRegistry.registerWorkbenchContribution(
	MonitorXChangelogToolsContribution,
	LifecyclePhase.Restored
);


// --- MonitorX Container & View Registration ---
const MONITORX_CONTAINER_ID = "workbench.view.monitorX";
const MONITORX_VIEW_ID = "workbench.view.monitorX.changelog";
const monitorXIcon = registerIcon(
	"ren-monitorx-view-icon",
	Codicon.history, // Using history icon for changelog
	localize("monitorXViewIcon", "MonitorX view icon.")
);

const monitorXContainer: ViewContainer = Registry.as<IViewContainersRegistry>(
	ViewExtensions.ViewContainersRegistry
).registerViewContainer(
	{
		id: MONITORX_CONTAINER_ID,
		title: localize2("monitorXActivityTitle", "MonitorX"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			MONITORX_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		icon: monitorXIcon,
		hideIfEmpty: false,
	},
	ViewContainerLocation.Sidebar
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: MONITORX_VIEW_ID,
			name: localize2("monitorXViewTitle", "Changelog"),
			ctorDescriptor: new SyncDescriptor(MonitorXViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: false,
			order: 1,
		},
	],
	monitorXContainer
);


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
const REN_SYMBOL_OPEN_COMMAND = "ren.symbol.open";

if (!CommandsRegistry.getCommand(DOCS_INITIALIZE_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: DOCS_INITIALIZE_COMMAND,
		handler: async (accessor) => {
			const docsService = accessor.get(IDocsService);
			const editorService = accessor.get(IEditorService);
			const activeEditor = editorService.activeEditor;
			const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
				supportSideBySide: SideBySideEditor.PRIMARY,
			});

			if (!uri || uri.scheme !== "file") {
				throw new Error("No active file to initialize docs for.");
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

const VECTORIZE_INDEX_FILE_COMMAND = "ren.vectorization.indexCurrentFileChunks";

if (!CommandsRegistry.getCommand(VECTORIZE_INDEX_FILE_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: VECTORIZE_INDEX_FILE_COMMAND,
		handler: async (accessor) => {
			const editorService = accessor.get(IEditorService);
			const docsPreparationService = accessor.get(IDocsPreparationService);
			const progressService = accessor.get(IProgressService);
			const notificationService = accessor.get(INotificationService);

			const activeEditor = editorService.activeEditor;
			const resource = EditorResourceAccessor.getOriginalUri(activeEditor, {
				supportSideBySide: SideBySideEditor.PRIMARY,
			});

			if (!resource || resource.scheme !== "file") {
				throw new Error("No active file to index chunks for.");
			}

			const fileLabel =
				(resource.path && resource.path.split("/").pop()) ||
				resource.fsPath ||
				resource.toString();

			try {
				await progressService.withProgress(
					{
						location: ProgressLocation.Notification,
						title: localize(
							"ren.vectorization.indexFile.progress",
							"Indexing chunks for {0}…",
							fileLabel
						),
					},
					async () => {
						await docsPreparationService.prepareFile(resource);
					}
				);

				notificationService.info(
					localize(
						"ren.vectorization.indexFile.success",
						"Queued chunks from {0} for vector indexing.",
						fileLabel
					)
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: String(error ?? "Unknown error");
				notificationService.error(
					localize(
						"ren.vectorization.indexFile.error",
						"Failed to index chunks for {0}: {1}",
						fileLabel,
						message
					)
				);
				throw error;
			}
		},
	});

	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: {
			id: VECTORIZE_INDEX_FILE_COMMAND,
			title: localize(
				"ren.vectorization.indexFile.commandTitle",
				"Ren: Index Current File Chunks"
			),
			category: localize("ren.vectorization.category", "Ren Vectorization"),
		},
	});
}

const VECTORIZE_SEARCH_COMMAND = "ren.vectorization.searchChunks";

if (!CommandsRegistry.getCommand(VECTORIZE_SEARCH_COMMAND)) {
	type ChunkSearchQuickPickItem = IQuickPickItem & {
		result: ChunkSearchResult;
		uri?: URI;
	};

	CommandsRegistry.registerCommand({
		id: VECTORIZE_SEARCH_COMMAND,
		handler: async (accessor) => {
			const quickInputService = accessor.get(IQuickInputService);
			const chunkSearchService = accessor.get(IChunkSearchService);
			const progressService = accessor.get(IProgressService);
			const notificationService = accessor.get(INotificationService);
			const editorService = accessor.get(IEditorService);
			const workspaceService = accessor.get(IWorkspaceContextService);

			const query = await quickInputService.input({
				title: localize(
					"ren.vectorization.search.inputTitle",
					"Search Vectorized Code Chunks"
				),
				prompt: localize(
					"ren.vectorization.search.prompt",
					"Enter keywords to search across indexed chunks."
				),
				placeHolder: localize(
					"ren.vectorization.search.placeholder",
					"eg. database connection pool"
				),
			});

			if (!query || !query.trim()) {
				return;
			}

			let results: ChunkSearchResult[];
			try {
				results = await progressService.withProgress(
					{
						location: ProgressLocation.Notification,
						title: localize(
							"ren.vectorization.search.progress",
							"Searching vectorized chunks…"
						),
					},
					async () => chunkSearchService.search(query, 10)
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: String(error ?? "Unknown error");
				notificationService.error(
					localize(
						"ren.vectorization.search.error",
						"Vector search failed: {0}",
						message
					)
				);
				throw error;
			}

			if (!results.length) {
				notificationService.info(
					localize(
						"ren.vectorization.search.noResults",
						"No indexed chunks matched “{0}”.",
						query.trim()
					)
				);
				return;
			}

			const workspace = workspaceService.getWorkspace();
			const folders = workspace?.folders ?? [];

			const resolveUri = (filePath: string): URI | undefined => {
				const normalized = filePath.replace(/\\/g, "/").trim();
				if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) {
					try {
						return URI.parse(normalized);
					} catch {
						return undefined;
					}
				}

				if (normalized.startsWith("/")) {
					return URI.file(normalized);
				}

				if (!folders.length) {
					return undefined;
				}

				if (folders.length === 1) {
					return joinPath(folders[0].uri, normalized);
				}

				for (const folder of folders) {
					const prefix = folder.name || folder.uri.toString();
					if (normalized === prefix) {
						return folder.uri;
					}
					if (normalized.startsWith(`${prefix}/`)) {
						const relative = normalized.substring(prefix.length + 1);
						return joinPath(folder.uri, relative);
					}
				}

				return undefined;
			};

			const items: ChunkSearchQuickPickItem[] = results.map((result) => {
				const startLine = Math.max(1, Math.floor(result.startLine) + 1);
				const endLine = Math.max(
					startLine,
					Math.floor(result.endLine) + 1
				);
				const uri = resolveUri(result.filePath);
				return {
					label: result.filePath || localize(
						"ren.vectorization.search.unknownFile",
						"Unknown file"
					),
					description: localize(
						"ren.vectorization.search.itemDescription",
						"Lines {0}–{1}",
						startLine,
						endLine
					),
					detail: localize(
						"ren.vectorization.search.itemScore",
						"Score {0}",
						Number.isFinite(result.score)
							? result.score.toFixed(3)
							: String(result.score ?? 0)
					),
					result,
					uri,
				};
			});

			const quickPick =
				quickInputService.createQuickPick<ChunkSearchQuickPickItem>();
			quickPick.title = localize(
				"ren.vectorization.search.quickPickTitle",
				"Vectorized Chunk Results"
			);
			quickPick.items = items;
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.onDidAccept(async () => {
				const selection = quickPick.selectedItems[0];
				if (selection) {
					const targetUri =
						selection.uri ?? resolveUri(selection.result.filePath);
					if (!targetUri) {
						notificationService.warn(
							localize(
								"ren.vectorization.search.missingFile",
								"Cannot resolve “{0}” in the current workspace.",
								selection.result.filePath
							)
						);
					} else {
						const startLineNumber = Math.max(
							1,
							Math.floor(selection.result.startLine) + 1
						);
						const endLineNumber = Math.max(
							startLineNumber,
							Math.floor(selection.result.endLine) + 1
						);
						await editorService.openEditor({
							resource: targetUri,
							options: {
								selection: {
									startLineNumber,
									startColumn: 1,
									endLineNumber,
									endColumn: 1,
								},
								revealIfOpened: true,
								pinned: true,
							},
						});
					}
				}
				quickPick.hide();
			});
			quickPick.onDidHide(() => quickPick.dispose());
			quickPick.show();
		},
	});

	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: {
			id: VECTORIZE_SEARCH_COMMAND,
			title: localize(
				"ren.vectorization.search.commandTitle",
				"Ren: Search Vectorized Code Chunks"
			),
			category: localize("ren.vectorization.category", "Ren Vectorization"),
		},
	});
}

// --- Configuration: clickable symbols flag ---
const configurationRegistry = Registry.as<IConfigurationRegistry>(
	ConfigurationExtensions.Configuration
);
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

configurationRegistry.registerConfiguration({
	id: "renVectorization",
	title: localize("ren.vectorization.configurationTitle", "Ren Vectorization"),
	type: "object",
	properties: {
		"ren.vectorization.enabled": {
			type: "boolean",
			default: false,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				"ren.vectorization.enabled",
				"Enable indexing of code chunks into Ren's vector service to power in-IDE semantic search. When enabled, relevant code snippets are sent to the configured Ren backend."
			),
		},
		"ren.vectorization.debounceMs": {
			type: "number",
			default: 400,
			minimum: 0,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				"ren.vectorization.debounceMs",
				"Delay in milliseconds before batching and sending updated chunks to the vector service."
			),
		},
		"ren.vectorization.maxBatchSize": {
			type: "number",
			default: 8,
			minimum: 1,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				"ren.vectorization.maxBatchSize",
				"Maximum number of chunks to send in a single batch to the vector service."
			),
		},
		"ren.vectorization.excludeGlobs": {
			type: "array",
			default: [],
			scope: ConfigurationScope.WINDOW,
			items: {
				type: "string",
			},
			markdownDescription: localize(
				"ren.vectorization.excludeGlobs",
				"List of glob patterns to exclude from vector indexing (for example, `**/secrets/**`)."
			),
		},
	},
});

// --- Symbol command: open source / docs ---
if (!CommandsRegistry.getCommand(REN_SYMBOL_OPEN_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: REN_SYMBOL_OPEN_COMMAND,
		handler: async (
			accessor,
			args?: {
				uri:
					| { scheme: string; path: string; fsPath?: string; fragment?: string }
					| string;
			position?: { lineNumber: number; column: number };
			symbolName?: string;
			chunkId?: string;
			}
		) => {
            const editorService = accessor.get(IEditorService);
			const quickInput = accessor.get(
				IQuickInputService
			) as import("../../../../platform/quickinput/common/quickInput.js").IQuickInputService;
            const viewsService = accessor.get(IViewsService);

			if (!args || !args.uri) {
				throw new Error("ren.symbol.open requires args with a uri");
			}

			const uriObj =
				typeof args.uri === "string"
					? URI.parse(args.uri)
					: URI.from(args.uri as any);

			const picks = [
				{
					label: localize("renDocs.openSource", "Open Source"),
					id: "openSource",
				},
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
						? {
								selection: {
									startLineNumber: args.position.lineNumber,
									startColumn: args.position.column,
								},
						  }
						: undefined,
				});
				return;
			}

			// Open Docs view and attempt to reveal
			const view = await viewsService.openView<DocsViewPane>(
				DOCS_VIEW_ID,
				true
			);
			if (view && typeof (view as any).revealSymbol === "function") {
				(view as any).revealSymbol(args.chunkId, args.symbolName);
			}
		},
	});
}
