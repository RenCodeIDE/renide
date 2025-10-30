import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from '../views/renView.interface.js';
import { CodeView } from '../views/codeView.js';
import { PreviewView } from '../views/previewView.js';
import { GraphView } from '../views/graphView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

export type RenViewMode = 'code' | 'preview' | 'graph';

export class RenViewManager extends Disposable {
	private readonly _views = new Map<RenViewMode, IRenView>();
	private _currentView: RenViewMode = 'code';
	private _contentArea: HTMLElement | null = null;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.initializeViews();
	}

	private initializeViews(): void {
		this._views.set('code', this._register(new CodeView()));
		this._views.set('preview', this._register(this.instantiationService.createInstance(PreviewView)));
		this._views.set('graph', this._register(this.instantiationService.createInstance(GraphView)));
	}

	setContentArea(contentArea: HTMLElement): void {
		this._contentArea = contentArea;
	}

	switchToView(mode: RenViewMode): void {
		if (this._currentView === mode) {
			return;
		}

		// Hide current view
		const currentView = this._views.get(this._currentView);
		if (currentView && this._contentArea) {
			currentView.hide();
		}

		// Show new view
		this._currentView = mode;
		const newView = this._views.get(mode);
		if (newView && this._contentArea) {
			newView.show(this._contentArea);
		}
	}

	getCurrentView(): RenViewMode {
		return this._currentView;
	}
}
