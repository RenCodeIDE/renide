/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from './renView.interface.js';

export class GraphView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _gridContainer: HTMLElement | null = null;
	private _cells: HTMLElement[] = [];

	show(contentArea: HTMLElement): void {
		// Clear existing content safely
		contentArea.textContent = '';

		// Create main container
		this._mainContainer = document.createElement('div');
		this._mainContainer.className = 'ren-graph-container';

		// Create title
		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.className = 'ren-graph-title';

		// Create grid container
		this._gridContainer = document.createElement('div');
		this._gridContainer.id = 'ren-grid-container';
		this._gridContainer.className = 'ren-grid-container';

		this._mainContainer.appendChild(title);
		this._mainContainer.appendChild(this._gridContainer);
		contentArea.appendChild(this._mainContainer);

		// Create grid cells
		this.createGridCells();
	}

	private createGridCells(): void {
		if (!this._gridContainer) {
			return;
		}

		this._cells = [];
		for (let i = 0; i < 16; i++) {
			const cell = document.createElement('div');
			cell.className = 'ren-grid-cell';
			cell.textContent = `Cell ${i + 1}`;

			// Add click handler
			cell.addEventListener('click', () => {
				console.log(`Clicked cell ${i + 1}`);
			});

			this._gridContainer.appendChild(cell);
			this._cells.push(cell);
		}
	}

	hide(): void {
		if (this._mainContainer) {
			this._mainContainer.remove();
			this._mainContainer = null;
			this._gridContainer = null;
			this._cells = [];
		}
	}
}
