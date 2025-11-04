/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import {
	Disposable,
	DisposableStore,
	IDisposable,
	toDisposable,
} from "../../../../../base/common/lifecycle.js";
import { MarkdownString } from "../../../../../base/common/htmlContent.js";
import { clearNode } from "../../../../../base/browser/dom.js";
import { ChatAgentLocation } from "../../../chat/common/constants.js";
import { IChatService } from "../../../chat/common/chatService.js";
import {
	IChatModel,
	IChatRequestModel,
	IChatResponseModel,
	IChatChangeEvent,
} from "../../../chat/common/chatModel.js";
import { IMarkdownRendererService } from "../../../../../platform/markdown/browser/markdownRenderer.js";
import { IRenderedMarkdown } from "../../../../../base/browser/markdownRenderer.js";

interface IMonitorXChatMessageDom {
	readonly root: HTMLElement;
	readonly userBubble: HTMLElement;
	readonly assistantBubble: HTMLElement;
	readonly pendingElement: HTMLElement;
	responseListener?: IDisposable;
	responseMarkdown?: IRenderedMarkdown;
}

export class MonitorXChatController extends Disposable {
	private _model: IChatModel | undefined;
	private readonly modelDisposables = this._register(new DisposableStore());
	private readonly messageItems = new Map<string, IMonitorXChatMessageDom>();

	private readonly conversationContainer: HTMLElement;
	private readonly emptyState: HTMLElement;
	private readonly statusMessage: HTMLElement;
	private readonly inputArea: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly composer: HTMLElement;

