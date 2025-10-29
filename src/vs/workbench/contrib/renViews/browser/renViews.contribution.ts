/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
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
import { RenMainWindowOverlay } from './renMainWindowOverlay.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';

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

					const overlay = scopedInstaService.createInstance(RenMainWindowOverlay, container, group);
					overlayWidgets.set(group, combinedDisposable(overlay, scopedInstaService));
				}
			}

			for (const group of toDelete) {
				overlayWidgets.deleteAndDispose(group);
			}
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
