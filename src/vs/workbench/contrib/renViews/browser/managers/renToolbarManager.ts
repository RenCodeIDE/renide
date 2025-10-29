/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { RenViewMode } from './renViewManager.js';

export class RenToolbarManager extends Disposable {
	private readonly _toolbarElement = document.createElement('div');
	private readonly _buttons = new Map<RenViewMode, HTMLElement>();
	private _currentMode: RenViewMode = 'code';
	private _onModeChange = new Set<(mode: RenViewMode) => void>();

	constructor(private readonly container: HTMLElement) {
		super();
		this.setupToolbar();
	}

	private setupToolbar(): void {
		// Find the editor group's toolbar area
		const toolbarArea = this.container.querySelector('.editor-group-container .editor-group-title') as HTMLElement;

		if (!toolbarArea) {
			// Fallback: create toolbar at top of container
			this._toolbarElement.className = 'ren-toolbar-fallback';
		} else {
			// Insert toolbar into the editor group title area
			this._toolbarElement.className = 'ren-toolbar';
			toolbarArea.appendChild(this._toolbarElement);
		}

		// Create view buttons
		this.createViewButton('Code', 'code');
		this.createViewButton('Preview', 'preview');
		this.createViewButton('Graph', 'graph');

		// If we couldn't find the toolbar area, add to container
		if (!toolbarArea) {
			this.container.appendChild(this._toolbarElement);
		}

		this._register(toDisposable(() => this._toolbarElement.remove()));
	}

	private createViewButton(title: string, mode: RenViewMode): void {
		const button = document.createElement('button');
		button.textContent = title;
		button.dataset.mode = mode;
		button.className = 'ren-view-button';

		button.addEventListener('click', () => {
			this.setCurrentMode(mode);
		});

		this._toolbarElement.appendChild(button);
		this._buttons.set(mode, button);
	}

	setCurrentMode(mode: RenViewMode): void {
		if (this._currentMode === mode) {
			return;
		}

		this._currentMode = mode;
		this.updateButtonStates();

		// Notify listeners
		this._onModeChange.forEach(listener => listener(mode));
	}

	getCurrentMode(): RenViewMode {
		return this._currentMode;
	}

	private updateButtonStates(): void {
		this._buttons.forEach((button, mode) => {
			if (mode === this._currentMode) {
				button.classList.add('active');
			} else {
				button.classList.remove('active');
			}
		});
	}

	onModeChange(listener: (mode: RenViewMode) => void): () => void {
		this._onModeChange.add(listener);
		return () => this._onModeChange.delete(listener);
	}

	updateToolbarForCodeView(): void {
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
}
