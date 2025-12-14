/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { InputBox } from "../../../../base/browser/ui/inputbox/inputBox.js";
import {
	Orientation,
	Sizing,
	SplitView,
} from "../../../../base/browser/ui/splitview/splitview.js";
import { Toggle } from "../../../../base/browser/ui/toggle/toggle.js";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { Event } from "../../../../base/common/event.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { IEditorOptions } from "../../../../platform/editor/common/editor.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import {
	defaultInputBoxStyles,
	defaultToggleStyles,
} from "../../../../platform/theme/browser/defaultStyles.js";
// colorRegistry import removed - was unused
import { settingsSashBorder } from "../../../contrib/preferences/common/settingsEditorColorRegistry.js";
import { ThemeIcon } from "../../../../base/common/themables.js";
import { EditorPane } from "../../../browser/parts/editor/editorPane.js";
import { IEditorOpenContext } from "../../../common/editor.js";
import { IEditorGroup } from "../../../services/editor/common/editorGroupsService.js";
import { IRenAuthService } from "../common/renAuth.js";
import { RenAccountDashboardInput } from "./renAccountDashboardInput.js";
import "./media/renAccountDashboard.css";

const $ = DOM.$;

interface INavItem {
	id: string;
	label: string;
	icon: ThemeIcon;
}

interface ISettingsItem {
	id: string;
	label: string;
	subtitle: string;
	type: "button" | "toggle" | "segmented" | "link";
	action?: () => void;
	value?: boolean | string;
	options?: string[]; // for segmented control
}

interface ISettingsSection {
	id: string;
	title: string;
	items: ISettingsItem[];
}

const NAV_ITEMS: INavItem[] = [
	{
		id: "general",
		label: localize("account.general", "General"),
		icon: Codicon.settings,
	},
	{
		id: "profile",
		label: localize("account.profile", "Profile"),
		icon: Codicon.person,
	},
	{
		id: "security",
		label: localize("account.security", "Security"),
		icon: Codicon.shield,
	},
	{
		id: "billing",
		label: localize("account.billing", "Billing"),
		icon: Codicon.creditCard,
	},
	{
		id: "preferences",
		label: localize("account.preferences", "Preferences"),
		icon: Codicon.settingsGear,
	},
	{
		id: "notifications",
		label: localize("account.notifications", "Notifications"),
		icon: Codicon.bell,
	},
];

const SIDEBAR_MIN_WIDTH = 150;
const SIDEBAR_DEFAULT_WIDTH = 200;
const CONTENT_MIN_WIDTH = 400;

export class RenAccountDashboardEditor extends EditorPane {
	static readonly ID: string = "workbench.editor.renAccountDashboard";

	private rootContainer!: HTMLElement;
	private splitView!: SplitView<number>;
	private sidebarContainer!: HTMLElement;
	private contentContainer!: HTMLElement;
	private searchWidget!: InputBox;
	private navItemsContainer!: HTMLElement;
	private contentTitle!: HTMLElement;
	private contentBody!: HTMLElement;

	// User info elements
	private userEmailElement!: HTMLElement;
	private userPlanElement!: HTMLElement;

