/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IRenAuthService } from '../common/renAuth.js';
import { RenAccountDashboardInput } from './renAccountDashboardInput.js';
import './media/renAccountDashboard.css';

const $ = DOM.$;

export class RenAccountDashboardEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.renAccountDashboard';

	private contentContainer!: HTMLElement;
	private avatarContainer!: HTMLElement;
	private nameElement!: HTMLElement;
	private usernameElement!: HTMLElement;
	private emailElement!: HTMLElement;
	private userIdElement!: HTMLElement;
	private createdDateElement!: HTMLElement;
	private logoutButton!: Button;
	private editProfileButton!: Button;
	private accountSettingsButton!: Button;
	private readonly disposables = new DisposableStore();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IRenAuthService private readonly authService: IRenAuthService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(RenAccountDashboardEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		// Main content wrapper
		this.contentContainer = $('.ren-account-dashboard-container');
		parent.appendChild(this.contentContainer);

		// Header section
		const header = $('.ren-account-dashboard-header');
		this.contentContainer.appendChild(header);

		// Avatar
		this.avatarContainer = $('.ren-account-dashboard-avatar');
		header.appendChild(this.avatarContainer);

		// User info section
		const infoSection = $('.ren-account-dashboard-info');
		header.appendChild(infoSection);

		this.nameElement = $('.ren-account-dashboard-name');
		infoSection.appendChild(this.nameElement);

		this.usernameElement = $('.ren-account-dashboard-username');
		infoSection.appendChild(this.usernameElement);

		this.emailElement = $('.ren-account-dashboard-email');
		infoSection.appendChild(this.emailElement);

		// Account details section
		const detailsSection = $('.ren-account-dashboard-details');
		this.contentContainer.appendChild(detailsSection);

		// User ID
		const userIdRow = $('.ren-account-dashboard-row');
		const userIdLabel = $('.ren-account-dashboard-label');
		userIdLabel.textContent = localize('renAccount.userId', "User ID");
		userIdRow.appendChild(userIdLabel);
		this.userIdElement = $('.ren-account-dashboard-value');
		userIdRow.appendChild(this.userIdElement);
		detailsSection.appendChild(userIdRow);

		// Created Date
		const createdRow = $('.ren-account-dashboard-row');
		const createdLabel = $('.ren-account-dashboard-label');
		createdLabel.textContent = localize('renAccount.createdDate', "Account Created");
		createdRow.appendChild(createdLabel);
		this.createdDateElement = $('.ren-account-dashboard-value');
		createdRow.appendChild(this.createdDateElement);
		detailsSection.appendChild(createdRow);

		// Action buttons section
		const actionsSection = $('.ren-account-dashboard-actions');
		this.contentContainer.appendChild(actionsSection);

		// Logout button
		this.logoutButton = this._register(new Button(actionsSection, {
			secondary: true
		}));
		this.logoutButton.label = localize('renAccount.logout', "Sign Out");
		this.logoutButton.element.classList.add('ren-account-dashboard-button');
		this._register(this.logoutButton.onDidClick(() => this.handleLogout()));

		// Edit Profile button
		this.editProfileButton = this._register(new Button(actionsSection, {
			secondary: true
		}));
		this.editProfileButton.label = localize('renAccount.editProfile', "Edit Profile");
		this.editProfileButton.element.classList.add('ren-account-dashboard-button');
		this._register(this.editProfileButton.onDidClick(() => this.handleEditProfile()));

		// Account Settings button
		this.accountSettingsButton = this._register(new Button(actionsSection, {
			secondary: true
		}));
		this.accountSettingsButton.label = localize('renAccount.accountSettings', "Account Settings");
		this.accountSettingsButton.element.classList.add('ren-account-dashboard-button');
		this._register(this.accountSettingsButton.onDidClick(() => this.handleAccountSettings()));

		// Load initial data
		this.updateDashboard();
	}

	private formatDate(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
	}

	private updateDashboard(): void {
		const user = this.authService.currentUser;

		if (!user) {
			this.clearDashboard();
			return;
		}

		// Update avatar
		if (user.avatarUrl) {
			this.avatarContainer.style.backgroundImage = `url(${user.avatarUrl})`;
		} else {
			// Derive initials from displayName, email, or username (in that order)
			let initials = '';
			if (user.displayName && typeof user.displayName === 'string' && user.displayName.length > 0) {
				initials = user.displayName.charAt(0).toUpperCase();
			} else if (user.email && typeof user.email === 'string' && user.email.length > 0) {
				initials = user.email.charAt(0).toUpperCase();
			} else if (user.username && typeof user.username === 'string' && user.username.length > 0) {
				initials = user.username.charAt(0).toUpperCase();
			}
			this.avatarContainer.textContent = initials;
			this.avatarContainer.style.backgroundImage = '';
		}

		// Update name
		this.nameElement.textContent = user.displayName ?? '';

		// Update username
		this.usernameElement.textContent = user.username ? `@${user.username}` : '';

		// Update email
		this.emailElement.textContent = user.email ?? '';

		// Update user ID
		this.userIdElement.textContent = user.id ?? '';

		// Update created date
		if (user.createdAt && typeof user.createdAt === 'number' && !isNaN(user.createdAt)) {
			this.createdDateElement.textContent = this.formatDate(user.createdAt);
		} else {
			this.createdDateElement.textContent = '';
		}
	}

	private clearDashboard(): void {
		this.avatarContainer.style.backgroundImage = '';
		this.avatarContainer.textContent = '';
		this.nameElement.textContent = '';
		this.usernameElement.textContent = '';
		this.emailElement.textContent = '';
		this.userIdElement.textContent = '';
		this.createdDateElement.textContent = '';
	}

	private async handleLogout(): Promise<void> {
		try {
			await this.authService.logout();
			// Note: The logout will trigger auth state change events
			// The editor should close automatically or we could close it here
		} catch (error) {
			console.error('Failed to logout:', error);
		}
	}

	private handleEditProfile(): void {
		// Placeholder for future implementation
		this.notificationService.info(
			localize('renAccount.editProfileComingSoon', "Edit Profile coming soon!")
		);
	}

	private handleAccountSettings(): void {
		// Placeholder for future implementation
		this.notificationService.info(
			localize('renAccount.accountSettingsComingSoon', "Account Settings coming soon!")
		);
	}

	override async setInput(input: RenAccountDashboardInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateDashboard();

		// Listen to user changes
		this.disposables.clear();
		this.disposables.add(this.authService.onDidChangeUser(() => {
			this.updateDashboard();
		}));
	}

	override clearInput(): void {
		this.disposables.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
	}

	override layout(dimension: DOM.Dimension): void {
		// Handle layout changes if needed
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}

