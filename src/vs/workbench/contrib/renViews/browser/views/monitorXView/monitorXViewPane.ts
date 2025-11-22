/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ViewPane,
	IViewPaneOptions,
} from "../../../../../browser/parts/views/viewPane.js";
import * as dom from "../../../../../../base/browser/dom.js";
import { IInstantiationService } from "../../../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../../../platform/keybinding/common/keybinding.js";
import { IContextMenuService } from "../../../../../../platform/contextview/browser/contextView.js";
import { IConfigurationService } from "../../../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../../../platform/contextkey/common/contextkey.js";
import { IViewDescriptorService } from "../../../../../common/views.js";
import { IOpenerService } from "../../../../../../platform/opener/common/opener.js";
import { IThemeService } from "../../../../../../platform/theme/common/themeService.js";
import { IHoverService } from "../../../../../../platform/hover/browser/hover.js";
import {
	IRenMonitorXChangelogBuffer,
	IMonitorXChangelogDraft,
} from "../../../common/renChangelogBuffer.js";
import { IMonitorXChangelogFilter } from "../../../common/renChangelogFilter.js";
import {
	IRenWorkspaceStore,
	IMonitorXChangelogEntry,
} from "../../../common/renWorkspaceStore.js";
import { IEditorService } from "../../../../../services/editor/common/editorService.js";
import { URI } from "../../../../../../base/common/uri.js";

export class MonitorXViewPane extends ViewPane {
	private contentContainer: HTMLElement | undefined;
	private filter: IMonitorXChangelogFilter = {};

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
		@IRenMonitorXChangelogBuffer
		private readonly changelogBuffer: IRenMonitorXChangelogBuffer,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IEditorService private readonly editorService: IEditorService
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

		this._register(
			this.changelogBuffer.onDidChangeDraft(() => this.updateView())
		);
		this._register(
			this.workspaceStore.onDidChangeChangelog(() => this.updateView())
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Use flex layout for the main container to handle filter section + content
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		this.renderFilters(container);

		this.contentContainer = document.createElement("div");
		this.contentContainer.style.flex = "1";
		this.contentContainer.style.overflow = "auto";
		this.contentContainer.style.padding = "10px";
		container.appendChild(this.contentContainer);

		this.updateView();
	}

	private renderFilters(container: HTMLElement): void {
		const filterSection = document.createElement("div");
		filterSection.style.padding = "12px";
		filterSection.style.borderBottom = "1px solid var(--vscode-panel-border)";
		filterSection.style.display = "flex";
		filterSection.style.flexDirection = "column";
		filterSection.style.gap = "8px";
		filterSection.style.flexShrink = "0";
		filterSection.style.backgroundColor = "var(--vscode-sideBar-background)";

		// Row 1: Text Search
		const searchWrapper = this.createInputWithIcon("codicon-search", "Search changes...", (val) => {
			this.filter.text = val;
			this.updateView();
		});
		filterSection.appendChild(searchWrapper);

		// Row 2: File + Time
		const row2 = document.createElement("div");
		row2.style.display = "flex";
		row2.style.gap = "8px";
		
		const fileWrapper = this.createInputWithIcon("codicon-file", "Filter files...", (val) => {
			this.filter.filePath = val;
			this.updateView();
		});
		fileWrapper.style.flex = "1";
		
		const timeSelect = this.createTimeSelect();
		timeSelect.style.flex = "1";
		
		row2.appendChild(fileWrapper);
		row2.appendChild(timeSelect);
		filterSection.appendChild(row2);

		container.appendChild(filterSection);
	}

	private createInputWithIcon(iconClass: string, placeholder: string, onChange: (val: string) => void): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.style.position = "relative";
		wrapper.style.display = "flex";
		wrapper.style.alignItems = "center";
		
