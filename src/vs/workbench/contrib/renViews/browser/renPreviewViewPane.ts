/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

export class RenPreviewViewPane extends ViewPane {
	static readonly ID = 'ren.previewView';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@IHoverService hoverService: IHoverService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Create a simple preview view interface
		const previewContainer = document.createElement('div');
		previewContainer.style.cssText = `
			width: 100%;
			height: 100%;
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			padding: 20px;
			box-sizing: border-box;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
		`;

		const title = document.createElement('h2');
		title.textContent = localize('renPreviewViewTitle', 'Preview View');
		title.style.cssText = `
			margin: 0 0 20px 0;
			color: var(--vscode-editor-foreground);
			font-size: 18px;
		`;

		const description = document.createElement('p');
		description.textContent = localize('renPreviewViewDescription', 'This preview view is currently empty. You can add content here later.');
		description.style.cssText = `
			margin: 0;
			color: var(--vscode-descriptionForeground);
			line-height: 1.5;
			text-align: center;
		`;

		previewContainer.appendChild(title);
		previewContainer.appendChild(description);
		container.appendChild(previewContainer);
	}

	protected override layoutBody(height: number, width: number): void {
		// Handle layout if needed
	}

	getTitle(): string {
		return localize('renPreviewView', 'Preview View');
	}
}
