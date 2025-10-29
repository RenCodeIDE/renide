/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export type RenViewMode = 'code' | 'preview' | 'graph';

export class RenMainWindowOverlay {
	private readonly _store = new DisposableStore();
	private readonly _overlayElement = document.createElement('div');
	private readonly _toolbarElement = document.createElement('div');
	private readonly _currentMode: IContextKey<RenViewMode>;

	constructor(
		private readonly container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService
	) {
		this._currentMode = this.contextKeyService.createKey('ren.currentViewMode', 'code');

		this.setupOverlay();
		this.setupCommands();
	}

	private setupOverlay(): void {
		// Setup editor group toolbar (always visible)
		this.setupEditorGroupToolbar();

		// Setup overlay for content (hidden in code view)
		this._overlayElement.style.cssText = `
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			z-index: 1000;
			display: none;
			flex-direction: column;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
		`;

		// Add content area
		const contentArea = document.createElement('div');
		contentArea.style.cssText = `
			flex: 1;
			padding: 20px;
			overflow: auto;
		`;
		contentArea.id = 'ren-content-area';
		this._overlayElement.appendChild(contentArea);

		this.container.appendChild(this._overlayElement);
		this._store.add(toDisposable(() => this._overlayElement.remove()));

		// Initially show code view (normal editor)
		this.showCodeView();
	}

	private setupEditorGroupToolbar(): void {
		// Find the editor group's toolbar area
		const toolbarArea = this.container.querySelector('.editor-group-container .editor-group-title') as HTMLElement;
		if (!toolbarArea) {
			// Fallback: create toolbar at top of container
			this._toolbarElement.style.cssText = `
				position: absolute;
				top: 0;
				right: 0;
				display: flex;
				padding: 8px;
				background-color: var(--vscode-panel-background);
				border-bottom: 1px solid var(--vscode-panel-border);
				border-radius: 0 0 0 4px;
				gap: 8px;
				z-index: 10;
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
				pointer-events: auto;
			`;
		} else {
			// Insert toolbar into the editor group title area
			this._toolbarElement.style.cssText = `
				display: flex;
				padding: 4px 8px;
				background-color: var(--vscode-panel-background);
				border-radius: 4px;
				gap: 4px;
				margin-left: auto;
			`;
			toolbarArea.appendChild(this._toolbarElement);
		}

		const codeButton = this.createViewButton('Code', 'code');
		const previewButton = this.createViewButton('Preview', 'preview');
		const graphButton = this.createViewButton('Graph', 'graph');

		this._toolbarElement.appendChild(codeButton);
		this._toolbarElement.appendChild(previewButton);
		this._toolbarElement.appendChild(graphButton);

		// If we couldn't find the toolbar area, add to container
		if (!toolbarArea) {
			this.container.appendChild(this._toolbarElement);
		}

		this._store.add(toDisposable(() => this._toolbarElement.remove()));
	}

	private createViewButton(title: string, mode: RenViewMode): HTMLElement {
		const button = document.createElement('button');
		button.textContent = title;
		button.dataset.mode = mode;
		button.style.cssText = `
			padding: 4px 8px;
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 3px;
			cursor: pointer;
			font-size: 12px;
			min-width: 50px;
		`;

		button.addEventListener('click', () => {
			this.switchToView(mode);
		});

		button.addEventListener('mouseenter', () => {
			button.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
		});

		button.addEventListener('mouseleave', () => {
			button.style.backgroundColor = 'var(--vscode-button-background)';
		});

		return button;
	}

	private switchToView(mode: RenViewMode): void {
		this._currentMode.set(mode);

		const contentArea = this._overlayElement.querySelector('#ren-content-area') as HTMLElement;

		// Update button states
		this.updateButtonStates();

		switch (mode) {
			case 'code':
				this.showCodeView();
				break;
			case 'preview':
				this.showPreviewView(contentArea);
				break;
			case 'graph':
				this.showGraphView(contentArea);
				break;
		}
	}

