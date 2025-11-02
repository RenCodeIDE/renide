/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IRenAuthService, RenAuthContextKey } from '../../../services/renAuth/common/renAuth.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { registerAction2, Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { RenAccountDashboardEditor } from '../../../services/renAuth/browser/renAccountDashboardEditor.js';
import { RenAccountDashboardInput } from '../../../services/renAuth/browser/renAccountDashboardInput.js';

const REN_AUTH_COMMANDS = {
	LOGIN: 'ren.auth.login',
	LOGOUT: 'ren.auth.logout',
	OPEN_DASHBOARD: 'ren.account.openDashboard'
};

const REN_AUTH_STORAGE_KEYS = {
	REMEMBERED_EMAIL: 'ren.auth.rememberedEmail'
};

export class RenAuthContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IRenAuthService private readonly authService: IRenAuthService
	) {
		super();

		// Register commands
		this._register(registerAction2(class RenSignInAction extends Action2 {
			constructor() {
				super({
					id: REN_AUTH_COMMANDS.LOGIN,
					title: localize2('renAuth.signIn', 'Ren: Sign In'),
					category: localize2('renAuth.category', 'Ren'),
					f1: true
				});
			}

			async run(accessor: ServicesAccessor) {
				const authService = accessor.get(IRenAuthService);
				const dialogService = accessor.get(IDialogService);
				const notificationService = accessor.get(INotificationService);
				const storageService = accessor.get(IStorageService);

				if (authService.isAuthenticated) {
					notificationService.info(localize('renAuth.alreadyLoggedIn', 'You are already logged in to Ren.'));
					return;
				}

				// Get remembered email if available
				const rememberedEmail = storageService.get(REN_AUTH_STORAGE_KEYS.REMEMBERED_EMAIL, StorageScope.APPLICATION);

				// Show login dialog
				const result = await dialogService.input({
					type: Severity.Info,
					message: localize('renAuth.loginTitle', 'Sign in to Ren'),
					inputs: [
						{
							type: 'text',
							placeholder: localize('renAuth.emailPlaceholder', 'Email'),
							value: rememberedEmail
						},
						{
							type: 'password',
							placeholder: localize('renAuth.passwordPlaceholder', 'Password')
						}
					],
					primaryButton: localize('renAuth.signInButton', 'Sign In'),
					checkbox: {
						label: localize('renAuth.rememberMe', 'Remember email'),
						checked: !!rememberedEmail
					}
				});

				if (!result.confirmed || !result.values) {
					return;
				}

				const [email, password] = result.values;

				if (!email || !password) {
					notificationService.error(localize('renAuth.emptyCredentials', 'Email and password are required.'));
					return;
				}

				// Show progress notification
				const progressNotification = notificationService.notify({
					severity: Severity.Info,
					message: localize('renAuth.signingIn', 'Signing in to Ren...'),
					source: 'Ren Auth'
				});

				try {
					const loginResult = await authService.login(email, password, !!result.checkboxChecked);

					progressNotification.close();

					if (loginResult.success) {
						notificationService.info(localize('renAuth.loginSuccess', 'Successfully signed in to Ren as {0}.', loginResult.user?.displayName || email));
					} else {
						let errorMessage = loginResult.error || localize('renAuth.loginFailed', 'Failed to sign in.');

						// Provide more helpful error messages based on error code
						if (loginResult.errorCode === 'INVALID_CREDENTIALS') {
							errorMessage = localize('renAuth.invalidCredentials', 'Invalid email or password. Please try again.');
						} else if (loginResult.errorCode === 'NETWORK_ERROR') {
							errorMessage = localize('renAuth.networkError', 'Network error. Please check your connection and try again.');
						}

						notificationService.error(errorMessage);
					}
				} catch (error) {
					progressNotification.close();
					notificationService.error(localize('renAuth.unexpectedError', 'An unexpected error occurred: {0}.', error instanceof Error ? error.message : String(error)));
				}
			}
		}));

		this._register(registerAction2(class RenSignOutAction extends Action2 {
			constructor() {
				super({
					id: REN_AUTH_COMMANDS.LOGOUT,
					title: localize2('renAuth.signOut', 'Ren: Sign Out'),
					category: localize2('renAuth.category', 'Ren'),
					f1: true
				});
			}

			async run(accessor: ServicesAccessor) {
				const authService = accessor.get(IRenAuthService);
				const notificationService = accessor.get(INotificationService);

				if (!authService.isAuthenticated) {
					notificationService.info(localize('renAuth.notLoggedIn', 'You are not logged in.'));
					return;
				}

				try {
					await authService.logout();
					notificationService.info(localize('renAuth.logoutSuccess', 'Successfully signed out of Ren.'));
				} catch (error) {
					notificationService.error(localize('renAuth.logoutError', 'Failed to sign out: {0}.', error instanceof Error ? error.message : String(error)));
				}
			}
		}));

		// Register Ren Account Dashboard menu action
		this._register(registerAction2(class RenAccountDashboardAction extends Action2 {
			constructor() {
				super({
					id: REN_AUTH_COMMANDS.OPEN_DASHBOARD,
					title: localize2('renAccount.openDashboard', 'Ren Account'),
					category: localize2('renAuth.category', 'Ren'),
					f1: true,
					menu: [{
						id: MenuId.GlobalActivity,
						group: '1_account',
						order: 1,
						when: RenAuthContextKey
					}]
				});
			}

			async run(accessor: ServicesAccessor) {
				const editorService = accessor.get(IEditorService);
				const authService = accessor.get(IRenAuthService);
				const instantiationService = accessor.get(IInstantiationService);

				if (!authService.isAuthenticated) {
					const notificationService = accessor.get(INotificationService);
					notificationService.info(localize('renAuth.notLoggedIn', 'You are not logged in.'));
					return;
				}

				const dashboardInput = instantiationService.createInstance(RenAccountDashboardInput);
				await editorService.openEditor(dashboardInput);
			}
		}));

		// Check auth status on startup
		void this.checkAuthStatus();
	}

	private async checkAuthStatus(): Promise<void> {
		try {
			await this.authService.checkAuthStatus();
		} catch (error) {
			// Silent failure - just log if needed
		}
	}
}

// Register the contribution
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RenAuthContribution, LifecyclePhase.Restored);

// Register the editor pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		RenAccountDashboardEditor,
		RenAccountDashboardEditor.ID,
		localize('renAccountDashboardEditor', 'Ren Account Dashboard')
	),
	[
		new SyncDescriptor(RenAccountDashboardInput)
	]
);

