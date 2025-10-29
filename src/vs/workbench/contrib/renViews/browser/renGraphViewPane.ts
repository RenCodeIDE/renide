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

export class RenGraphViewPane extends ViewPane {
	static readonly ID = 'ren.graphView';

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

		// Create a graph view with grid
		const graphContainer = document.createElement('div');
		graphContainer.style.cssText = `
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
		title.textContent = localize('renGraphViewTitle', 'Graph View');
		title.style.cssText = `
			margin: 0 0 20px 0;
			color: var(--vscode-editor-foreground);
			font-size: 18px;
		`;

		// Create grid container
		const gridContainer = document.createElement('div');
		gridContainer.style.cssText = `
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			grid-template-rows: repeat(4, 1fr);
			gap: 10px;
			width: 100%;
			height: calc(100% - 60px);
			min-height: 300px;
		`;

		// Create grid cells
		for (let i = 0; i < 16; i++) {
			const cell = document.createElement('div');
			cell.style.cssText = `
				background-color: var(--vscode-panel-background);
				border: 1px solid var(--vscode-panel-border);
				border-radius: 4px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				color: var(--vscode-panel-foreground);
				cursor: pointer;
				transition: background-color 0.2s ease;
			`;

			cell.textContent = `Cell ${i + 1}`;

			// Add hover effect
			cell.addEventListener('mouseenter', () => {
				cell.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
			});

			cell.addEventListener('mouseleave', () => {
				cell.style.backgroundColor = 'var(--vscode-panel-background)';
			});

			// Add click handler
			cell.addEventListener('click', () => {
				console.log(`Clicked cell ${i + 1}`);
			});

			gridContainer.appendChild(cell);
		}

		graphContainer.appendChild(title);
		graphContainer.appendChild(gridContainer);
		container.appendChild(graphContainer);
	}

	protected override layoutBody(height: number, width: number): void {
		// Handle layout if needed
	}

	getTitle(): string {
		return localize('renGraphView', 'Graph View');
	}
}
