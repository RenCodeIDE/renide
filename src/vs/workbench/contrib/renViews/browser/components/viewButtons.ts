import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { RenViewMode } from '../managers/renViewManager.js';

export class ViewButtons implements IDisposable {
	private readonly _disposables = new DisposableStore();
	readonly element: HTMLElement = document.createElement('div');
	private _buttons = new Map<RenViewMode, HTMLElement>();
	private _currentView: RenViewMode = 'code';
	private _isUpdatingProgrammatically = false;
	private readonly _container: HTMLElement;

	constructor(container: HTMLElement) {
		this._container = container;
		this.element.className = 'ren-view-buttons';
		this.element.style.position = 'absolute';
		this.element.style.bottom = '16px';
		this.element.style.left = '16px';
		this.element.style.display = 'flex';
		this.element.style.gap = '8px';
		this.element.style.zIndex = '1000';
		this.createButtons();
		container.appendChild(this.element);
	}

	private createButtons(): void {
		const views: RenViewMode[] = ['code', 'preview', 'graph'];
		const labels: Record<RenViewMode, string> = {
			code: 'Code',
			preview: 'Preview',
			graph: 'Graph'
		};

		views.forEach(view => {
			const button = document.createElement('button');
			button.textContent = labels[view];
			button.className = 'ren-view-button';
			button.dataset.mode = view;
			button.style.padding = '6px 12px';
			button.style.borderRadius = '4px';
			button.style.border = '1px solid var(--vscode-button-border)';
			button.style.backgroundColor = 'var(--vscode-button-background)';
			button.style.color = 'var(--vscode-button-foreground)';
			button.style.cursor = 'pointer';
			button.style.fontSize = '12px';
			button.style.fontWeight = '500';
			button.style.transition = 'all 0.2s ease';

			button.addEventListener('click', () => {
				this.switchToView(view);
			});

			this.element.appendChild(button);
			this._buttons.set(view, button);
		});

		this.updateButtonStates();

		// Listen for view changes from ren-switch-view events (but ignore our own dispatches and other containers)
		const handleViewChange = (e: Event) => {
			// Prevent infinite loop - ignore if we're updating programmatically
			if (this._isUpdatingProgrammatically) {
				return;
			}
			const customEvent = e as CustomEvent<{ mode: RenViewMode; container: HTMLElement }>;
			// Only sync if the event is for this container
			if (customEvent.detail && customEvent.detail.container === this._container && customEvent.detail.mode !== this._currentView) {
				this.setCurrentView(customEvent.detail.mode, false); // false = don't dispatch event
			}
		};
		const targetWindow = getWindow(this.element);
		if (targetWindow && targetWindow.document) {
			targetWindow.document.addEventListener('ren-switch-view', handleViewChange);
			this._disposables.add({ dispose: () => targetWindow.document.removeEventListener('ren-switch-view', handleViewChange) });
		}
	}

	private switchToView(view: RenViewMode): void {
		if (this._currentView === view) {
			return;
		}

		// Set flag to prevent event loop
		this._isUpdatingProgrammatically = true;
		try {
			this.setCurrentView(view, true); // true = dispatch event
		} finally {
			// Reset flag after a short delay to ensure event has propagated
			setTimeout(() => {
				this._isUpdatingProgrammatically = false;
			}, 0);
		}
	}

	private setCurrentView(view: RenViewMode, dispatchEvent: boolean = false): void {
		this._currentView = view;
		this.updateButtonStates();

		// Only dispatch event if requested (from user click, not from sync)
		// Include container reference so overlays can filter by their container
		if (dispatchEvent) {
			const targetWindow = getWindow(this.element);
			if (targetWindow && targetWindow.document) {
				const event = new CustomEvent('ren-switch-view', {
					detail: { mode: view, container: this._container }
				});
				targetWindow.document.dispatchEvent(event);
			}
		}
	}

	private updateButtonStates(): void {
		this._buttons.forEach((button, mode) => {
			if (mode === this._currentView) {
				button.classList.add('active');
				button.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
				button.style.borderColor = 'var(--vscode-button-hoverBackground)';
			} else {
				button.classList.remove('active');
				button.style.backgroundColor = 'var(--vscode-button-background)';
				button.style.borderColor = 'var(--vscode-button-border)';
			}
		});
	}

	getCurrentView(): RenViewMode {
		return this._currentView;
	}

	dispose(): void {
		this._disposables.dispose();
		this.element.remove();
	}
}

