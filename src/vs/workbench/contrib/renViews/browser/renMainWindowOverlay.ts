import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { RenViewManager, RenViewMode } from './managers/renViewManager.js';
import { RenToolbarManager } from './managers/renToolbarManager.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import './styles/renViews.css';

export class RenMainWindowOverlay {
	private readonly _store = new DisposableStore();
	private readonly _overlayElement = document.createElement('div');
	private readonly _currentMode: IContextKey<RenViewMode>;
	private readonly _viewManager: RenViewManager;
	private readonly _toolbarManager: RenToolbarManager;

	constructor(
		private readonly container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		// tracks the current mode we are in
		this._currentMode = this.contextKeyService.createKey('ren.currentViewMode', 'code');

		// Initialize managers
		this._viewManager = this.instantiationService.createInstance(RenViewManager);
		this._toolbarManager = new RenToolbarManager(container);
		this._store.add(this._viewManager);
		this._store.add(this._toolbarManager);

		this.setupOverlay();
		this.setupCommands();
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

		// Initially show code view (normal editor)
		this.showCodeView();
	}

	private setupEventListeners(): void {
		// Listen for toolbar mode changes
		const unsubscribe = this._toolbarManager.onModeChange((mode) => {
			this.switchToView(mode);
		});
		this._store.add({ dispose: unsubscribe });

		// Listen for custom view switch events from graph view toolbar
		const handleCustomSwitch = (e: Event) => {
			const customEvent = e as CustomEvent<'code' | 'preview' | 'graph'>;
			this.switchToView(customEvent.detail);
		};
		const targetWindow = getWindow(this.container);
		targetWindow.document.addEventListener('ren-switch-view', handleCustomSwitch);
		this._store.add(toDisposable(() => targetWindow.document.removeEventListener('ren-switch-view', handleCustomSwitch)));
	}

	private switchToView(mode: RenViewMode): void {
		this._currentMode.set(mode);
		this._viewManager.switchToView(mode);

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
		// Ensure toolbar is always visible even in code view
		this._toolbarManager.updateToolbarForCodeView();
	}

	private showOverlayView(): void {
		// Show overlay for preview and graph views
		this._overlayElement.style.display = 'flex';
		// Ensure toolbar remains visible in overlay views
		this._toolbarManager.updateToolbarForCodeView();
	}

	private setupCommands(): void {
		// Register commands to switch views
		this._store.add(this.commandService.onWillExecuteCommand(e => {
			switch (e.commandId) {
				case 'ren.showCodeView':
					this._toolbarManager.setCurrentMode('code');
					break;
				case 'ren.showPreviewView':
					this._toolbarManager.setCurrentMode('preview');
					break;
				case 'ren.showGraphView':
					this._toolbarManager.setCurrentMode('graph');
					break;
			}
		}));
	}

	dispose(): void {
		this._store.dispose();
	}
}
