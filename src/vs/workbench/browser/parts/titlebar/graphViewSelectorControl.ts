/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

export type GraphMode = 'file' | 'folder' | 'workspace' | 'architecture';

export class GraphViewSelectorControl implements IDisposable {
	private readonly _disposables = new DisposableStore();
	readonly element: HTMLElement = document.createElement('div');
	private _graphModeSelect: HTMLSelectElement | null = null;
	private _currentGraphMode: GraphMode = 'file';
	private _isUpdatingProgrammatically = false;

	constructor() {
		this.element.classList.add('command-center');
		this.element.classList.add('graph-view-selector');
		this.createSelector();
	}

	private createSelector(): void {
		const selectorContainer = document.createElement('div');
		selectorContainer.className = 'graph-view-selector-container';
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

		const modeSelect = document.createElement('select');
		modeSelect.className = 'graph-view-mode-select';
		modeSelect.style.padding = '2px 8px';
		modeSelect.style.borderRadius = '3px';
		modeSelect.style.border = '1px solid var(--vscode-dropdown-border, var(--vscode-commandCenter-border))';
		modeSelect.style.backgroundColor = 'var(--vscode-dropdown-background, var(--vscode-commandCenter-background))';
		modeSelect.style.color = 'var(--vscode-dropdown-foreground, var(--vscode-commandCenter-foreground))';
		modeSelect.style.fontSize = '12px';
		modeSelect.style.cursor = 'pointer';
		modeSelect.style.flex = '1';
		modeSelect.style.minWidth = '0';

		const modes: GraphMode[] = ['file', 'folder', 'workspace', 'architecture'];
		const modeLabels: Record<GraphMode, string> = {
			file: 'File',
			folder: 'Folder',
			workspace: 'Workspace',
			architecture: 'Architecture'
		};

		modes.forEach(mode => {
			const option = document.createElement('option');
			option.value = mode;
			option.textContent = modeLabels[mode];
			modeSelect.appendChild(option);
		});

		modeSelect.value = this._currentGraphMode;
		modeSelect.title = 'Select graph scope';

		modeSelect.addEventListener('change', () => {
			// Prevent event loop - ignore changes triggered programmatically
			if (this._isUpdatingProgrammatically) {
				return;
			}
			const selectedMode = modeSelect.value as GraphMode;
			if (this._currentGraphMode !== selectedMode) {
				this._currentGraphMode = selectedMode;
				this.dispatchGraphModeChange(selectedMode);
			}
		});

		selectorContainer.appendChild(label);
		selectorContainer.appendChild(modeSelect);
		this.element.appendChild(selectorContainer);
		this._graphModeSelect = modeSelect;

		// Listen for graph mode changes from GraphView's internal selector
		const handleGraphModeChange = (e: Event) => {
			const customEvent = e as CustomEvent<GraphMode>;
			if (customEvent.detail && customEvent.detail !== this._currentGraphMode) {
				this.setGraphMode(customEvent.detail);
			}
		};
		// Use element's window instead of container to ensure it's available
		const targetWindow = getWindow(this.element);
		if (targetWindow && targetWindow.document) {
			targetWindow.document.addEventListener('ren-graph-mode-change', handleGraphModeChange);
			this._disposables.add({ dispose: () => targetWindow.document.removeEventListener('ren-graph-mode-change', handleGraphModeChange) });
		}
	}

	private dispatchGraphModeChange(mode: GraphMode): void {
		// Use element's window instead of container to ensure it's available
		const targetWindow = getWindow(this.element);
		if (targetWindow && targetWindow.document) {
			const event = new CustomEvent('ren-graph-mode-change', { detail: mode });
			targetWindow.document.dispatchEvent(event);
		}
	}

	getGraphMode(): GraphMode {
		return this._currentGraphMode;
	}

	setGraphMode(mode: GraphMode): void {
		if (this._currentGraphMode === mode) {
			return;
		}
		this._currentGraphMode = mode;
		if (this._graphModeSelect) {
			this._isUpdatingProgrammatically = true;
			try {
				this._graphModeSelect.value = mode;
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

