/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from '../../common/renWorkspaceStore.js';
import { renderMonitorXChangelog } from './monitorXChangelogRenderer.js';

export class MonitorXChangelogViewPane extends ViewPane {
	private bodyContainer!: HTMLElement;
	private changelogContainer!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.bodyContainer = document.createElement('div');
		this.bodyContainer.className = 'monitorx-pane-container';
		container.appendChild(this.bodyContainer);

		this.changelogContainer = document.createElement('div');
		this.changelogContainer.className = 'ren-monitorx-changelog-body';
		this.bodyContainer.appendChild(this.changelogContainer);

		this.renderEntries();
		this._register(this.workspaceStore.onDidChangeChangelog(entries => this.updateEntries(entries)));
	}

	protected override layoutBody(height: number, width: number): void {
		this.bodyContainer.style.height = `${height}px`;
		this.bodyContainer.style.overflow = 'hidden';
		this.changelogContainer.style.height = '100%';
	}

	private async renderEntries(): Promise<void> {
		const entries = await this.workspaceStore.getAllChangelogEntries();
		this.updateEntries(entries);
	}

	private updateEntries(entries: IMonitorXChangelogEntry[]): void {
		renderMonitorXChangelog(this.changelogContainer, entries, {
			emptyMessage: localize('monitorx.changelog.empty', "No MonitorX activity recorded yet."),
			limit: 50
		});
	}
}

