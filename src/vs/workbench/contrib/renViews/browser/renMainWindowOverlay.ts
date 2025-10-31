import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { RenViewManager, RenViewMode } from './managers/renViewManager.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import './styles/renViews.css';

export class RenMainWindowOverlay {
	private readonly _store = new DisposableStore();
	private readonly _overlayElement = document.createElement('div');
	private readonly _currentMode: IContextKey<RenViewMode>;
	private readonly _viewManager: RenViewManager;
	private _isHandlingEvent = false;

	constructor(
		private readonly container: HTMLElement,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		// tracks the current mode we are in
		this._currentMode = this.contextKeyService.createKey('ren.currentViewMode', 'code');

		// Initialize view manager
		this._viewManager = this.instantiationService.createInstance(RenViewManager);
		this._store.add(this._viewManager);

		this.setupOverlay();
		this.setupEventListeners();
	}

	private setupOverlay(): void {
		// Setup overlay for content (hidden in code view)
		this._overlayElement.className = 'ren-overlay';

		// Add content area
		const contentArea = document.createElement('div');
		contentArea.className = 'ren-content-area';
		contentArea.id = 'ren-content-area';
		this._overlayElement.appendChild(contentArea);

		this.container.appendChild(this._overlayElement);
		this._store.add(toDisposable(() => this._overlayElement.remove()));

		// Set content area for view manager
		this._viewManager.setContentArea(contentArea);

		// Ensure container has relative positioning (ViewButtons are now created in RenViewsContribution for all groups)
		this.container.style.position = 'relative';

		// Initially show code view (normal editor)
		this.showCodeView();
	}

	private setupEventListeners(): void {
		// Listen for custom view switch events from ViewButtons in this container only
		const handleCustomSwitch = (e: Event) => {
			const customEvent = e as CustomEvent<{ mode: 'code' | 'preview' | 'graph'; container: HTMLElement }>;
			// Only handle events that originated from this container's ViewButtons
			if (customEvent.detail && customEvent.detail.container === this.container) {
				this._isHandlingEvent = true;
				try {
					this.switchToView(customEvent.detail.mode, false);
				} finally {
					setTimeout(() => {
						this._isHandlingEvent = false;
					}, 0);
				}
			}
		};
		const targetWindow = getWindow(this.container);
		targetWindow.document.addEventListener('ren-switch-view', handleCustomSwitch);
		this._store.add(toDisposable(() => targetWindow.document.removeEventListener('ren-switch-view', handleCustomSwitch)));
	}

	private switchToView(mode: RenViewMode, dispatchEvent: boolean = false): void {
		this._currentMode.set(mode);
		this._viewManager.switchToView(mode);

		// Dispatch event to sync all ViewButtons instances if requested
		// Don't dispatch if we're already handling an event (from ViewButtons) to prevent loops
		if (dispatchEvent && !this._isHandlingEvent) {
			const targetWindow = getWindow(this.container);
			if (targetWindow && targetWindow.document) {
				const event = new CustomEvent('ren-switch-view', { detail: mode });
				targetWindow.document.dispatchEvent(event);
			}
		}

		switch (mode) {
			case 'code':
				this.showCodeView();
				break;
			case 'preview':
			case 'graph':
				this.showOverlayView();
				break;
		}
	}

	private showCodeView(): void {
		// Hide overlay completely to show normal editor
		this._overlayElement.style.display = 'none';
	}

	private showOverlayView(): void {
		// Show overlay for preview and graph views
		this._overlayElement.style.display = 'flex';
	}

	dispose(): void {
		this._store.dispose();
	}
}

