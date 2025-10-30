import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from './renView.interface.js';

export class CodeView extends Disposable implements IRenView {
	show(contentArea: HTMLElement): void {
		// Code view doesn't need to show anything - it just hides the overlay
		// This method is kept for interface compliance
	}

	hide(): void {
		// Code view doesn't need to hide anything - it just shows the overlay
		// This method is kept for interface compliance
	}
}
