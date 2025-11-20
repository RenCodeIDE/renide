/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ViewPane, IViewPaneOptions } from "../../../../../browser/parts/views/viewPane.js";
import { IInstantiationService } from "../../../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../../../platform/keybinding/common/keybinding.js";
import { IContextMenuService } from "../../../../../../platform/contextview/browser/contextView.js";
import { IConfigurationService } from "../../../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../../../platform/contextkey/common/contextkey.js";
import { IViewDescriptorService } from "../../../../../common/views.js";
import { IOpenerService } from "../../../../../../platform/opener/common/opener.js";
import { IThemeService } from "../../../../../../platform/theme/common/themeService.js";
import { IHoverService } from "../../../../../../platform/hover/browser/hover.js";
import { IRenMonitorXChangelogBuffer, IMonitorXChangelogDraft } from "../../../common/renChangelogBuffer.js";
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from "../../../common/renWorkspaceStore.js";

export class MonitorXViewPane extends ViewPane {
	private contentContainer: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IRenMonitorXChangelogBuffer private readonly changelogBuffer: IRenMonitorXChangelogBuffer,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);

		this._register(this.changelogBuffer.onDidChangeDraft(() => this.updateView()));
		this._register(this.workspaceStore.onDidChangeChangelog(() => this.updateView()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add("ren-monitorx-view");

		this.contentContainer = document.createElement("div");
		this.contentContainer.className = "ren-monitorx-view__content";
		this.contentContainer.style.height = "100%";
		this.contentContainer.style.overflowY = "auto";
		this.contentContainer.style.padding = "10px";
		container.appendChild(this.contentContainer);

		this.updateView();
	}

	private async updateView(): Promise<void> {
		if (!this.contentContainer) {
			return;
		}

		this.contentContainer.textContent = "";

		// Drafts Section
		const drafts = this.changelogBuffer.listDrafts();
		if (drafts.length > 0) {
			this.renderSectionHeader("Pending Drafts", drafts.length);
			for (const draft of drafts) {
				this.renderDraftItem(draft);
			}
		}

		// Confirmed Section
		const entries = await this.workspaceStore.getRecentChangelogEntries(20);
		if (entries.length > 0) {
			this.renderSectionHeader("Recent Changes", entries.length);
			for (const entry of entries) {
				this.renderEntryItem(entry);
			}
		} else if (drafts.length === 0) {
			this.renderEmptyState();
		}
	}

	private renderSectionHeader(title: string, count: number): void {
		const header = document.createElement("div");
		header.style.fontWeight = "600";
		header.style.marginTop = "10px";
		header.style.marginBottom = "5px";
		header.style.fontSize = "11px";
		header.style.textTransform = "uppercase";
		header.style.color = "var(--vscode-descriptionForeground)";
		header.textContent = `${title} (${count})`;
		this.contentContainer!.appendChild(header);
	}

	private renderDraftItem(draft: IMonitorXChangelogDraft): void {
		const item = document.createElement("div");
		item.style.marginBottom = "8px";
		item.style.padding = "8px";
		item.style.backgroundColor = "var(--vscode-list-hoverBackground)";
		item.style.borderRadius = "4px";
		item.style.borderLeft = "3px solid var(--vscode-charts-yellow)";

		const subject = document.createElement("div");
		subject.style.fontWeight = "600";
		subject.textContent = draft.subject;
		item.appendChild(subject);

		const desc = document.createElement("div");
		desc.style.fontSize = "12px";
		desc.style.marginTop = "4px";
		desc.style.color = "var(--vscode-descriptionForeground)";
		desc.textContent = draft.description;
		item.appendChild(desc);

		const meta = document.createElement("div");
		meta.style.fontSize = "11px";
		meta.style.marginTop = "4px";
		meta.style.opacity = "0.8";
		meta.textContent = `${draft.files.length} file(s) changed • ${new Date(draft.updatedAt).toLocaleTimeString()}`;
		item.appendChild(meta);

		this.contentContainer!.appendChild(item);
	}

	private renderEntryItem(entry: IMonitorXChangelogEntry): void {
		const item = document.createElement("div");
		item.style.marginBottom = "8px";
		item.style.padding = "8px";
		item.style.backgroundColor = "var(--vscode-list-hoverBackground)";
		item.style.borderRadius = "4px";
		item.style.borderLeft = "3px solid var(--vscode-charts-green)";

		const subject = document.createElement("div");
		subject.style.fontWeight = "600";
		subject.textContent = entry.subject;
		item.appendChild(subject);

		const desc = document.createElement("div");
		desc.style.fontSize = "12px";
		desc.style.marginTop = "4px";
		desc.style.color = "var(--vscode-descriptionForeground)";
		desc.textContent = entry.description;
		item.appendChild(desc);

		const meta = document.createElement("div");
		meta.style.fontSize = "11px";
		meta.style.marginTop = "4px";
		meta.style.opacity = "0.8";
		meta.textContent = `${entry.files.length} file(s) • ${new Date(entry.timestamp).toLocaleDateString()}`;
		item.appendChild(meta);

		this.contentContainer!.appendChild(item);
	}

	private renderEmptyState(): void {
		const empty = document.createElement("div");
		empty.style.padding = "20px";
		empty.style.textAlign = "center";
		empty.style.color = "var(--vscode-descriptionForeground)";
		empty.textContent = "No changelog entries found.";
		this.contentContainer!.appendChild(empty);
	}

	protected override layoutBody(height: number, width: number): void {
		// No-op
	}
}

