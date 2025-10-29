/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { RenCodeViewPane } from './renCodeViewPane.js';
import { RenPreviewViewPane } from './renPreviewViewPane.js';
import { RenGraphViewPane } from './renGraphViewPane.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

// Register icons for our custom views
const renCodeViewIcon = registerIcon('ren-code-view-icon', Codicon.code, localize('renCodeViewIcon', 'View icon of the Ren Code view.'));
const renPreviewViewIcon = registerIcon('ren-preview-view-icon', Codicon.eye, localize('renPreviewViewIcon', 'View icon of the Ren Preview view.'));
const renGraphViewIcon = registerIcon('ren-graph-view-icon', Codicon.graph, localize('renGraphViewIcon', 'View icon of the Ren Graph view.'));

// View container for Ren IDE views
export const REN_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: 'ren.views',
	title: localize2('renViews', "Ren Views"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['ren.views', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'ren.views.state',
	icon: renCodeViewIcon,
	order: 1,
	openCommandActionDescriptor: {
		id: 'ren.views',
		title: localize2('renViews', "Ren Views"),
		mnemonicTitle: localize({ key: 'miViewRenViews', comment: ['&& denotes a mnemonic'] }, "&&Ren Views"),
		order: 1
	},
}, ViewContainerLocation.Sidebar);

// Register the views
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: 'ren.codeView',
		name: localize2('renCodeView', "Code View"),
		canToggleVisibility: true,
		ctorDescriptor: new SyncDescriptor(RenCodeViewPane),
		canMoveView: true,
		containerIcon: renCodeViewIcon,
		focusCommand: {
			id: 'ren.focusCodeView'
		}
	},
	{
		id: 'ren.previewView',
		name: localize2('renPreviewView', "Preview View"),
		canToggleVisibility: true,
		ctorDescriptor: new SyncDescriptor(RenPreviewViewPane),
		canMoveView: true,
		containerIcon: renPreviewViewIcon,
		focusCommand: {
			id: 'ren.focusPreviewView'
		}
	},
	{
		id: 'ren.graphView',
		name: localize2('renGraphView', "Graph View"),
		canToggleVisibility: true,
		ctorDescriptor: new SyncDescriptor(RenGraphViewPane),
		canMoveView: true,
		containerIcon: renGraphViewIcon,
		focusCommand: {
			id: 'ren.focusGraphView'
		}
	}
], REN_VIEW_CONTAINER);

export class RenViewsContribution implements IWorkbenchContribution {
	constructor() {
		// This contribution just registers the views above
	}
}

// Register the contribution
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RenViewsContribution, LifecyclePhase.Restored);
