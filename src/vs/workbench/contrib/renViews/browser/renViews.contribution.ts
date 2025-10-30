import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { DisposableStore, DisposableMap, combinedDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { observableFromEvent, autorun } from '../../../../base/common/observable.js';
import { EditorGroupView } from '../../../browser/parts/editor/editorGroupView.js';
import { RenMainWindowOverlay } from './renMainWindowOverlay.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { ChatViewPane } from '../../chat/browser/chatViewPane.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { Schemas } from '../../../../base/common/network.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import './styles/renViews.css';
import { EnvOverlay } from './envOverlay.js';

export class RenViewsContribution implements IWorkbenchContribution {
	static readonly ID = 'ren.views.contribution';

	private readonly _store = new DisposableStore();

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const editorGroups = observableFromEvent(
			this,
			Event.any(editorGroupsService.onDidAddGroup, editorGroupsService.onDidRemoveGroup),
			() => editorGroupsService.groups
		);

		const overlayWidgets = new DisposableMap<EditorGroupView>();

		this._store.add(autorun(r => {
			const toDelete = new Set(overlayWidgets.keys());
			const groups = editorGroups.read(r);

			for (const group of groups) {
				if (!(group instanceof EditorGroupView)) {
					continue;
				}

				toDelete.delete(group);


				if (!overlayWidgets.has(group)) {
					const scopedInstaService = instantiationService.createChild(new ServiceCollection());
					const container = group.element;

					const overlay = scopedInstaService.createInstance(RenMainWindowOverlay, container);
					// Try to scope the .env overlay to the editor content, not the whole group
					const editorContent = container.querySelector('.editor-container') as HTMLElement | null;
					const getGroupResource = () => EditorResourceAccessor.getOriginalUri(group.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
					const envOverlay = scopedInstaService.createInstance(EnvOverlay, editorContent ?? container, getGroupResource);
					overlayWidgets.set(group, combinedDisposable(overlay, envOverlay, scopedInstaService));
				}

				// GlobalRenToolbar removed to prevent duplicate view switchers; toolbar handled by RenToolbarManager inside overlay
			}

			for (const group of toDelete) {
				overlayWidgets.deleteAndDispose(group);
			}

			// No toolbarByGroup cleanup needed since GlobalRenToolbar is no longer used
		}));
	}

	dispose(): void {
		this._store.dispose();
	}
}

// Register the contribution
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RenViewsContribution, LifecyclePhase.Restored);

// Register commands for switching views
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'ren.showCodeView',
			title: { value: localize('ren.showCodeView', 'Show Code View'), original: 'Show Code View' },
			category: Categories.View,
			f1: true
		});
	}
	run() {
		// Command will be handled by the overlay
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'ren.showPreviewView',
			title: { value: localize('ren.showPreviewView', 'Show Preview View'), original: 'Show Preview View' },
			category: Categories.View,
			f1: true
		});
	}
	run() {
		// Command will be handled by the overlay
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'ren.showGraphView',
			title: { value: localize('ren.showGraphView', 'Show Graph View'), original: 'Show Graph View' },
			category: Categories.View,
			f1: true
		});
	}
	run() {
		// Command will be handled by the overlay
	}
});

// Register Cmd+L command to add selected text to chat or open chat
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'ren.addSelectionToChat',
			title: { value: localize('ren.addSelectionToChat', 'Add Selection to Chat'), original: 'Add Selection to Chat' },
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				when: undefined,
				weight: 100
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);

		// Get the active editor
		const activeEditor = editorService.activeTextEditorControl;
		const activeUri = EditorResourceAccessor.getCanonicalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });

		// Open chat view
		const chatViewPane = await viewsService.openView<ChatViewPane>(ChatViewId);
		if (!chatViewPane) {
			return;
		}

		// Get the chat widget
		const chatWidget = chatViewPane.widget;
		if (!chatWidget) {
			return;
		}

		// Focus the chat input
		chatWidget.focusInput();

		// If there's an active editor with selected text, add it to chat
		if (activeEditor && activeUri && [Schemas.file, Schemas.vscodeRemote, Schemas.untitled].includes(activeUri.scheme)) {
			const selection = activeEditor.getSelection();
			if (selection && !selection.isEmpty()) {
				// Get the selected text and add to chat input
				// Note: Text selection handling can be added here if needed
			}
		}
	}
});
