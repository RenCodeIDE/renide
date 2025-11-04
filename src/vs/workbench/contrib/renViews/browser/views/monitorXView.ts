/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { IRenView } from "./renView.interface.js";
import { IRenWorkspaceStore } from "../../common/renWorkspaceStore.js";
import { IChatService, IChatDetail } from "../../../chat/common/chatService.js";
import { IMarkdownRendererService } from "../../../../../platform/markdown/browser/markdownRenderer.js";
import { MonitorXChatController } from "./monitorXChatController.js";
import {
	observableValue,
	autorun,
	ISettableObservable,
} from "../../../../../base/common/observable.js";
import { ButtonWithIcon } from "../../../../../base/browser/ui/button/button.js";
import { Codicon } from "../../../../../base/common/codicons.js";
import { $ } from "../../../../../base/browser/dom.js";
import {
	ChatSessionRecency,
	ChatSessionStatus,
} from "../../../chat/common/chatSessionsService.js";

export class MonitorXView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;
	private _chatController: MonitorXChatController | undefined;
	private _chatHistoryContainer: HTMLElement | null = null;
	private _chatHistoryExpanded: ISettableObservable<boolean> | undefined;
	private _searchFilter: string = "";
	private _sectionCollapsedStates: Map<
		ChatSessionRecency,
		ISettableObservable<boolean>
	> = new Map();

	constructor(
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IChatService private readonly chatService: IChatService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService
	) {
		super();
	}

	async show(contentArea: HTMLElement): Promise<void> {
		contentArea.textContent = "";

		this._container = document.createElement("div");
		this._container.className = "ren-monitorx-container";

		// Add chat section
		const chatSection = document.createElement("section");
		chatSection.className = "ren-monitorx-chat-section";

		const chatHeader = document.createElement("div");
		chatHeader.className = "ren-monitorx-chat-header";

		const chatTitle = document.createElement("h3");
		chatTitle.textContent = "AI Assistant";
		chatTitle.className = "ren-monitorx-chat-title";

		const newChatButton = document.createElement("button");
		newChatButton.textContent = "New Chat";
		newChatButton.className = "ren-monitorx-new-chat-button";
		newChatButton.onclick = () => this.startNewChat();

		chatHeader.appendChild(chatTitle);
		chatHeader.appendChild(newChatButton);
		chatSection.appendChild(chatHeader);

		// Create flex container for sidebar + main content
		const chatContainer = document.createElement("div");
		chatContainer.className = "ren-monitorx-chat-container";

		// Create sidebar for chat history
		const sidebar = document.createElement("div");
		sidebar.className = "ren-monitorx-chat-sidebar";

		// Sidebar header with toggle button
		const sidebarHeader = document.createElement("div");
		sidebarHeader.className = "ren-monitorx-chat-sidebar-header";
		const toggleButtonEl = $(".ren-monitorx-chat-sidebar-toggle");
		const toggleButton = this._register(new ButtonWithIcon(toggleButtonEl, {}));
		toggleButton.label = "Chat History";
		sidebarHeader.appendChild(toggleButtonEl);

		// Sidebar content (history list)
		const sidebarContent = document.createElement("div");
		sidebarContent.className = "ren-monitorx-chat-sidebar-content";

		// Add search input
		const searchContainer = document.createElement("div");
		searchContainer.className = "ren-monitorx-chat-history-search-container";

		const searchInput = document.createElement("input");
		searchInput.type = "text";
		searchInput.className = "ren-monitorx-chat-history-search-input";
		searchInput.placeholder = "Search conversations...";
		searchInput.setAttribute("aria-label", "Search chat history");

		// Search icon
		const searchIcon = document.createElement("span");
		searchIcon.className = "codicon codicon-search";
		searchIcon.setAttribute("aria-hidden", "true");

		const searchWrapper = document.createElement("div");
		searchWrapper.className = "ren-monitorx-chat-history-search-wrapper";
		searchWrapper.appendChild(searchIcon);
		searchWrapper.appendChild(searchInput);
		searchContainer.appendChild(searchWrapper);

		// Clear search button (hidden by default)
		const clearButton = document.createElement("button");
		clearButton.className = "ren-monitorx-chat-history-search-clear";
		clearButton.setAttribute("aria-label", "Clear search");
		const clearIcon = document.createElement("span");
		clearIcon.className = "codicon codicon-close";
		clearButton.appendChild(clearIcon);
		clearButton.style.display = "none";
		clearButton.onclick = () => {
			searchInput.value = "";
			this._searchFilter = "";
			clearButton.style.display = "none";
			void this.renderChatHistory();
		};
		searchContainer.appendChild(clearButton);

		// Search input handler
		let searchTimeout: ReturnType<typeof setTimeout> | undefined;
		searchInput.addEventListener("input", () => {
			this._searchFilter = searchInput.value.trim().toLowerCase();
			clearButton.style.display = this._searchFilter ? "flex" : "none";

			// Debounce search
			if (searchTimeout) {
				clearTimeout(searchTimeout);
			}
			searchTimeout = setTimeout(() => {
				void this.renderChatHistory();
			}, 300);
		});

		sidebarContent.appendChild(searchContainer);
		this._chatHistoryContainer = document.createElement("div");
		this._chatHistoryContainer.className = "ren-monitorx-chat-history-list";
		sidebarContent.appendChild(this._chatHistoryContainer);

		sidebar.appendChild(sidebarHeader);
		sidebar.appendChild(sidebarContent);

		// Initialize sidebar state from workspace storage
		const storedState =
			this.workspaceStore.getBoolean("monitorx.chatHistoryExpanded", true) ??
			true;
		this._chatHistoryExpanded = observableValue(this, storedState);

		// Persist state changes to workspace storage
		this._register(
			autorun((reader) => {
			const expanded = this._chatHistoryExpanded!.read(reader);
				this.workspaceStore.setBoolean(
					"monitorx.chatHistoryExpanded",
					expanded
				);
			})
		);

		// React to state changes - update UI
		this._register(
			autorun((reader) => {
			const expanded = this._chatHistoryExpanded!.read(reader);
				toggleButton.icon = expanded
					? Codicon.chevronLeft
					: Codicon.chevronRight;
				sidebar.classList.toggle("collapsed", !expanded);
				sidebarContent.style.display = expanded ? "" : "none";
			})
		);

		// Toggle button click handler
		this._register(
			toggleButton.onDidClick(() => {
			const current = this._chatHistoryExpanded!.get();
			this._chatHistoryExpanded!.set(!current, undefined);
			})
		);

		// Main chat panel container
		const chatPanelWrapper = document.createElement("div");
		chatPanelWrapper.className = "ren-monitorx-chat-main";

		// Chat panel container
		const chatPanel = document.createElement("div");
		chatPanel.className = "ren-monitorx-chat-widget-container";
		chatPanelWrapper.appendChild(chatPanel);

		// Assemble layout
		chatContainer.appendChild(sidebar);
		chatContainer.appendChild(chatPanelWrapper);
		chatSection.appendChild(chatContainer);

		this._container.appendChild(chatSection);
		contentArea.appendChild(this._container);

		// Initialize chat panel and render history
		this._chatController = this._register(
			new MonitorXChatController(
				chatPanel,
				this.chatService,
				this.markdownRendererService
			)
		);
		await this._chatController.initialize();
		await this.renderChatHistory();

		// Setup keyboard shortcuts
		this.setupKeyboardShortcuts(contentArea, searchInput);
	}

	private setupKeyboardShortcuts(
		container: HTMLElement,
		searchInput: HTMLInputElement
	): void {
		const onKeyDown = (event: KeyboardEvent) => {
			// Only handle shortcuts when the view is visible and focused
			if (!this._container || !this._container.contains(document.activeElement)) {
				return;
			}

			const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
			const modKey = isMac ? event.metaKey : event.ctrlKey;

			// Cmd/Ctrl + K: Focus search input
			if (modKey && event.key === "k" && !event.shiftKey && !event.altKey) {
				event.preventDefault();
				searchInput.focus();
				searchInput.select();
				return;
			}

			// Cmd/Ctrl + N: Start new chat
			if (modKey && event.key === "n" && !event.shiftKey && !event.altKey) {
				event.preventDefault();
				void this.startNewChat();
				return;
			}

			// Esc: Context-aware
			if (event.key === "Escape" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
				// If search input is focused, clear search
				if (document.activeElement === searchInput) {
					searchInput.value = "";
					this._searchFilter = "";
					void this.renderChatHistory();
					searchInput.blur();
					// Focus chat input
					this._chatController?.focusInput();
					return;
				}
				// If chat input is focused, clear it
				// (This is handled by the chat controller itself)
			}

			// Arrow Up/Down: Navigate history (when not in input)
			if (
				(event.key === "ArrowUp" || event.key === "ArrowDown") &&
				document.activeElement !== searchInput &&
				!this._chatController?.isInputFocused()
			) {
				event.preventDefault();
				this.navigateHistory(event.key === "ArrowDown");
				return;
			}

			// Enter: Select highlighted history item
			if (
				event.key === "Enter" &&
				!event.shiftKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				this._selectedHistoryIndex >= 0 &&
				document.activeElement !== searchInput &&
				!this._chatController?.isInputFocused()
			) {
				event.preventDefault();
				const historyItems = Array.from(
					this._chatHistoryContainer?.querySelectorAll<HTMLElement>(
						".ren-monitorx-chat-history-item"
					) ?? []
				);
				if (historyItems[this._selectedHistoryIndex]) {
					historyItems[this._selectedHistoryIndex].click();
				}
				return;
			}
		};

		container.addEventListener("keydown", onKeyDown);
		this._register({
			dispose: () => container.removeEventListener("keydown", onKeyDown),
		});
	}

	private _selectedHistoryIndex: number = -1;

	private navigateHistory(down: boolean): void {
		if (!this._chatHistoryContainer) {
			return;
		}

		const historyItems = Array.from(
			this._chatHistoryContainer.querySelectorAll<HTMLElement>(
				".ren-monitorx-chat-history-item"
			)
		);

		if (historyItems.length === 0) {
			return;
		}

		if (down) {
			this._selectedHistoryIndex =
				(this._selectedHistoryIndex + 1) % historyItems.length;
		} else {
			this._selectedHistoryIndex =
				this._selectedHistoryIndex <= 0
					? historyItems.length - 1
					: this._selectedHistoryIndex - 1;
		}

		// Update visual selection
		historyItems.forEach((item, index) => {
			item.classList.toggle("active", index === this._selectedHistoryIndex);
			if (index === this._selectedHistoryIndex) {
				item.scrollIntoView({ block: "nearest", behavior: "smooth" });
				item.focus();
			}
		});

		// Enter to select - handled by the main keyboard handler
		// The Enter key will be caught by the container's keydown handler
	}

	private async renderChatHistory(): Promise<void> {
		if (!this._chatHistoryContainer) {
			return;
		}

		// Reset selected history index when re-rendering
		this._selectedHistoryIndex = -1;

		// Clear existing history
		this._chatHistoryContainer.textContent = "";

		try {
			// Get chat history
			const history = await this.chatService.getHistory();

			if (history.length === 0) {
				const emptyState = document.createElement("div");
				emptyState.className = "ren-monitorx-chat-history-empty";

				const icon = document.createElement("span");
				icon.className = "codicon codicon-comment-discussion";
				icon.setAttribute("aria-hidden", "true");
				emptyState.appendChild(icon);

				const message = document.createElement("div");
				message.className = "ren-monitorx-chat-history-empty-message";
				message.textContent = "No past conversations";
				emptyState.appendChild(message);

				const hint = document.createElement("div");
				hint.className = "ren-monitorx-chat-history-empty-hint";
				hint.textContent = "Start a new chat to begin your conversation";
				emptyState.appendChild(hint);

				this._chatHistoryContainer.appendChild(emptyState);
				return;
			}

			const activeSessionId = this._chatController?.sessionId;
			const now = Date.now();
			const ONE_DAY_MS = 24 * 60 * 60 * 1000;

			// Filter history by search term if provided
			let filteredHistory = history;
			if (this._searchFilter) {
				filteredHistory = history.filter((item) => {
					const title = (item.title || "").toLowerCase();
					return title.includes(this._searchFilter);
				});
			}

			// Group history items by recency
			const activeItems: IChatDetail[] = [];
			const recentItems: IChatDetail[] = [];
			const staleItems: IChatDetail[] = [];

			for (const item of filteredHistory) {
				const model = this.chatService.getSession(item.sessionId);
				let recency: ChatSessionRecency;

				if (model && model.sessionRecencyObs) {
					// Use the model's recency observable if available
					recency = model.sessionRecencyObs.get();
				} else {
					// Determine recency from lastMessageDate and status
					if (model && model.sessionStatusObs) {
						const status = model.sessionStatusObs.get();
						if (status === ChatSessionStatus.InProgress) {
							recency = ChatSessionRecency.Active;
						} else {
							// Completed or Failed - check if recent
							const timeSinceLastActivity = now - item.lastMessageDate;
							recency =
								timeSinceLastActivity < ONE_DAY_MS
									? ChatSessionRecency.Recent
									: ChatSessionRecency.Stale;
						}
					} else {
						// Model not loaded - determine from timestamp
						const timeSinceLastActivity = now - item.lastMessageDate;
						recency =
							timeSinceLastActivity < ONE_DAY_MS
								? ChatSessionRecency.Recent
								: ChatSessionRecency.Stale;
					}
				}

				// Group into appropriate array
				if (recency === ChatSessionRecency.Active) {
					activeItems.push(item);
				} else if (recency === ChatSessionRecency.Recent) {
					recentItems.push(item);
				} else {
					staleItems.push(item);
				}
			}

			// Sort each group by last message date (most recent first)
			activeItems.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
			recentItems.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
			staleItems.sort((a, b) => b.lastMessageDate - a.lastMessageDate);

			// Show message if no results from search
			if (this._searchFilter && filteredHistory.length === 0) {
				const noResults = document.createElement("div");
				noResults.className = "ren-monitorx-chat-history-empty";

				const icon = document.createElement("span");
				icon.className = "codicon codicon-search";
				icon.setAttribute("aria-hidden", "true");
				noResults.appendChild(icon);

				const message = document.createElement("div");
				message.className = "ren-monitorx-chat-history-empty-message";
				message.textContent = "No conversations found";
				noResults.appendChild(message);

				const hint = document.createElement("div");
				hint.className = "ren-monitorx-chat-history-empty-hint";
				hint.textContent = "Try a different search term";
				noResults.appendChild(hint);

				this._chatHistoryContainer.appendChild(noResults);
				return;
			}

			// Render sections
			this.renderHistorySection(
				"Active",
				activeItems,
				activeSessionId,
				ChatSessionRecency.Active
			);
			this.renderHistorySection(
				"Recent",
				recentItems,
				activeSessionId,
				ChatSessionRecency.Recent
			);
			this.renderHistorySection(
				"Stale",
				staleItems,
				activeSessionId,
				ChatSessionRecency.Stale
			);
		} catch (error) {
			console.error("Failed to render chat history:", error);
		}
	}

	private getSectionIcon(recency: ChatSessionRecency): string {
		switch (recency) {
			case ChatSessionRecency.Active:
				return "play-circle";
			case ChatSessionRecency.Recent:
				return "clock";
			case ChatSessionRecency.Stale:
				return "folder";
			default:
				return "circle";
		}
	}

	private formatRelativeTime(timestamp: number): string {
		const now = Date.now();
		const diffMs = now - timestamp;
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) {
			return "Just now";
		} else if (diffMins < 60) {
			return `${diffMins}m ago`;
		} else if (diffHours < 24) {
			return `${diffHours}h ago`;
		} else if (diffDays < 7) {
			return `${diffDays}d ago`;
		} else {
			return new Date(timestamp).toLocaleDateString();
		}
	}

	private getPreviewText(item: IChatDetail): string {
		// Try to get the last message from the model if available
		const model = this.chatService.getSession(item.sessionId);
		if (model) {
			const requests = model.getRequests();
			if (requests.length > 0) {
				const lastRequest = requests[requests.length - 1];
				const messageText = lastRequest.message.text || "";
				// Return first line or first 60 characters
				const firstLine = messageText.split("\n")[0];
				return firstLine.length > 60
					? firstLine.substring(0, 60) + "..."
					: firstLine;
			}
		}
		return "";
	}

	private renderHistorySection(
		sectionTitle: string,
		items: IChatDetail[],
		activeSessionId: string | undefined,
		recency: ChatSessionRecency
	): void {
		if (!this._chatHistoryContainer || items.length === 0) {
			return;
		}

		// Create section container
		const section = document.createElement("div");
		section.className = "ren-monitorx-chat-history-section";
		section.setAttribute("data-recency", recency);

		// Get or create collapsed state for this section
		let collapsedState = this._sectionCollapsedStates.get(recency);
		if (!collapsedState) {
			const storedState =
				this.workspaceStore.getBoolean(
					`monitorx.chatSectionCollapsed.${recency}`,
					false
				) ?? false;
			collapsedState = observableValue(this, storedState);
			this._sectionCollapsedStates.set(recency, collapsedState);

			// Persist state changes
			this._register(
				autorun((reader) => {
					const collapsed = collapsedState!.read(reader);
					this.workspaceStore.setBoolean(
						`monitorx.chatSectionCollapsed.${recency}`,
						collapsed
					);
				})
			);
		}

		// Create section header with icon, title, badge, and collapse button
		const header = document.createElement("div");
		header.className = "ren-monitorx-chat-history-section-header";

		// Collapse/expand button
		const collapseButton = document.createElement("button");
		collapseButton.className = "ren-monitorx-chat-history-section-collapse";
		collapseButton.setAttribute("aria-label", `Toggle ${sectionTitle} section`);
		collapseButton.setAttribute("aria-expanded", "true");

		const collapseIcon = document.createElement("span");
		collapseIcon.className = "codicon codicon-chevron-down";
		collapseButton.appendChild(collapseIcon);

		// Update icon based on state
		this._register(
			autorun((reader) => {
				const collapsed = collapsedState!.read(reader);
				collapseIcon.className = collapsed
					? "codicon codicon-chevron-right"
					: "codicon codicon-chevron-down";
				collapseButton.setAttribute("aria-expanded", (!collapsed).toString());
			})
		);

		collapseButton.addEventListener("click", (e) => {
			e.stopPropagation();
			const current = collapsedState!.get();
			collapsedState!.set(!current, undefined);
		});

		header.appendChild(collapseButton);

		// Add icon
		const icon = document.createElement("span");
		icon.className = `codicon codicon-${this.getSectionIcon(recency)}`;
		icon.setAttribute("aria-hidden", "true");
		header.appendChild(icon);

		// Add title
		const titleSpan = document.createElement("span");
		titleSpan.className = "ren-monitorx-chat-history-section-title";
		titleSpan.textContent = sectionTitle;
		header.appendChild(titleSpan);

		// Add badge with count
		const badge = document.createElement("span");
		badge.className = "ren-monitorx-chat-history-section-badge";
		badge.textContent = items.length.toString();
		badge.setAttribute(
			"aria-label",
			`${items.length} items in ${sectionTitle}`
		);
		header.appendChild(badge);

		section.appendChild(header);

		// Create items container
		const itemsContainer = document.createElement("div");
		itemsContainer.className = "ren-monitorx-chat-history-items";
		itemsContainer.setAttribute("data-recency", recency);

		// Update visibility based on collapsed state
		this._register(
			autorun((reader) => {
				const collapsed = collapsedState!.read(reader);
				itemsContainer.style.display = collapsed ? "none" : "";
				section.classList.toggle("collapsed", collapsed);
			})
		);

		// Create history items
		items.forEach((item: IChatDetail) => {
				const historyItem = document.createElement("div");
				historyItem.className = "ren-monitorx-chat-history-item";
			historyItem.setAttribute("role", "button");
			historyItem.setAttribute("tabindex", "0");
			historyItem.setAttribute(
				"aria-label",
				`${item.title || "Untitled Chat"}, ${this.formatRelativeTime(
					item.lastMessageDate
				)}`
			);
				if (item.sessionId === activeSessionId) {
					historyItem.classList.add("active");
				}

			// Get status indicator
			const model = this.chatService.getSession(item.sessionId);
			let statusClass = "";
			let statusIcon = "";
			if (model && model.sessionStatusObs) {
				const status = model.sessionStatusObs.get();
				if (status === ChatSessionStatus.InProgress) {
					statusClass = "status-in-progress";
					statusIcon = "sync";
				} else if (status === ChatSessionStatus.Completed) {
					statusClass = "status-completed";
					statusIcon = "check";
				} else if (status === ChatSessionStatus.Failed) {
					statusClass = "status-failed";
					statusIcon = "error";
				}
			}

			// Item content wrapper
			const contentWrapper = document.createElement("div");
			contentWrapper.className = "ren-monitorx-chat-history-item-content";

			// Title with status indicator
			const titleRow = document.createElement("div");
			titleRow.className = "ren-monitorx-chat-history-item-header";

			if (statusIcon) {
				const statusIndicator = document.createElement("span");
				statusIndicator.className = `codicon codicon-${statusIcon} ren-monitorx-chat-history-status-indicator ${statusClass}`;
				statusIndicator.setAttribute("aria-hidden", "true");
				titleRow.appendChild(statusIndicator);
				}

				const title = document.createElement("div");
				title.className = "ren-monitorx-chat-history-title";
				title.textContent = item.title || "Untitled Chat";
			titleRow.appendChild(title);
			contentWrapper.appendChild(titleRow);

			// Preview text
			const preview = this.getPreviewText(item);
			if (preview) {
				const previewElement = document.createElement("div");
				previewElement.className = "ren-monitorx-chat-history-preview";
				previewElement.textContent = preview;
				contentWrapper.appendChild(previewElement);
			}

			// Metadata row (date and relative time)
			const metadataRow = document.createElement("div");
			metadataRow.className = "ren-monitorx-chat-history-metadata";

			const relativeTime = document.createElement("div");
			relativeTime.className = "ren-monitorx-chat-history-relative-time";
			relativeTime.textContent = this.formatRelativeTime(item.lastMessageDate);
			metadataRow.appendChild(relativeTime);

				const date = document.createElement("div");
				date.className = "ren-monitorx-chat-history-date";
				date.textContent = new Date(item.lastMessageDate).toLocaleDateString();
			metadataRow.appendChild(date);

			contentWrapper.appendChild(metadataRow);
			historyItem.appendChild(contentWrapper);

				// Click to load session
				historyItem.onclick = () => {
					void this.loadChatSession(item.sessionId);
				};

			// Keyboard support
			historyItem.onkeydown = (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					void this.loadChatSession(item.sessionId);
				}
			};

			itemsContainer.appendChild(historyItem);
		});

		section.appendChild(itemsContainer);
		this._chatHistoryContainer.appendChild(section);
	}

	private async loadChatSession(sessionId: string): Promise<void> {
		try {
			await this._chatController?.loadSession(sessionId);
			await this.renderChatHistory();
		} catch (error) {
			console.error("Failed to load chat session:", error);
		}
	}

	private async startNewChat(): Promise<void> {
		try {
			await this._chatController?.startNewSession();
			await this.renderChatHistory();
			this._chatController?.focusInput();
		} catch (error) {
			console.error("Failed to start new chat:", error);
		}
	}

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
		this._chatController = undefined;
		this._chatHistoryContainer = null;
		this._chatHistoryExpanded = undefined;
	}
}
