import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { RenViewMode } from './renViewManager.js';
import { EditorGroupView } from '../../../../browser/parts/editor/editorGroupView.js';

/**
 * GlobalRenToolbar mounts a compact view switcher into every editor group's title area
 * so it is available IDE-wide (not tied to a specific Ren view instance).
 */
export class GlobalRenToolbar extends Disposable {
	private readonly byGroup = new Map<EditorGroupView, { element: HTMLElement; buttons: Map<RenViewMode, HTMLElement>; store: DisposableStore }>();
	private currentMode: RenViewMode = 'code';

	constructor() {
		super();
	}

	attachToGroup(group: EditorGroupView): void {
		// prevents duplicate mounting
		if (this.byGroup.has(group)) {
			return;
		}

		const titleArea = group.element.querySelector('.title') as HTMLElement | null;
		if (!titleArea) {
			return;
		}

		const store = new DisposableStore();
		const toolbarElement = document.createElement('div');
		toolbarElement.className = 'ren-toolbar-integrated';

		const buttons = new Map<RenViewMode, HTMLElement>();
		const createBtn = (label: string, mode: RenViewMode) => {
			const btn = document.createElement('button');
			btn.textContent = label;
			btn.dataset.mode = mode;
			btn.className = 'ren-view-button';
			btn.addEventListener('click', () => this.setMode(mode));
			toolbarElement.appendChild(btn);
			buttons.set(mode, btn);
		};

		createBtn('Code', 'code');
		createBtn('Preview', 'preview');
		createBtn('Graph', 'graph');

		// Sync initial active state
		this.updateActiveButton(buttons);

		titleArea.appendChild(toolbarElement);

		store.add(toDisposable(() => toolbarElement.remove()));
		this._register(store);

		this.byGroup.set(group, { element: toolbarElement, buttons, store });
	}

	detachFromGroup(group: EditorGroupView): void {
		const entry = this.byGroup.get(group);
		if (!entry) {
			return;
		}
		entry.store.dispose();
		this.byGroup.delete(group);
	}

	private setMode(mode: RenViewMode): void {
		if (this.currentMode === mode) {
			return;
		}
		this.currentMode = mode;
		// Update buttons across all groups
		for (const { buttons } of this.byGroup.values()) {
			this.updateActiveButton(buttons);
		}
		// Future: broadcast mode to interested subsystems if needed
	}

	private updateActiveButton(buttons: Map<RenViewMode, HTMLElement>): void {
		for (const [mode, btn] of buttons) {
			if (mode === this.currentMode) {
				btn.classList.add('active');
			} else {
				btn.classList.remove('active');
			}
		}
	}

	override dispose(): void {
		super.dispose();
		for (const [, { store }] of this.byGroup) {
			store.dispose();
		}
		this.byGroup.clear();
	}
}


