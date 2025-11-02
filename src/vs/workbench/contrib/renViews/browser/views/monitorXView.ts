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
import { observableValue, autorun, ISettableObservable } from "../../../../../base/common/observable.js";
import { ButtonWithIcon } from "../../../../../base/browser/ui/button/button.js";
import { Codicon } from "../../../../../base/common/codicons.js";
import { $ } from "../../../../../base/browser/dom.js";

export class MonitorXView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;
	private _chatController: MonitorXChatController | undefined;
	private _chatHistoryContainer: HTMLElement | null = null;
	private _chatHistoryExpanded: ISettableObservable<boolean> | undefined;

	constructor(
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IChatService private readonly chatService: IChatService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService,
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
		const toggleButtonEl = $('.ren-monitorx-chat-sidebar-toggle');
		const toggleButton = this._register(new ButtonWithIcon(toggleButtonEl, {}));
		toggleButton.label = 'Chat History';
		sidebarHeader.appendChild(toggleButtonEl);

		// Sidebar content (history list)
		const sidebarContent = document.createElement("div");
		sidebarContent.className = "ren-monitorx-chat-sidebar-content";
		this._chatHistoryContainer = sidebarContent;

		sidebar.appendChild(sidebarHeader);
		sidebar.appendChild(sidebarContent);

		// Initialize sidebar state from workspace storage
		const storedState = this.workspaceStore.getBoolean('monitorx.chatHistoryExpanded', true) ?? true;
		this._chatHistoryExpanded = observableValue(this, storedState);

		// Persist state changes to workspace storage
		this._register(autorun(reader => {
			const expanded = this._chatHistoryExpanded!.read(reader);
			this.workspaceStore.setBoolean('monitorx.chatHistoryExpanded', expanded);
		}));

		// React to state changes - update UI
		this._register(autorun(reader => {
			const expanded = this._chatHistoryExpanded!.read(reader);
			toggleButton.icon = expanded ? Codicon.chevronLeft : Codicon.chevronRight;
			sidebar.classList.toggle('collapsed', !expanded);
			sidebarContent.style.display = expanded ? '' : 'none';
		}));

		// Toggle button click handler
		this._register(toggleButton.onDidClick(() => {
			const current = this._chatHistoryExpanded!.get();
			this._chatHistoryExpanded!.set(!current, undefined);
		}));

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
				this.markdownRendererService,
			),
		);
		await this._chatController.initialize();
		await this.renderChatHistory();
	}

	private async renderChatHistory(): Promise<void> {
		if (!this._chatHistoryContainer) {
			return;
		}

		// Clear existing history
		this._chatHistoryContainer.textContent = "";

		try {
			// Get chat history
			const history = await this.chatService.getHistory();

			// Sort by last message date, most recent first
			const sortedHistory = history.sort(
				(a: IChatDetail, b: IChatDetail) =>
					b.lastMessageDate - a.lastMessageDate,
			);

			// Limit to 10 most recent
			const recentHistory = sortedHistory.slice(0, 10);

			if (recentHistory.length === 0) {
				const emptyMessage = document.createElement("div");
				emptyMessage.textContent = "No past conversations";
				emptyMessage.className = "ren-monitorx-chat-history-empty";
				this._chatHistoryContainer.appendChild(emptyMessage);
				return;
			}

			const activeSessionId = this._chatController?.sessionId;

			// Create history list
			recentHistory.forEach((item: IChatDetail) => {
				const historyItem = document.createElement("div");
				historyItem.className = "ren-monitorx-chat-history-item";
				if (item.sessionId === activeSessionId) {
					historyItem.classList.add("active");
				}

				const title = document.createElement("div");
				title.className = "ren-monitorx-chat-history-title";
				title.textContent = item.title || "Untitled Chat";

				const date = document.createElement("div");
				date.className = "ren-monitorx-chat-history-date";
				date.textContent = new Date(item.lastMessageDate).toLocaleDateString();

				historyItem.appendChild(title);
				historyItem.appendChild(date);

				// Click to load session
				historyItem.onclick = () => {
					void this.loadChatSession(item.sessionId);
				};

				this._chatHistoryContainer!.appendChild(historyItem);
			});
		} catch (error) {
			console.error("Failed to render chat history:", error);
		}
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