		const icon = document.createElement("div");
		icon.className = `codicon ${iconClass}`;
		icon.style.position = "absolute";
		icon.style.left = "6px";
		icon.style.zIndex = "10";
		icon.style.fontSize = "14px";
		icon.style.color = "var(--vscode-input-placeholderForeground)";
		icon.style.pointerEvents = "none";
		wrapper.appendChild(icon);
		
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = placeholder;
		input.style.width = "100%";
		input.style.height = "26px";
		input.style.padding = "0 8px 0 26px"; // Space for icon
		input.style.backgroundColor = "var(--vscode-input-background)";
		input.style.color = "var(--vscode-input-foreground)";
		input.style.border = "1px solid var(--vscode-input-border)";
		input.style.borderRadius = "2px";
		input.style.outline = "none";
		input.style.fontSize = "12px";
		input.style.boxSizing = "border-box";
		
		// Focus styles
		input.onfocus = () => input.style.border = "1px solid var(--vscode-focusBorder)";
		input.onblur = () => input.style.border = "1px solid var(--vscode-input-border)";
		
		input.oninput = () => onChange(input.value);
		
		wrapper.appendChild(input);
		return wrapper;
	}

	private createTimeSelect(): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.style.position = "relative";
		
		const select = document.createElement("select");
		select.style.width = "100%";
		select.style.height = "26px";
		select.style.padding = "0 8px";
		select.style.backgroundColor = "var(--vscode-dropdown-background)";
		select.style.color = "var(--vscode-dropdown-foreground)";
		select.style.border = "1px solid var(--vscode-dropdown-border)";
		select.style.borderRadius = "2px";
		select.style.outline = "none";
		select.style.fontSize = "12px";
		select.style.boxSizing = "border-box";
		select.style.cursor = "pointer";

		const options = [
			{ label: "All Time", value: "all" },
			{ label: "Last 24 Hours", value: "24h" },
			{ label: "Last 7 Days", value: "7d" },
			{ label: "Last 30 Days", value: "30d" }
		];

		options.forEach(opt => {
			const option = document.createElement("option");
			option.value = opt.value;
			option.textContent = opt.label;
			select.appendChild(option);
		});

		select.onchange = () => {
			const now = Date.now();
			switch (select.value) {
				case "24h":
					this.filter.fromDate = now - 24 * 60 * 60 * 1000;
					break;
				case "7d":
					this.filter.fromDate = now - 7 * 24 * 60 * 60 * 1000;
					break;
				case "30d":
					this.filter.fromDate = now - 30 * 24 * 60 * 60 * 1000;
					break;
				default:
					this.filter.fromDate = undefined;
			}
			this.updateView();
		};
		
		// Focus styles
		select.onfocus = () => select.style.border = "1px solid var(--vscode-focusBorder)";
		select.onblur = () => select.style.border = "1px solid var(--vscode-dropdown-border)";
		
		wrapper.appendChild(select);
		return wrapper;
	}


	private async updateView(): Promise<void> {
		if (!this.contentContainer) {
			return;
		}

		try {
			// Get all pending drafts (not just one with hardcoded sessionId)
			const drafts = this.changelogBuffer.listDrafts(this.filter);
			const entries = await this.workspaceStore.getAllChangelogEntries(this.filter);

			// Debug logging
			if (typeof process !== 'undefined' && process.env?.['VSCODE_DEV'] === 'true') {
				console.log('[MonitorXViewPane] updateView', { 
					draftsCount: drafts.length, 
					entriesCount: entries.length,
					draftSessionIds: drafts.map(d => d.sessionId),
					entryIds: entries.map(e => e.id)
				});
			}

			if (!this.contentContainer) {
				return;
			}

			dom.clearNode(this.contentContainer);

			// Show pending drafts section if any exist
			if (drafts.length > 0) {
				this.renderSectionHeader("Pending Drafts", drafts.length);
				// Sort drafts by updatedAt descending (most recent first)
				const sortedDrafts = [...drafts].sort((a, b) => b.updatedAt - a.updatedAt);
				for (const draft of sortedDrafts) {
					this.renderDraftItem(draft);
				}
			}

			// Show confirmed entries section
			if (entries.length > 0) {
				if (drafts.length > 0) {
					// Add spacing between sections
					const spacer = document.createElement("div");
					spacer.style.marginTop = "16px";
					spacer.style.marginBottom = "8px";
					this.contentContainer.appendChild(spacer);
				}
				this.renderSectionHeader("Recent Changes", entries.length);
				// Sort by timestamp descending
				const sortedEntries = [...entries].sort(
					(a, b) => b.timestamp - a.timestamp
				);
				for (const entry of sortedEntries) {
					this.renderEntryItem(entry);
				}
			}

			// Show empty state if no drafts or entries
			if (drafts.length === 0 && entries.length === 0) {
				this.renderEmptyState();
			}
		} catch (error) {
			// Ensure we still have a container to render error into
			if (!this.contentContainer) {
				return;
			}

			// Clear loading state and show error
			dom.clearNode(this.contentContainer);
			const errorDiv = document.createElement("div");
			errorDiv.style.padding = "20px";
			errorDiv.style.textAlign = "center";
			errorDiv.style.color = "var(--vscode-errorForeground)";
			
			const errorTitle = document.createElement("div");
			errorTitle.style.fontWeight = "600";
			errorTitle.style.marginBottom = "8px";
			errorTitle.textContent = "Failed to load changelog";
			errorDiv.appendChild(errorTitle);
			
			const errorMessage = document.createElement("div");
			errorMessage.style.fontSize = "12px";
			errorMessage.style.color = "var(--vscode-descriptionForeground)";
			const errorText = error instanceof Error ? error.message : String(error);
			errorMessage.textContent = errorText || "Unknown error occurred";
			errorDiv.appendChild(errorMessage);
			
			this.contentContainer.appendChild(errorDiv);
			
			// Log error for debugging
			console.error("[MonitorXViewPane] Failed to load changelog:", error);
		}
	}

	private renderSectionHeader(title: string, count: number): void {
		const header = document.createElement("div");
		header.style.fontSize = "12px";
		header.style.fontWeight = "600";
		header.style.marginBottom = "8px";
		header.style.marginTop = "8px";
		header.style.color = "var(--vscode-sideBarSectionHeader-foreground)";
		header.style.textTransform = "uppercase";
		header.textContent = `${title} (${count})`;
		this.contentContainer!.appendChild(header);
	}

	private renderDraftItem(draft: IMonitorXChangelogDraft): void {
		const item = document.createElement("div");
		item.style.marginBottom = "16px";
		item.style.padding = "10px";
		item.style.border = "1px solid var(--vscode-sideBarSectionHeader-border)";
		item.style.borderRadius = "4px";
		item.style.backgroundColor = "var(--vscode-sideBar-background)";

		const header = document.createElement("div");
		header.style.fontWeight = "bold";
		header.style.marginBottom = "4px";
		header.style.display = "flex";
		header.style.alignItems = "center";

		const badge = document.createElement("span");
		badge.textContent = "DRAFT";
		badge.style.fontSize = "10px";
		badge.style.backgroundColor = "var(--vscode-badge-background)";
		badge.style.color = "var(--vscode-badge-foreground)";
		badge.style.padding = "2px 6px";
		badge.style.borderRadius = "10px";
		badge.style.marginRight = "8px";
		header.appendChild(badge);

		const title = document.createElement("span");
		title.textContent = draft.description || "Work in progress...";
		header.appendChild(title);

		item.appendChild(header);

		const meta = document.createElement("div");
		meta.style.fontSize = "11px";
		meta.style.marginTop = "4px";
		meta.style.opacity = "0.8";
		meta.textContent = `Updated ${new Date(
			draft.updatedAt
		).toLocaleTimeString()}`;
		item.appendChild(meta);

		this.renderFileList(item, draft.files);
		this.renderDiffActions(item, draft);

		this.contentContainer!.appendChild(item);
	}

	private renderEntryItem(entry: IMonitorXChangelogEntry): void {
		const item = document.createElement("div");
		item.style.marginBottom = "16px";
		item.style.padding = "10px";
		item.style.border = "1px solid var(--vscode-sideBarSectionHeader-border)";
		item.style.borderRadius = "4px";

		const header = document.createElement("div");
		header.style.fontWeight = "bold";
		header.style.marginBottom = "4px";
		header.textContent = entry.description;
		item.appendChild(header);

		const meta = document.createElement("div");
		meta.style.fontSize = "11px";
		meta.style.marginTop = "4px";
		meta.style.opacity = "0.8";
		meta.textContent = `Saved ${new Date(
			entry.timestamp
		).toLocaleDateString()}`;
		item.appendChild(meta);

		this.renderFileList(item, entry.files);
		this.renderDiffActions(item, entry);

		this.contentContainer!.appendChild(item);
	}

	private renderFileList(container: HTMLElement, files: readonly { path: string; diff: string }[]): void {
		if (!files || files.length === 0) {
			return;
		}

		const list = document.createElement("div");
		list.style.marginTop = "8px";
		list.style.fontSize = "11px";
		list.style.display = "flex";
		list.style.flexDirection = "column";
		list.style.gap = "4px";

		for (const file of files) {
			const row = document.createElement("div");
			row.style.display = "flex";
			row.style.justifyContent = "space-between";
			row.style.alignItems = "center";
			row.style.padding = "2px 4px";
			row.style.backgroundColor = "var(--vscode-textBlockQuote-background)";
			row.style.borderRadius = "2px";

			// Extract filename from path (handle both forward and backslashes)
			const fileName = file.path.split(/[/\\]/).pop() || file.path;

			const path = document.createElement("span");
			path.textContent = fileName;
			path.style.fontFamily = "var(--vscode-editor-font-family)";
			path.style.overflow = "hidden";
			path.style.textOverflow = "ellipsis";
			path.style.whiteSpace = "nowrap";
			// Show full path on hover
			path.title = file.path;
			row.appendChild(path);

			const ranges = document.createElement("span");
			ranges.textContent = this.getLineRanges(file.diff);
			ranges.style.opacity = "0.7";
			ranges.style.marginLeft = "8px";
			ranges.style.flexShrink = "0";
			row.appendChild(ranges);

			list.appendChild(row);
		}

		container.appendChild(list);
	}

	private getLineRanges(diff: string): string {
		if (!diff) return "";
		
		const ranges: string[] = [];
		// More robust regex to handle spacing in diff headers
		const regex = /^@@\s+-[0-9,]+\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
		let match;
		
		// Check first few lines of diff for headers
		while ((match = regex.exec(diff)) !== null) {
			const start = parseInt(match[1], 10);
			const count = match[2] ? parseInt(match[2], 10) : 1;
			if (count === 0) continue;
			
			const end = start + count - 1;
			if (start === end) {
				ranges.push(`${start}`);
			} else {
				ranges.push(`${start}-${end}`);
			}
			
			// Limit to first few ranges to keep UI clean
			if (ranges.length >= 3) {
				ranges.push("...");
				break;
			}
		}
		
		return ranges.length > 0 ? `:${ranges.join(", ")}` : "";
	}

	private renderDiffActions(
		container: HTMLElement,
		entry: IMonitorXChangelogDraft | IMonitorXChangelogEntry
	): void {
		if (!entry.files || entry.files.length === 0) {
			return;
		}

		const actions = document.createElement("div");
		actions.style.display = "flex";
		actions.style.gap = "10px";
		actions.style.marginTop = "8px";
		actions.style.fontSize = "11px";

		const diffLink = document.createElement("a");
		diffLink.textContent = "Show Diffs";
		diffLink.style.cursor = "pointer";
		diffLink.style.textDecoration = "underline";
		diffLink.style.color = "var(--vscode-textLink-foreground)";
		diffLink.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openDiffs(entry);
		};
		actions.appendChild(diffLink);

		container.appendChild(actions);
	}

	private async openDiffs(
		entry: IMonitorXChangelogDraft | IMonitorXChangelogEntry
	): Promise<void> {
		const id = "sessionId" in entry ? entry.sessionId : entry.id;
		const content = entry.files
			.map(
				(f) => `File: ${f.path}\n${"=".repeat(f.path.length + 6)}\n${f.diff}`
			)
			.join("\n\n");

		const resource = URI.from({
			scheme: "untitled",
			path: `Changelog-Diff-${id.substring(0, 8)}.diff`,
		});

		await this.editorService.openEditor({
			resource,
			contents: content,
			options: {
				pinned: true,
			},
		});
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
