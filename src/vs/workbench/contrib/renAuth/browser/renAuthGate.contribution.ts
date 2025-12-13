/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/renAuthGate.css';

import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { env } from '../../../../base/common/process.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IRenAuthService } from '../../../services/renAuth/common/renAuth.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

const REN_DISABLE_AUTH_GATE_ENV = 'REN_DISABLE_AUTH_GATE';

export class RenAuthGateContribution extends Disposable implements IWorkbenchContribution {

	private overlay: HTMLElement | undefined;
	private overlayDisposables = this._register(new DisposableStore());

	constructor(
		@IRenAuthService private readonly renAuthService: IRenAuthService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
	) {
		super();

		if (this.isDisabledByEnv()) {
			return;
		}

		// Re-evaluate on auth changes (login/logout) and when active container changes.
		this._register(this.renAuthService.onDidChangeAuthStatus(() => this.update()));
		this._register(this.layoutService.onDidChangeActiveContainer(() => this.update()));

		void this.update();
	}

	private isDisabledByEnv(): boolean {
		const value = String(env[REN_DISABLE_AUTH_GATE_ENV] ?? '').toLowerCase();
		return value === '1' || value === 'true' || value === 'yes';
	}

	private async update(): Promise<void> {
		// Keep state fresh on startup (and when secrets change internally).
		try {
			await this.renAuthService.checkAuthStatus();
		} catch {
			// ignore - auth gate will treat as unauthenticated
		}

		if (this.renAuthService.isAuthenticated) {
			this.hideOverlay();
			return;
		}

		// Unauthenticated: ensure welcome is visible and gate the UI.
		this.forceWelcomePage();
		this.showOverlay();
	}

	private forceWelcomePage(): void {
		// Delay slightly to ensure commands are registered (commands register when their contribution files load,
		// but we want to be safe). Use setTimeout to let the event loop process command registrations.
		setTimeout(() => {
			this.commandService.executeCommand('workbench.action.openWalkthrough').catch(() => {
				// Command might not be ready yet, that's okay - we'll try again when overlay shows
			});
		}, 0);
	}

