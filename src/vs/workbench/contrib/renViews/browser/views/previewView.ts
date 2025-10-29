/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from './renView.interface.js';

export class PreviewView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;

	show(contentArea: HTMLElement): void {
		// Clear existing content safely
		contentArea.textContent = '';

		// Create elements instead of using innerHTML
		this._container = document.createElement('div');
		this._container.className = 'ren-preview-container';

		const title = document.createElement('h2');
		title.textContent = 'SUCCESS! Hot Reload is Working!';
		title.className = 'ren-preview-title';

		const description = document.createElement('p');
		description.textContent = 'Hot reload is working! This preview view is currently empty. You can add content here later.';
		description.className = 'ren-preview-description';

		this._container.appendChild(title);
		this._container.appendChild(description);
		contentArea.appendChild(this._container);
	}

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
	}
}
