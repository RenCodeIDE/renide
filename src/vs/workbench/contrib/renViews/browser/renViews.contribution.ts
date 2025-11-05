import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { DisposableStore, DisposableMap, combinedDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { observableFromEvent, autorun } from '../../../../base/common/observable.js';
import { EditorGroupView } from '../../../browser/parts/editor/editorGroupView.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import './styles/renViews.css';
import { EnvOverlay } from './envOverlay.js';
import { RenMainWindowOverlay } from './renMainWindowOverlay.js';
import { ViewButtons } from './components/viewButtons.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewContainerLocation, IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions, ViewContainer } from '../../../common/views.js';
import { MonitorXChangelogViewPane } from './views/monitorXChangelogViewPane.js';
import { DocsViewPane } from './views/docsView/docsViewPane.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntryInput, IMonitorXChangelogFileChange } from '../common/renWorkspaceStore.js';
import './renWorkspaceStore.js';
import './renChangelogBuffer.js';
import { MonitorXChangelogToolContribution } from './monitorXChangelogTool.js';
import { isWeb } from '../../../../base/common/platform.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IGitHeatmapService, NullGitHeatmapService } from '../../../../platform/gitHeatmap/common/gitHeatmapService.js';

if (isWeb) {
	registerSingleton(IGitHeatmapService, NullGitHeatmapService, InstantiationType.Delayed);
}

export class RenViewsContribution implements IWorkbenchContribution {
	static readonly ID = 'ren.views.contribution';

	private readonly _store = new DisposableStore();

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		console.log('[RenViewsContribution] Constructor called, initializing...');
		// Set up EnvOverlay for each editor group (for .env file overlays)
		const editorGroups = observableFromEvent(
			this,
			Event.any(editorGroupsService.onDidAddGroup, editorGroupsService.onDidRemoveGroup),
			() => editorGroupsService.groups
		);

		const overlayWidgets = new DisposableMap<EditorGroupView>();
		const viewOverlays = new DisposableMap<EditorGroupView>();
		const viewButtonsWidgets = new Map<EditorGroupView, ViewButtons>();

		this._store.add(autorun(r => {
			console.log('[RenViewsContribution] Autorun executing, processing editor groups...');
			const toDelete = new Set(overlayWidgets.keys());
			const toDeleteViewOverlays = new Set(viewOverlays.keys());
			const toDeleteViewButtons = new Set(viewButtonsWidgets.keys());
			const groups = editorGroups.read(r);
			console.log(`[RenViewsContribution] Found ${groups.length} editor groups`);

			for (const group of groups) {
				if (!(group instanceof EditorGroupView)) {
					console.log('[RenViewsContribution] Skipping non-EditorGroupView:', group);
					continue;
				}

				toDelete.delete(group);
				toDeleteViewOverlays.delete(group);
				toDeleteViewButtons.delete(group);

				if (!overlayWidgets.has(group)) {
					const scopedInstaService = instantiationService.createChild(new ServiceCollection());
					const container = group.element;
					const editorContent = container.querySelector('.editor-container') as HTMLElement | null;
					const getGroupResource = () => EditorResourceAccessor.getOriginalUri(group.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
					const envOverlay = scopedInstaService.createInstance(EnvOverlay, editorContent ?? container, getGroupResource);
					overlayWidgets.set(group, combinedDisposable(envOverlay, scopedInstaService));
				}

				// Create RenMainWindowOverlay for each editor group
				if (!viewOverlays.has(group)) {
					const container = group.element;
					const scopedInstaService = instantiationService.createChild(new ServiceCollection());
					const viewOverlay = scopedInstaService.createInstance(RenMainWindowOverlay, container);
					viewOverlays.set(group, combinedDisposable(viewOverlay, scopedInstaService));
				}

				// Attach ViewButtons to each editor group container
				if (!viewButtonsWidgets.has(group)) {
					const container = group.element;
					console.log('[RenViewsContribution] Creating ViewButtons for editor group:', container);
					// Ensure container has relative positioning for absolute positioning of buttons
					if (container.style.position !== 'relative' && container.style.position !== 'absolute') {
						container.style.position = 'relative';
					}
					const viewButtons = new ViewButtons(container);
					viewButtonsWidgets.set(group, viewButtons);
					console.log('[RenViewsContribution] ViewButtons created and attached:', viewButtons.element);
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
		}));

		// Clean up view buttons on dispose
		this._store.add({
			dispose: () => {
				for (const viewButtons of viewButtonsWidgets.values()) {
					viewButtons.dispose();
				}
				viewButtonsWidgets.clear();
			}
		});
	}

	dispose(): void {
		this._store.dispose();
	}
}

// Register the contribution
console.log('[RenViewsContribution] Registering workbench contribution...');
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RenViewsContribution, LifecyclePhase.Restored);
workbenchRegistry.registerWorkbenchContribution(MonitorXChangelogToolContribution, LifecyclePhase.Restored);
console.log('[RenViewsContribution] Workbench contribution registered successfully');

const MONITORX_CHANGELOG_CONTAINER_ID = 'workbench.view.monitorxChangelog';
const MONITORX_CHANGELOG_VIEW_ID = 'workbench.view.monitorxChangelog.entries';
const monitorXChangelogIcon = registerIcon('monitorx-changelog-view-icon', Codicon.history, localize('monitorxChangelogIcon', "MonitorX changelog view icon."));

const monitorXChangelogContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: MONITORX_CHANGELOG_CONTAINER_ID,
	title: localize2('monitorxActivityTitle', "MonitorX"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MONITORX_CHANGELOG_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: monitorXChangelogIcon,
	hideIfEmpty: false
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: MONITORX_CHANGELOG_VIEW_ID,
		name: localize2('monitorxChangelogViewTitle', "MonitorX Changelog"),
		ctorDescriptor: new SyncDescriptor(MonitorXChangelogViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		collapsed: false,
		order: 10
	}
], monitorXChangelogContainer);

const MONITORX_ADD_CHANGELOG_COMMAND = 'ren.monitorx.addChangelogEntry';
const MONITORX_GET_CHANGELOG_COMMAND = 'ren.monitorx.getRecentChangelogEntries';

if (!CommandsRegistry.getCommand(MONITORX_ADD_CHANGELOG_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: MONITORX_ADD_CHANGELOG_COMMAND,
		handler: async (accessor, args: Partial<IMonitorXChangelogEntryInput> | undefined) => {
			const workspaceStore = accessor.get(IRenWorkspaceStore);
			if (!args) {
				throw new Error('monitorx.addChangelogEntry requires an argument payload.');
			}

			const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
			if (!subject) {
				throw new Error('monitorx.addChangelogEntry requires a non-empty subject string.');
			}

			const description = typeof args.description === 'string' ? args.description : '';
			const filesInput = Array.isArray(args.files) ? args.files : [];
			const files: IMonitorXChangelogFileChange[] = [];
			for (const file of filesInput) {
				if (!file || typeof file !== 'object') {
					continue;
				}
				const record = file as Record<string, unknown>;
				const path = typeof record.path === 'string' ? record.path : undefined;
				const diff = typeof record.diff === 'string' ? record.diff : undefined;
				if (path && diff !== undefined) {
					files.push({ path, diff });
				}
			}
			if (!files.length) {
				throw new Error('monitorx.addChangelogEntry requires at least one file change with path and diff.');
			}

			const graphRecord = args.graph && typeof args.graph === 'object' && !Array.isArray(args.graph) ? args.graph as Record<string, unknown> : undefined;
			const graphInput = graphRecord ? {
				uri: typeof graphRecord.uri === 'string' ? graphRecord.uri : undefined,
				summary: typeof graphRecord.summary === 'string' ? graphRecord.summary : undefined
			} : undefined;
			const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata) ? args.metadata as Record<string, unknown> : undefined;

			const entryInput: IMonitorXChangelogEntryInput = {
				subject,
				description,
				files,
				...(graphInput && (graphInput.uri || (graphInput.summary && graphInput.summary.trim())) ? { graph: graphInput } : {}),
				...(metadata ? { metadata } : {}),
				timestamp: typeof args.timestamp === 'number' ? args.timestamp : undefined
			};

			const entry = await workspaceStore.addChangelogEntry(entryInput);
			return { ...entry };
		}
	});
}

if (!CommandsRegistry.getCommand(MONITORX_GET_CHANGELOG_COMMAND)) {
	CommandsRegistry.registerCommand({
		id: MONITORX_GET_CHANGELOG_COMMAND,
		handler: async (accessor, args: { limit?: number } | undefined) => {
			const workspaceStore = accessor.get(IRenWorkspaceStore);
			const limit = args && typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 10;
			const entries = await workspaceStore.getRecentChangelogEntries(limit);
			return entries.map(entry => ({ ...entry }));
		}
	});
}

// --- Docs Container & View Registration ---
const DOCS_CONTAINER_ID = 'workbench.view.renDocs';
const DOCS_VIEW_ID = 'workbench.view.renDocs.main';
const docsIcon = registerIcon('ren-docs-view-icon', Codicon.book, localize('renDocsIcon', "Docs view icon."));

const docsContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: DOCS_CONTAINER_ID,
	title: localize2('renDocsActivityTitle', "Docs"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [DOCS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: docsIcon,
	hideIfEmpty: false
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: DOCS_VIEW_ID,
		name: localize2('renDocsViewTitle', "Docs"),
		ctorDescriptor: new SyncDescriptor(DocsViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		collapsed: false,
		order: 1
	}
], docsContainer);
