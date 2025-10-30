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
		// Always integrate with the editor group title area for proper VS Code integration
		const toolbarArea = this.container.querySelector('.editor-group-container .title') as HTMLElement;

		if (toolbarArea) {
			// Insert toolbar into the editor group title area
			this._toolbarElement.className = 'ren-toolbar-integrated';
			toolbarArea.appendChild(this._toolbarElement);
		} else {
			// Fallback: create toolbar at top of container
			this._toolbarElement.className = 'ren-toolbar-fallback';
			this.container.appendChild(this._toolbarElement);
		}

		// Create view buttons
		this.createViewButton('Code', 'code');
		this.createViewButton('Preview', 'preview');
		this.createViewButton('Graph', 'graph');

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
		// Ensure toolbar is always visible and properly integrated
		if (this._toolbarElement) {
			this._toolbarElement.style.pointerEvents = 'auto';
			this._toolbarElement.style.display = 'flex'; // Always show the toolbar

			// If toolbar is in fallback mode, position it properly
			if (this._toolbarElement.classList.contains('ren-toolbar-fallback')) {
				this._toolbarElement.style.position = 'absolute';
				this._toolbarElement.style.top = '0';
				this._toolbarElement.style.right = '0';
				this._toolbarElement.style.left = 'auto';
				this._toolbarElement.style.width = 'auto';
				this._toolbarElement.style.zIndex = '10';
			}
		}
	}
}
