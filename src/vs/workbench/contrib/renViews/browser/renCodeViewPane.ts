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

export class RenCodeViewPane extends ViewPane {
	static readonly ID = 'ren.codeView';

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

		// Create a simple code view interface
		const codeContainer = document.createElement('div');
		codeContainer.style.cssText = `
			width: 100%;
			height: 100%;
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			padding: 20px;
			box-sizing: border-box;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
		`;

		const title = document.createElement('h2');
		title.textContent = localize('renCodeViewTitle', 'Code View');
		title.style.cssText = `
			margin: 0 0 20px 0;
			color: var(--vscode-editor-foreground);
			font-size: 18px;
		`;

		const description = document.createElement('p');
		description.textContent = localize('renCodeViewDescription', 'This is where you can view and edit your code files. The file explorer on the left will show your project structure.');
		description.style.cssText = `
			margin: 0;
			color: var(--vscode-descriptionForeground);
			line-height: 1.5;
		`;

		codeContainer.appendChild(title);
		codeContainer.appendChild(description);
		container.appendChild(codeContainer);
	}

	protected override layoutBody(height: number, width: number): void {
		// Handle layout if needed
	}

	getTitle(): string {
		return localize('renCodeView', 'Code View');
	}
}