	private selectedNavItem: string = "general";
	private navItemElements: Map<string, HTMLElement> = new Map();
	private settingToggles: Map<string, Toggle> = new Map();
	private readonly disposables = new DisposableStore();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService protected override readonly themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IRenAuthService private readonly authService: IRenAuthService,
		@INotificationService
		private readonly notificationService: INotificationService,
		@IContextViewService
		private readonly contextViewService: IContextViewService
	) {
		super(
			RenAccountDashboardEditor.ID,
			group,
			telemetryService,
			themeService,
			storageService
		);
	}

	protected override createEditor(parent: HTMLElement): void {
		// Root container
		this.rootContainer = $(".ren-account-dashboard-container");
		parent.appendChild(this.rootContainer);

		// Create body container for split view
		const bodyContainer = $(".ren-account-dashboard-body");
		this.rootContainer.appendChild(bodyContainer);

		// Create sidebar and content containers
		this.sidebarContainer = $(".ren-account-dashboard-sidebar");
		this.contentContainer = $(".ren-account-dashboard-content");

		// Create split view
		this.splitView = this._register(
			new SplitView(bodyContainer, {
				orientation: Orientation.HORIZONTAL,
				proportionalLayout: true,
			})
		);

		const savedSidebarWidth = this.storageService.getNumber(
			"renAccountDashboard.sidebarWidth",
			StorageScope.PROFILE,
			SIDEBAR_DEFAULT_WIDTH
		);

		this.splitView.addView(
			{
				onDidChange: Event.None,
				element: this.sidebarContainer,
				minimumSize: SIDEBAR_MIN_WIDTH,
				maximumSize: Number.POSITIVE_INFINITY,
				layout: (width, _, height) => {
					this.sidebarContainer.style.width = `${width}px`;
					this.sidebarContainer.style.height = `${height}px`;
				},
			},
			savedSidebarWidth
		);

		this.splitView.addView(
			{
				onDidChange: Event.None,
				element: this.contentContainer,
				minimumSize: CONTENT_MIN_WIDTH,
				maximumSize: Number.POSITIVE_INFINITY,
				layout: (width, _, height) => {
					this.contentContainer.style.width = `${width}px`;
					this.contentContainer.style.height = `${height}px`;
				},
			},
			Sizing.Distribute
		);

		this._register(
			this.splitView.onDidSashChange(() => {
				const width = this.splitView.getViewSize(0);
				this.storageService.store(
					"renAccountDashboard.sidebarWidth",
					width,
					StorageScope.PROFILE,
					StorageTarget.USER
				);
			})
		);

		// Style the split view separator
		const borderColor = this.themeService
			.getColorTheme()
			.getColor(settingsSashBorder);
		if (borderColor) {
			this.splitView.style({ separatorBorder: borderColor });
		}

		// Update styles on theme change
		this._register(
			this.themeService.onDidColorThemeChange(() => {
				const newBorderColor = this.themeService
					.getColorTheme()
					.getColor(settingsSashBorder);
				if (newBorderColor) {
					this.splitView.style({ separatorBorder: newBorderColor });
				}
			})
		);

		// Create sidebar content
		this.createSidebar(this.sidebarContainer);

		// Create content area
		this.createContentArea(this.contentContainer);

		// Load initial data
		this.updateDashboard();

		// Render initial section
		this.renderContentForSection(this.selectedNavItem);
	}

	private createSidebar(parent: HTMLElement): void {
		// User info section at top
		this.createUserInfoSection(parent);

		// Search bar
		this.createSearchBar(parent);

		// Navigation list
		this.createNavigationList(parent);
	}

	private createUserInfoSection(parent: HTMLElement): void {
		const userInfoSection = $(".ren-account-dashboard-user-info");
		parent.appendChild(userInfoSection);

		this.userEmailElement = $(".ren-account-dashboard-user-email");
		userInfoSection.appendChild(this.userEmailElement);

		this.userPlanElement = $(".ren-account-dashboard-user-plan");
		userInfoSection.appendChild(this.userPlanElement);
	}

	private createSearchBar(parent: HTMLElement): void {
		const searchContainer = $(".ren-account-dashboard-search-container");
		parent.appendChild(searchContainer);

		this.searchWidget = this._register(
			new InputBox(searchContainer, this.contextViewService, {
				placeholder: localize("account.searchSettings", "Search settings ⌘F"),
				inputBoxStyles: defaultInputBoxStyles,
			})
		);

		this._register(
			this.searchWidget.onDidChange(() => {
				// Search functionality can be implemented here
				const _query = this.searchWidget.value;
				// TODO: Implement search filtering
				void _query; // Suppress unused variable warning
			})
		);
	}

	private createNavigationList(parent: HTMLElement): void {
		this.navItemsContainer = $(".ren-account-dashboard-nav-items");
		parent.appendChild(this.navItemsContainer);

		NAV_ITEMS.forEach((item) => {
			const navItem = $(".ren-account-dashboard-nav-item");
			navItem.setAttribute("data-nav-id", item.id);

			const icon = $(".ren-account-dashboard-nav-icon");
			icon.classList.add(...ThemeIcon.asClassNameArray(item.icon));
			navItem.appendChild(icon);

			const label = $(".ren-account-dashboard-nav-label");
			label.textContent = item.label;
			navItem.appendChild(label);

			if (item.id === this.selectedNavItem) {
				navItem.classList.add("selected");
			}

			this._register(
				DOM.addDisposableListener(navItem, DOM.EventType.CLICK, () => {
					this.onNavItemSelected(item.id);
				})
			);

			this.navItemElements.set(item.id, navItem);
			this.navItemsContainer.appendChild(navItem);
		});
	}

	private createContentArea(parent: HTMLElement): void {
		this.contentTitle = $(".ren-account-dashboard-content-title");
		parent.appendChild(this.contentTitle);

		this.contentBody = $(".ren-account-dashboard-content-body");
		parent.appendChild(this.contentBody);
	}

	private onNavItemSelected(itemId: string): void {
		if (this.selectedNavItem === itemId) {
			return;
		}

		// Update selected state
		const oldItem = this.navItemElements.get(this.selectedNavItem);
		if (oldItem) {
			oldItem.classList.remove("selected");
		}

		const newItem = this.navItemElements.get(itemId);
		if (newItem) {
			newItem.classList.add("selected");
		}

		this.selectedNavItem = itemId;
		this.renderContentForSection(itemId);
	}

	private renderContentForSection(sectionId: string): void {
		// Clear existing content
		DOM.clearNode(this.contentBody);

		const navItem = NAV_ITEMS.find((item) => item.id === sectionId);
		if (navItem) {
			this.contentTitle.textContent = navItem.label;
		}

		// Render sections based on selected nav item
		const sections = this.getSettingsSectionsForNav(sectionId);
		sections.forEach((section) => {
			this.createSettingsSection(this.contentBody, section);
		});
	}

	private getSettingsSectionsForNav(navId: string): ISettingsSection[] {
		switch (navId) {
			case "general":
				return this.getGeneralSections();
			case "profile":
				return this.getProfileSections();
			case "security":
				return this.getSecuritySections();
			case "billing":
				return this.getBillingSections();
			case "preferences":
				return this.getPreferencesSections();
			case "notifications":
				return this.getNotificationsSections();
			default:
				return [];
		}
	}

	private getGeneralSections(): ISettingsSection[] {
		return [
			{
				id: "general-account",
				title: localize("account.general", "General"),
				items: [
					{
						id: "manage-account",
						label: localize("account.manageAccount", "Manage Account"),
						subtitle: localize(
							"account.manageAccountSubtitle",
							"Manage your account and billing"
						),
						type: "button",
						action: () => this.handleManageAccount(),
					},
					{
						id: "upgrade-plan",
						label: localize("account.upgradePlan", "Upgrade to Ultra"),
						subtitle: localize(
							"account.upgradePlanSubtitle",
							"Get maximum value with 20x usage limits and early access to advanced features."
						),
						type: "button",
						action: () => this.handleUpgradePlan(),
					},
				],
			},
			{
				id: "general-info",
				title: localize("account.accountInformation", "Account Information"),
				items: [
					{
						id: "user-id",
						label: localize("account.userId", "User ID"),
						subtitle: "",
						type: "link",
						value: "",
					},
					{
						id: "created-date",
						label: localize("account.createdDate", "Account Created"),
						subtitle: "",
						type: "link",
						value: "",
					},
				],
			},
		];
	}

	private getProfileSections(): ISettingsSection[] {
		return [
			{
				id: "profile-main",
				title: localize("account.profile", "Profile"),
				items: [
					{
						id: "edit-profile",
						label: localize("account.editProfile", "Edit Profile"),
						subtitle: localize(
							"account.editProfileSubtitle",
							"Update your display name, username, and avatar"
						),
						type: "button",
						action: () => this.handleEditProfile(),
					},
				],
			},
		];
	}

	private getSecuritySections(): ISettingsSection[] {
		return [
			{
				id: "security-main",
				title: localize("account.security", "Security"),
				items: [
					{
						id: "change-password",
						label: localize("account.changePassword", "Change Password"),
						subtitle: localize(
							"account.changePasswordSubtitle",
							"Update your account password"
						),
						type: "button",
						action: () => this.handleChangePassword(),
					},
					{
						id: "two-factor",
						label: localize("account.twoFactor", "Two-Factor Authentication"),
						subtitle: localize(
							"account.twoFactorSubtitle",
							"Add an extra layer of security to your account"
						),
						type: "toggle",
						value: false,
					},
				],
			},
		];
	}

	private getBillingSections(): ISettingsSection[] {
		return [
			{
				id: "billing-main",
				title: localize("account.billing", "Billing"),
				items: [
					{
						id: "current-plan",
						label: localize("account.currentPlan", "Current Plan"),
						subtitle: "",
						type: "link",
						value: "",
					},
				],
			},
		];
	}

	private getPreferencesSections(): ISettingsSection[] {
		return [
			{
				id: "preferences-main",
				title: localize("account.preferences", "Preferences"),
				items: [
					{
						id: "language",
						label: localize("account.language", "Language"),
						subtitle: localize(
							"account.languageSubtitle",
							"Choose your preferred language"
						),
						type: "button",
						action: () => this.handleLanguageSettings(),
					},
				],
			},
		];
	}

	private getNotificationsSections(): ISettingsSection[] {
		return [
			{
				id: "notifications-main",
				title: localize("account.notifications", "Notifications"),
				items: [
					{
						id: "system-notifications",
						label: localize(
							"account.systemNotifications",
							"System Notifications"
						),
						subtitle: localize(
							"account.systemNotificationsSubtitle",
							"Show system notifications when Agent completes or needs attention"
						),
						type: "toggle",
						value: true,
					},
					{
						id: "email-notifications",
						label: localize(
							"account.emailNotifications",
							"Email Notifications"
						),
						subtitle: localize(
							"account.emailNotificationsSubtitle",
							"Receive email notifications for important updates"
						),
						type: "toggle",
						value: false,
					},
				],
			},
		];
	}

	private createSettingsSection(
		parent: HTMLElement,
		section: ISettingsSection
	): void {
		const sectionContainer = $(".ren-account-dashboard-settings-section");
		parent.appendChild(sectionContainer);

		const sectionTitle = $(".ren-account-dashboard-settings-section-title");
		sectionTitle.textContent = section.title;
		sectionContainer.appendChild(sectionTitle);

		section.items.forEach((item) => {
			this.createSettingsItem(sectionContainer, item);
		});
	}

	private createSettingsItem(parent: HTMLElement, item: ISettingsItem): void {
		const itemContainer = $(".ren-account-dashboard-settings-item");
		itemContainer.setAttribute("data-item-id", item.id);
		parent.appendChild(itemContainer);

		const itemLeft = $(".ren-account-dashboard-settings-item-left");
		itemContainer.appendChild(itemLeft);

		const itemLabel = $(".ren-account-dashboard-settings-item-label");
		itemLabel.textContent = item.label;
		itemLeft.appendChild(itemLabel);

		if (item.subtitle) {
			const itemSubtitle = $(".ren-account-dashboard-settings-item-subtitle");
			itemSubtitle.textContent = item.subtitle;
			itemLeft.appendChild(itemSubtitle);
		}

		const itemRight = $(".ren-account-dashboard-settings-item-right");
		itemContainer.appendChild(itemRight);

		switch (item.type) {
			case "button":
				const button = this._register(
					new Button(itemRight, {
						secondary: item.id === "upgrade-plan" ? false : true,
					})
				);
				if (item.id === "upgrade-plan") {
					button.label = localize("account.upgrade", "Upgrade");
					button.element.classList.add("ren-account-dashboard-upgrade-button");
				} else {
					button.label = localize("account.open", "Open");
				}
				if (item.action) {
					this._register(button.onDidClick(() => item.action!()));
				}
				break;

			case "toggle":
				const toggle = this._register(
					new Toggle({
						title: item.label,
						isChecked: (item.value as boolean) ?? false,
						...defaultToggleStyles,
					})
				);
				if (item.action) {
					this._register(toggle.onChange(() => item.action!()));
				}
				itemRight.appendChild(toggle.domNode);
				this.settingToggles.set(item.id, toggle);
				break;

			case "link":
				const linkValue = $(".ren-account-dashboard-settings-item-value");
				linkValue.textContent = (item.value as string) || "";
				itemRight.appendChild(linkValue);
				break;
		}
	}

	private formatDate(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "long",
			day: "numeric",
		});
	}

	private updateDashboard(): void {
		const user = this.authService.currentUser;

		if (!user) {
			this.clearDashboard();
			return;
		}

		// Update user email in sidebar
		if (this.userEmailElement) {
			this.userEmailElement.textContent = user.email ?? "";
		}

		// Update plan (defaulting to Pro Plan for now)
		if (this.userPlanElement) {
			this.userPlanElement.textContent = localize(
				"account.proPlan",
				"Pro Plan"
			);
		}

		// Update content when in general section
		if (this.selectedNavItem === "general") {
			this.updateGeneralSectionContent(user);
		}
	}

	private updateGeneralSectionContent(user: any): void {
		// Update user ID and created date in the content area
		if (!this.contentBody) {
			return;
		}

		const userIdItem = this.contentBody.querySelector(
			'[data-item-id="user-id"]'
		);
		if (userIdItem) {
			const valueElement = userIdItem.querySelector(
				".ren-account-dashboard-settings-item-value"
			);
			if (valueElement) {
				valueElement.textContent = user.id ?? "";
			}
		}

		const createdDateItem = this.contentBody.querySelector(
			'[data-item-id="created-date"]'
		);
		if (createdDateItem) {
			const valueElement = createdDateItem.querySelector(
				".ren-account-dashboard-settings-item-value"
			);
			if (valueElement) {
				if (
					user.createdAt &&
					typeof user.createdAt === "number" &&
					!isNaN(user.createdAt)
				) {
					valueElement.textContent = this.formatDate(user.createdAt);
				} else {
					valueElement.textContent = "";
				}
			}
		}
	}

	private clearDashboard(): void {
		if (this.userEmailElement) {
			this.userEmailElement.textContent = "";
		}
		if (this.userPlanElement) {
			this.userPlanElement.textContent = "";
		}
	}


	private handleManageAccount(): void {
		this.notificationService.info(
			localize("account.manageAccountComingSoon", "Manage Account coming soon!")
		);
	}

	private handleUpgradePlan(): void {
		this.notificationService.info(
			localize("account.upgradePlanComingSoon", "Upgrade Plan coming soon!")
		);
	}

	private handleEditProfile(): void {
		this.onNavItemSelected("profile");
	}

	private handleChangePassword(): void {
		this.notificationService.info(
			localize(
				"account.changePasswordComingSoon",
				"Change Password coming soon!"
			)
		);
	}

	private handleLanguageSettings(): void {
		this.notificationService.info(
			localize(
				"account.languageSettingsComingSoon",
				"Language Settings coming soon!"
			)
		);
	}

	override async setInput(
		input: RenAccountDashboardInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateDashboard();

		// Listen to user changes
		this.disposables.clear();
		this.disposables.add(
			this.authService.onDidChangeUser(() => {
				this.updateDashboard();
				// Re-render current section if it needs user data
				if (this.selectedNavItem === "general") {
					this.updateGeneralSectionContent(this.authService.currentUser || {});
				}
			})
		);
	}

	override clearInput(): void {
		this.disposables.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
	}

	override layout(dimension: DOM.Dimension): void {
		if (this.splitView) {
			this.splitView.layout(dimension.width, dimension.height);
		}
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}