	private _isSending = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly chatService: IChatService,
		private readonly markdownRenderer: IMarkdownRendererService
	) {
		super();
		this.container.classList.add("ren-monitorx-chat-panel");

		this.conversationContainer = document.createElement("div");
		this.conversationContainer.className = "ren-monitorx-chat-messages";
		this.container.appendChild(this.conversationContainer);

		this.emptyState = document.createElement("div");
		this.emptyState.className = "ren-monitorx-chat-empty-state";
		this.emptyState.textContent =
			"Start a new conversation to get help from the AI assistant.";
		this.conversationContainer.appendChild(this.emptyState);

		this.statusMessage = document.createElement("div");
		this.statusMessage.className = "ren-monitorx-chat-status";
		this.statusMessage.classList.add("hidden");
		this.container.appendChild(this.statusMessage);

		this.composer = document.createElement("div");
		this.composer.className = "ren-monitorx-chat-composer";
		this.container.appendChild(this.composer);

		this.inputArea = document.createElement("textarea");
		this.inputArea.className = "ren-monitorx-chat-input";
		this.inputArea.rows = 2;
		this.inputArea.placeholder = "Ask MonitorX Assistant";
		this.inputArea.setAttribute("aria-label", "Chat input");
		this.composer.appendChild(this.inputArea);

		const composerFooter = document.createElement("div");
		composerFooter.className = "ren-monitorx-chat-composer-footer";
		this.composer.appendChild(composerFooter);

		const footerLeft = document.createElement("div");
		footerLeft.className = "ren-monitorx-chat-composer-footer-left";

		const hint = document.createElement("span");
		hint.className = "ren-monitorx-chat-hint";
		hint.textContent = "Press Enter to send, Shift+Enter for newline";
		footerLeft.appendChild(hint);

		const characterCount = document.createElement("div");
		characterCount.className = "ren-monitorx-chat-character-count";
		characterCount.textContent = "0";
		characterCount.setAttribute("aria-live", "polite");
		footerLeft.appendChild(characterCount);

		composerFooter.appendChild(footerLeft);

		this.sendButton = document.createElement("button");
		this.sendButton.type = "button";
		this.sendButton.className = "ren-monitorx-chat-send-button";
		this.sendButton.setAttribute("aria-label", "Send message");
		
		const sendIcon = document.createElement("span");
		sendIcon.className = "codicon codicon-send";
		this.sendButton.appendChild(sendIcon);
		
		const sendText = document.createTextNode(" Send");
		this.sendButton.appendChild(sendText);
		
		composerFooter.appendChild(this.sendButton);

		const onSendClick = () => this.handleSend();
		this.sendButton.addEventListener("click", onSendClick);
		this._register(
			toDisposable(() =>
				this.sendButton.removeEventListener("click", onSendClick)
			)
		);

		const onInputKeyDown = (event: KeyboardEvent) => this.onInputKeyDown(event);
		this.inputArea.addEventListener("keydown", onInputKeyDown);
		this._register(
			toDisposable(() =>
				this.inputArea.removeEventListener("keydown", onInputKeyDown)
			)
		);

		const onInputChange = () => {
			this.updateComposerState();
			this.updateCharacterCount();
			this.autoResizeTextarea();
		};
		this.inputArea.addEventListener("input", onInputChange);
		this._register(
			toDisposable(() =>
				this.inputArea.removeEventListener("input", onInputChange)
			)
		);

		this.updateComposerState();
	}

	get sessionId(): string | undefined {
		return this._model?.sessionId;
	}

	async initialize(): Promise<void> {
		if (!this._model) {
			const model = this.chatService.startSession(
				ChatAgentLocation.Chat,
				CancellationToken.None
			);
			this.setModel(model);
		}
		this.renderFromModel();
	}

	async startNewSession(): Promise<void> {
		const model = this.chatService.startSession(
			ChatAgentLocation.Chat,
			CancellationToken.None
		);
		this.setModel(model);
		this.clearComposer();
	}

	async loadSession(sessionId: string): Promise<void> {
		const model = await this.chatService.getOrRestoreSession(sessionId);
		if (!model) {
			this.showStatus(
				"Unable to load that conversation. It may have been removed."
			);
			return;
		}
		this.setModel(model);
		this.clearComposer();
	}

	focusInput(): void {
		this.inputArea.focus();
	}

	private setModel(model: IChatModel): void {
		if (this._model === model) {
			return;
		}
		this.modelDisposables.clear();
		this._model = model;
		this.modelDisposables.add(
			model.onDidDispose(() => {
				if (this._model === model) {
					this._model = undefined;
					this.modelDisposables.clear();
					this.clearMessages();
					this.updateEmptyState();
				}
			})
		);
		this.modelDisposables.add(
			model.onDidChange((event) => this.onModelChange(event))
		);
		this.renderFromModel();
	}

	private renderFromModel(): void {
		this.clearMessages();
		const requests = this._model?.getRequests() ?? [];
		for (const request of requests) {
			const item = this.ensureMessageItem(request);
			if (request.response) {
				this.attachResponse(item, request.response);
			}
		}
		this.updateEmptyState();
		this.scrollToBottom();
	}

	private onModelChange(event: IChatChangeEvent): void {
		switch (event.kind) {
			case "addRequest": {
				this.ensureMessageItem(event.request);
				this.updateEmptyState();
				this.scrollToBottom();
				break;
			}
			case "changedRequest": {
				const item = this.messageItems.get(event.request.id);
				if (item) {
					item.userBubble.textContent = event.request.message.text;
				}
				break;
			}
			case "removeRequest": {
				this.removeMessageItem(event.requestId);
				this.updateEmptyState();
				break;
			}
			case "addResponse": {
				const item = this.messageItems.get(event.response.requestId);
				if (item) {
					this.attachResponse(item, event.response);
					this.scrollToBottom();
				}
				break;
			}
			case "completedRequest": {
				const response = event.request.response;
				if (response) {
					const item = this.messageItems.get(event.request.id);
					if (item) {
						this.attachResponse(item, response);
						this.scrollToBottom();
					}
				}
				break;
			}
		}
	}

	private ensureMessageItem(
		request: IChatRequestModel
	): IMonitorXChatMessageDom {
		let entry = this.messageItems.get(request.id);
		if (entry) {
			entry.userBubble.textContent = request.message.text;
			return entry;
		}

		const root = document.createElement("div");
		root.className = "ren-monitorx-chat-message";

		const userRow = document.createElement("div");
		userRow.className = "ren-monitorx-chat-message-row user";

		const userLabel = document.createElement("span");
		userLabel.className = "ren-monitorx-chat-label";
		userLabel.textContent = request.username || "You";
		userRow.appendChild(userLabel);

		const userBubble = document.createElement("div");
		userBubble.className = "ren-monitorx-chat-bubble user";
		userBubble.textContent = request.message.text;
		userRow.appendChild(userBubble);

		root.appendChild(userRow);

		const assistantRow = document.createElement("div");
		assistantRow.className = "ren-monitorx-chat-message-row assistant";

		const assistantLabel = document.createElement("span");
		assistantLabel.className = "ren-monitorx-chat-label";
		assistantLabel.textContent = "Assistant";
		assistantRow.appendChild(assistantLabel);

		const assistantBubble = document.createElement("div");
		assistantBubble.className = "ren-monitorx-chat-bubble assistant";
		assistantRow.appendChild(assistantBubble);

		const pending = document.createElement("div");
		pending.className = "ren-monitorx-chat-pending";
		pending.textContent = "Waiting for response…";
		assistantBubble.appendChild(pending);

		root.appendChild(assistantRow);

		this.conversationContainer.appendChild(root);

		entry = { root, userBubble, assistantBubble, pendingElement: pending };
		this.messageItems.set(request.id, entry);
		return entry;
	}

	private attachResponse(
		entry: IMonitorXChatMessageDom,
		response: IChatResponseModel
	): void {
		entry.responseListener?.dispose();
		entry.responseMarkdown?.dispose();

		const render = () => {
			entry.responseMarkdown?.dispose();
			clearNode(entry.assistantBubble);

			const markdown = response.response.getMarkdown();
			if (!markdown) {
				entry.assistantBubble.appendChild(entry.pendingElement);
				return;
			}

			const rendered = this.markdownRenderer.render(
				new MarkdownString(markdown, {
					supportThemeIcons: true,
					isTrusted: true,
				}),
				{
					fillInIncompleteTokens: true,
				}
			);
			entry.responseMarkdown = rendered;
			entry.assistantBubble.appendChild(rendered.element);
		};

		render();
		entry.responseListener = response.onDidChange(() => render());
		this._register(entry.responseListener);
	}

	private removeMessageItem(requestId: string): void {
		const entry = this.messageItems.get(requestId);
		if (!entry) {
			return;
		}
		entry.responseListener?.dispose();
		entry.responseMarkdown?.dispose();
		entry.root.remove();
		this.messageItems.delete(requestId);
	}

	private clearMessages(): void {
		for (const entry of this.messageItems.values()) {
			entry.responseListener?.dispose();
			entry.responseMarkdown?.dispose();
		}
		this.messageItems.clear();
		clearNode(this.conversationContainer);
		this.conversationContainer.appendChild(this.emptyState);
	}

	private updateEmptyState(): void {
		const hasMessages = this.messageItems.size > 0;
		this.emptyState.classList.toggle("hidden", hasMessages);
	}

	private scrollToBottom(): void {
		queueMicrotask(() => {
			this.conversationContainer.scrollTop =
				this.conversationContainer.scrollHeight;
		});
	}

	private async handleSend(): Promise<void> {
		const message = this.inputArea.value.trim();
		if (!message || this._isSending) {
			return;
		}

		if (!this._model) {
			await this.initialize();
		}

		if (!this._model) {
			this.showStatus("Unable to start chat session. Try again later.");
			return;
		}

		this._isSending = true;
		this.updateComposerState();
		this.showStatus("");

		try {
			await this.chatService.sendRequest(this._model.sessionId, message, {
				location: ChatAgentLocation.Chat,
			});
			this.inputArea.value = "";
		} catch (error) {
			console.error("MonitorX chat send failed", error);
			this.showStatus(
				"Sending message failed. Check your connection and try again."
			);
		} finally {
			this._isSending = false;
			this.updateComposerState();
		}
	}

	private onInputKeyDown(event: KeyboardEvent): void {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.handleSend();
		}
	}

	private updateComposerState(): void {
		const trimmed = this.inputArea.value.trim();
		this.sendButton.disabled = this._isSending || trimmed.length === 0;
		this.inputArea.classList.toggle("sending", this._isSending);
	}

	private updateCharacterCount(): void {
		const count = this.inputArea.value.length;
		const characterCount = this.composer.querySelector(
			".ren-monitorx-chat-character-count"
		);
		if (characterCount) {
			characterCount.textContent = count.toString();
			characterCount.classList.toggle(
				"ren-monitorx-chat-character-count-warning",
				count > 2000
			);
		}
	}

	private autoResizeTextarea(): void {
		this.inputArea.style.height = "auto";
		const newHeight = Math.min(this.inputArea.scrollHeight, 200); // Max 200px
		this.inputArea.style.height = `${newHeight}px`;
		this.inputArea.style.overflowY =
			this.inputArea.scrollHeight > 200 ? "auto" : "hidden";
	}

	private clearComposer(): void {
		this.inputArea.value = "";
		this._isSending = false;
		this.updateComposerState();
		this.showStatus("");
	}

	private showStatus(message: string): void {
		this.statusMessage.textContent = message;
		this.statusMessage.classList.toggle("hidden", !message);
	}
}
