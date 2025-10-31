/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

export type ViewMode = 'code' | 'monitorx' | 'graph';

export class ViewSelectorControl implements IDisposable {
	private readonly _disposables = new DisposableStore();
	readonly element: HTMLElement = document.createElement('div');
	private _viewSelect: HTMLSelectElement | null = null;
	private _currentView: ViewMode = 'code';
	private _isUpdatingProgrammatically = false;

	constructor() {
		this.element.classList.add('command-center');
		this.element.classList.add('view-selector');
		this.createSelector();
	}

	private createSelector(): void {
		const selectorContainer = document.createElement('div');
		selectorContainer.className = 'view-selector-container';
		selectorContainer.style.display = 'flex';
		selectorContainer.style.alignItems = 'center';
		selectorContainer.style.gap = '8px';
		selectorContainer.style.padding = '0 12px';
		selectorContainer.style.height = '22px';
		selectorContainer.style.width = '38vw';
		selectorContainer.style.maxWidth = '600px';
		selectorContainer.style.borderRadius = '6px';
		selectorContainer.style.backgroundColor = 'var(--vscode-commandCenter-background)';
		selectorContainer.style.border = '1px solid var(--vscode-commandCenter-border)';
		selectorContainer.style.color = 'var(--vscode-commandCenter-foreground)';

		const label = document.createElement('span');
		label.textContent = 'View:';
		label.style.fontSize = '12px';
		label.style.marginRight = '4px';

		const viewSelect = document.createElement('select');
		viewSelect.className = 'view-mode-select';
		viewSelect.style.padding = '2px 8px';
		viewSelect.style.borderRadius = '3px';
		viewSelect.style.border = '1px solid var(--vscode-dropdown-border, var(--vscode-commandCenter-border))';
		viewSelect.style.backgroundColor = 'var(--vscode-dropdown-background, var(--vscode-commandCenter-background))';
		viewSelect.style.color = 'var(--vscode-dropdown-foreground, var(--vscode-commandCenter-foreground))';
		viewSelect.style.fontSize = '12px';
		viewSelect.style.cursor = 'pointer';
		viewSelect.style.flex = '1';
		viewSelect.style.minWidth = '0';

		const views: ViewMode[] = ['code', 'monitorx', 'graph'];
		const viewLabels: Record<ViewMode, string> = {
			code: 'Code',
			monitorx: 'MonitorX',
			graph: 'Graph'
		};

		views.forEach(view => {
			const option = document.createElement('option');
			option.value = view;
			option.textContent = viewLabels[view];
			viewSelect.appendChild(option);
		});

		viewSelect.value = this._currentView;
		viewSelect.title = 'Select view mode';

		viewSelect.addEventListener('change', () => {
			// Prevent event loop - ignore changes triggered programmatically
			if (this._isUpdatingProgrammatically) {
				return;
			}
			const selectedView = viewSelect.value as ViewMode;
			if (this._currentView !== selectedView) {
				this._currentView = selectedView;
				this.dispatchViewChange(selectedView);
			}
		});

		selectorContainer.appendChild(label);
		selectorContainer.appendChild(viewSelect);
		this.element.appendChild(selectorContainer);
		this._viewSelect = viewSelect;

		// Listen for view changes from other components
		const handleViewChange = (e: Event) => {
			const customEvent = e as CustomEvent<ViewMode>;
			if (customEvent.detail && customEvent.detail !== this._currentView) {
				this.setView(customEvent.detail);
			}
		};
		const targetWindow = getWindow(this.element);
		if (targetWindow && targetWindow.document) {
			targetWindow.document.addEventListener('ren-view-change', handleViewChange);
			this._disposables.add({ dispose: () => targetWindow.document.removeEventListener('ren-view-change', handleViewChange) });
		}
	}

	private dispatchViewChange(view: ViewMode): void {
		const targetWindow = getWindow(this.element);
		if (targetWindow && targetWindow.document) {
			const event = new CustomEvent('ren-view-change', { detail: view });
			targetWindow.document.dispatchEvent(event);
		}
	}

	getView(): ViewMode {
		return this._currentView;
	}

	setView(view: ViewMode): void {
		if (this._currentView === view) {
			return;
		}
		this._currentView = view;
		if (this._viewSelect) {
			this._isUpdatingProgrammatically = true;
			try {
				this._viewSelect.value = view;
			} finally {
				// Use setTimeout to ensure the change event has fired before resetting the flag
				setTimeout(() => {
					this._isUpdatingProgrammatically = false;
				}, 0);
			}
		}
	}

	dispose(): void {
		this._disposables.dispose();
	}
}

