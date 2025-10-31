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
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntryInput } from '../common/renWorkspaceStore.js';
import './renWorkspaceStore.js';
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
					// Ensure container has relative positioning for absolute positioning of buttons
					if (container.style.position !== 'relative' && container.style.position !== 'absolute') {
						container.style.position = 'relative';
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
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RenViewsContribution, LifecyclePhase.Restored);

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
			if (!args || typeof args.filePath !== 'string' || typeof args.diff !== 'string' || typeof args.reason !== 'string') {
				throw new Error('monitorx.addChangelogEntry requires filePath, diff, and reason strings.');
			}
			const entry = await workspaceStore.addChangelogEntry({
				filePath: args.filePath,
				diff: args.diff,
				reason: args.reason,
				timestamp: typeof args.timestamp === 'number' ? args.timestamp : undefined
			});
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