	private updateButtonStates(): void {
		const currentMode = this._currentMode.get();
		const buttons = this._toolbarElement.querySelectorAll('button[data-mode]');

		buttons.forEach(button => {
			const htmlButton = button as HTMLElement;
			const mode = htmlButton.getAttribute('data-mode') as RenViewMode;
			if (mode === currentMode) {
				// Active button
				htmlButton.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
				htmlButton.style.color = 'var(--vscode-button-secondaryForeground)';
			} else {
				// Inactive button
				htmlButton.style.backgroundColor = 'var(--vscode-button-background)';
				htmlButton.style.color = 'var(--vscode-button-foreground)';
			}
		});
	}

	private showCodeView(): void {
		// Hide overlay completely to show normal editor
		this._overlayElement.style.display = 'none';

		// Ensure toolbar doesn't interfere with editor operations
		if (this._toolbarElement) {
			this._toolbarElement.style.pointerEvents = 'auto';
			this._toolbarElement.style.zIndex = '1'; // Lower z-index so it doesn't block editor

			// Make sure toolbar is positioned to not block editor content
			const toolbarRect = this._toolbarElement.getBoundingClientRect();
			if (toolbarRect.width > 0) {
				// Only position toolbar if it's visible and not in editor group title
				const isInTitle = this._toolbarElement.parentElement?.classList.contains('editor-group-title');
				if (!isInTitle) {
					this._toolbarElement.style.position = 'absolute';
					this._toolbarElement.style.top = '0';
					this._toolbarElement.style.right = '0';
					this._toolbarElement.style.left = 'auto';
					this._toolbarElement.style.width = 'auto';
				}
			}
		}
	}

	private showPreviewView(contentArea: HTMLElement): void {
		this._overlayElement.style.display = 'flex';
		contentArea.style.display = 'block';

		// Clear existing content safely
		contentArea.textContent = '';

		// Create elements instead of using innerHTML
		const container = document.createElement('div');
		container.style.cssText = 'text-align: center; padding: 50px;';

		const title = document.createElement('h2');
		title.textContent = 'Preview View';
		title.style.cssText = 'margin-bottom: 20px; color: var(--vscode-editor-foreground);';

		const description = document.createElement('p');
		description.textContent = 'This preview view is currently empty. You can add content here later.';
		description.style.cssText = 'color: var(--vscode-descriptionForeground);';

		container.appendChild(title);
		container.appendChild(description);
		contentArea.appendChild(container);
	}

	private showGraphView(contentArea: HTMLElement): void {
		this._overlayElement.style.display = 'flex';
		contentArea.style.display = 'block';

		// Clear existing content safely
		contentArea.textContent = '';

		// Create main container
		const mainContainer = document.createElement('div');
		mainContainer.style.cssText = 'width: 100%; height: 100%;';

		// Create title
		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.style.cssText = 'margin-bottom: 20px; color: var(--vscode-editor-foreground);';

		// Create grid container
		const gridContainer = document.createElement('div');
		gridContainer.id = 'ren-grid-container';
		gridContainer.style.cssText = `
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			grid-template-rows: repeat(4, 1fr);
			gap: 10px;
			width: 100%;
			height: calc(100% - 60px);
			min-height: 300px;
		`;

		mainContainer.appendChild(title);
		mainContainer.appendChild(gridContainer);
		contentArea.appendChild(mainContainer);

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
	}

	private setupCommands(): void {
		// Register commands to switch views
		this._store.add(this.commandService.onWillExecuteCommand(e => {
			switch (e.commandId) {
				case 'ren.showCodeView':
					this.switchToView('code');
					break;
				case 'ren.showPreviewView':
					this.switchToView('preview');
					break;
				case 'ren.showGraphView':
					this.switchToView('graph');
					break;
			}
		}));
	}

	dispose(): void {
		this._store.dispose();
	}
}