	private showOverlay(): void {
		const container = this.layoutService.activeContainer;
		if (!container) {
			// Container not ready yet, try again on next update
			return;
		}

		const win = getWindow(container);
		const doc = win.document;

		if (this.overlay && this.overlay.isConnected) {
			return;
		}

		this.overlayDisposables.clear();

		const isFirstRun = this.storageService.isNew(StorageScope.APPLICATION);

		const title = isFirstRun
			? localize('ren.authGate.title.firstRun', 'Welcome to {0}', this.productService.nameLong ?? this.productService.nameShort)
			: localize('ren.authGate.title', 'Sign in required');

		const subtitle = isFirstRun
			? localize('ren.authGate.subtitle.firstRun', 'Sign in to start using Ren IDE. You can sync settings and unlock personalized features.')
			: localize('ren.authGate.subtitle', 'You must be signed in to use Ren IDE.');

		const overlay = this.overlay = $('div.ren-auth-gate-overlay', {
			role: 'dialog',
			'aria-modal': 'true',
			tabindex: 0
		},
			$('div.ren-auth-gate-card', {},
				$('h2', {}, title),
				$('p', {}, subtitle),
				$('div.ren-auth-gate-actions', {},
					$('button.monaco-button.cta.primary', { type: 'button' }, localize('ren.authGate.signIn', 'Sign in')),
					$('button.monaco-button.cta.secondary', { type: 'button' }, localize('ren.authGate.createAccount', 'Create account'))
				),
				$('p.ren-auth-gate-footer', {},
					localize('ren.authGate.noAccount', "Don't have an account? Click 'Create account' to get started.")
				)
			)
		);

		// Attach last to stay on top of regular workbench content.
		container.appendChild(overlay);
		
		// Add class to workbench container to enable CSS pointer-events blocking
		container.classList.add('ren-auth-gated');
		this.overlayDisposables.add({ dispose: () => container.classList.remove('ren-auth-gated') });

		// Focus overlay for keyboard trapping.
		overlay.focus();

		const signInButton = overlay.querySelector<HTMLButtonElement>('button.primary');
		this.overlayDisposables.add(addDisposableListener(signInButton!, EventType.CLICK, () => {
			// Ensure welcome page is visible before opening login dialog
			this.commandService.executeCommand('workbench.action.openWalkthrough').catch(() => undefined);
			// Open login dialog - command should be registered by now (renAuth.contribution loads before this)
			this.commandService.executeCommand('ren.auth.login').catch((err) => {
				// If command not found, log but don't crash - user can retry
				console.warn('[RenAuthGate] Login command not available:', err);
			});
		}));

		const createAccountButton = overlay.querySelector<HTMLButtonElement>('button.secondary');
		this.overlayDisposables.add(addDisposableListener(createAccountButton!, EventType.CLICK, () => {
			// Open registration dialog
			this.commandService.executeCommand('ren.auth.register').catch((err) => {
				console.warn('[RenAuthGate] Register command not available:', err);
			});
		}));

		// Helper to check if target is in a dialog or input that should be allowed
		const isInAllowedElement = (target: HTMLElement | null): boolean => {
			if (!target) {
				return false;
			}
			// Check if inside any dialog-related element
			if (target.closest('.monaco-dialog-modal-block') ||
				target.closest('.monaco-dialog-box') ||
				target.closest('.monaco-inputbox') ||
				target.closest('.quick-input-widget') ||
				target.closest('.dialog-message-container') ||
				target.closest('.dialog-buttons-row')) {
				return true;
			}
			// Check if target is an input/textarea/button (for dialog form elements)
			const tagName = target.tagName.toLowerCase();
			if (tagName === 'input' || tagName === 'textarea' || tagName === 'button' || tagName === 'select') {
				// Only allow if it's inside a dialog (check parent chain)
				let parent = target.parentElement;
				while (parent) {
					if (parent.classList.contains('monaco-dialog-box') ||
						parent.classList.contains('monaco-dialog-modal-block') ||
						parent.classList.contains('ren-auth-gate-overlay')) {
						return true;
					}
					parent = parent.parentElement;
				}
			}
			return false;
		};

		// Hard block keyboard-driven usage while gated, but allow typing into dialogs once they open.
		const keydownCapture = (e: KeyboardEvent) => {
			if (!this.overlay || !this.overlay.isConnected) {
				return;
			}

			const target = e.target as HTMLElement | null;
			
			// Allow dialog typing if a modal dialog is open (login dialog uses this).
			if (isInAllowedElement(target)) {
				return;
			}

			// Allow interaction inside the overlay itself (for the sign-in button).
			if (target && this.overlay.contains(target)) {
				return;
			}

			// Block ALL keyboard events from reaching workbench.
			e.preventDefault();
			e.stopImmediatePropagation();
			e.stopPropagation();
		};
		
		// Capture at capture phase to intercept before workbench handlers
		doc.addEventListener('keydown', keydownCapture, true);
		doc.addEventListener('keyup', keydownCapture, true);
		doc.addEventListener('keypress', keydownCapture, true);
		this.overlayDisposables.add({ dispose: () => {
			doc.removeEventListener('keydown', keydownCapture, true);
			doc.removeEventListener('keyup', keydownCapture, true);
			doc.removeEventListener('keypress', keydownCapture, true);
		} });

		// Block pointer events from reaching workbench content.
		const pointerCapture = (e: Event) => {
			if (!this.overlay || !this.overlay.isConnected) {
				return;
			}
			
			const target = e.target as HTMLElement | null;
			
			// Allow dialog interaction (login dialog).
			if (isInAllowedElement(target)) {
				return;
			}
			
			// Allow interaction inside the overlay itself.
			if (target && this.overlay.contains(target)) {
				return;
			}
			
			// Block ALL pointer events from reaching workbench.
			e.preventDefault();
			e.stopImmediatePropagation();
			e.stopPropagation();
		};
		
		// Capture all pointer event types at capture phase
		for (const type of [
			EventType.MOUSE_DOWN, EventType.MOUSE_UP, EventType.MOUSE_MOVE,
			EventType.CLICK, EventType.DBLCLICK, EventType.CONTEXT_MENU,
			EventType.WHEEL, EventType.POINTER_DOWN, EventType.POINTER_UP, EventType.POINTER_MOVE
		]) {
			doc.addEventListener(type, pointerCapture as EventListener, true);
			this.overlayDisposables.add({ dispose: () => doc.removeEventListener(type, pointerCapture as EventListener, true) });
		}
	}

	private hideOverlay(): void {
		this.overlayDisposables.clear();
		this.overlay?.remove();
		this.overlay = undefined;
	}

	override dispose(): void {
		this.hideOverlay();
		super.dispose();
	}
}

registerWorkbenchContribution2('workbench.contrib.renAuthGate', RenAuthGateContribution, WorkbenchPhase.BlockRestore);


