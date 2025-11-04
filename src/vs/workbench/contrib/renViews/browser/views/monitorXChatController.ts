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
	readonly userRow: HTMLElement;
	readonly assistantRow: HTMLElement;
	readonly userTimestamp?: HTMLElement;
	readonly assistantTimestamp?: HTMLElement;
	readonly userCopyButton?: HTMLElement;
	assistantCopyButton?: HTMLElement; // Not readonly - we update it when response arrives
	readonly typingIndicator?: HTMLElement;
	responseListener?: IDisposable;
	responseMarkdown?: IRenderedMarkdown;
	readonly request: IChatRequestModel;
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
	private readonly suggestedPromptsContainer: HTMLElement;

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

		// Suggested prompts container
		this.suggestedPromptsContainer = document.createElement("div");
		this.suggestedPromptsContainer.className = "ren-monitorx-chat-suggested-prompts";
		this.composer.appendChild(this.suggestedPromptsContainer);

		this.renderSuggestedPrompts();

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
			this.updateSuggestedPromptsVisibility();
		};
		this.inputArea.addEventListener("input", onInputChange);
		this._register(
			toDisposable(() =>
				this.inputArea.removeEventListener("input", onInputChange)
			)
		);

		const onInputFocus = () => {
			this.updateSuggestedPromptsVisibility();
		};
		this.inputArea.addEventListener("focus", onInputFocus);
		this._register(
			toDisposable(() =>
				this.inputArea.removeEventListener("focus", onInputFocus)
			)
		);

		const onInputBlur = () => {
			// Delay hiding to allow clicking on prompts
			setTimeout(() => {
				this.updateSuggestedPromptsVisibility();
			}, 200);
		};
		this.inputArea.addEventListener("blur", onInputBlur);
		this._register(
			toDisposable(() =>
				this.inputArea.removeEventListener("blur", onInputBlur)
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

	isInputFocused(): boolean {
		return document.activeElement === this.inputArea;
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
				const item = this.ensureMessageItem(event.request);
				// Show typing indicator immediately when request is added
				if (item.typingIndicator) {
					item.typingIndicator.style.display = "";
				}
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

	private formatMessageTimestamp(timestamp: number): string {
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
			return new Date(timestamp).toLocaleString();
		}
	}

	private async copyToClipboard(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
			return false;
		}
	}

	private createCopyButton(
		text: string,
		onCopy: () => void
	): HTMLElement {
		const copyButton = document.createElement("button");
		copyButton.className = "ren-monitorx-chat-message-copy";
		copyButton.setAttribute("aria-label", "Copy message");
		copyButton.setAttribute("title", "Copy message");

		const copyIcon = document.createElement("span");
		copyIcon.className = "codicon codicon-copy";
		copyButton.appendChild(copyIcon);

		copyButton.addEventListener("click", async (e) => {
			e.stopPropagation();
			const success = await this.copyToClipboard(text);
			if (success) {
				// Visual feedback: change icon to checkmark
				copyIcon.className = "codicon codicon-check";
				copyButton.setAttribute("aria-label", "Copied!");
				setTimeout(() => {
					copyIcon.className = "codicon codicon-copy";
					copyButton.setAttribute("aria-label", "Copy message");
				}, 2000);
			}
			onCopy();
		});

		return copyButton;
	}

	private ensureMessageItem(
		request: IChatRequestModel
	): IMonitorXChatMessageDom {
		let entry = this.messageItems.get(request.id);
		if (entry) {
			entry.userBubble.textContent = request.message.text;
			// Update timestamp if it exists
			if (entry.userTimestamp) {
				entry.userTimestamp.textContent = this.formatMessageTimestamp(
					request.timestamp
				);
			}
			return entry;
		}

		const root = document.createElement("div");
		root.className = "ren-monitorx-chat-message";

		// User message row
		const userRow = document.createElement("div");
		userRow.className = "ren-monitorx-chat-message-row user";

		const userLabel = document.createElement("span");
		userLabel.className = "ren-monitorx-chat-label";
		userLabel.textContent = request.username || "You";
		userRow.appendChild(userLabel);

		// User bubble container (for hover effects)
		const userBubbleContainer = document.createElement("div");
		userBubbleContainer.className = "ren-monitorx-chat-bubble-container";

		const userBubble = document.createElement("div");
		userBubble.className = "ren-monitorx-chat-bubble user";
		userBubble.textContent = request.message.text;

		// Copy button for user message
		const userCopyButton = this.createCopyButton(request.message.text, () => {});
		userBubbleContainer.appendChild(userBubble);
		userBubbleContainer.appendChild(userCopyButton);

		userRow.appendChild(userBubbleContainer);

		// User timestamp
		const userTimestamp = document.createElement("div");
		userTimestamp.className = "ren-monitorx-chat-message-timestamp";
		userTimestamp.textContent = this.formatMessageTimestamp(request.timestamp);
		userRow.appendChild(userTimestamp);

		root.appendChild(userRow);

		// Assistant message row
		const assistantRow = document.createElement("div");
		assistantRow.className = "ren-monitorx-chat-message-row assistant";

		const assistantLabel = document.createElement("span");
		assistantLabel.className = "ren-monitorx-chat-label";
		assistantLabel.textContent = "Assistant";
		assistantRow.appendChild(assistantLabel);

		// Assistant bubble container
		const assistantBubbleContainer = document.createElement("div");
		assistantBubbleContainer.className = "ren-monitorx-chat-bubble-container";

		const assistantBubble = document.createElement("div");
		assistantBubble.className = "ren-monitorx-chat-bubble assistant";

		// Typing indicator (shown while waiting for response)
		const typingIndicator = document.createElement("div");
		typingIndicator.className = "ren-monitorx-chat-typing-indicator";
		typingIndicator.setAttribute("aria-label", "AI is thinking");
		const typingDots = document.createElement("span");
		typingDots.className = "ren-monitorx-chat-typing-dots";
		typingDots.textContent = "●";
		typingIndicator.appendChild(typingDots);
		typingIndicator.appendChild(document.createTextNode(" AI is thinking..."));

		const pending = document.createElement("div");
		pending.className = "ren-monitorx-chat-pending";
		pending.appendChild(typingIndicator);

		assistantBubbleContainer.appendChild(assistantBubble);
		assistantBubble.appendChild(pending);

		// Copy button for assistant (will be added when response is ready)
		const assistantCopyButton = document.createElement("button");
		assistantCopyButton.className =
			"ren-monitorx-chat-message-copy ren-monitorx-chat-message-copy-hidden";
		assistantCopyButton.setAttribute("aria-label", "Copy message");
		assistantCopyButton.setAttribute("title", "Copy message");
		const assistantCopyIcon = document.createElement("span");
		assistantCopyIcon.className = "codicon codicon-copy";
		assistantCopyButton.appendChild(assistantCopyIcon);

		assistantBubbleContainer.appendChild(assistantCopyButton);
		assistantRow.appendChild(assistantBubbleContainer);

		// Assistant timestamp (will be updated when response completes)
		const assistantTimestamp = document.createElement("div");
		assistantTimestamp.className = "ren-monitorx-chat-message-timestamp";
		assistantTimestamp.textContent = "";
		assistantRow.appendChild(assistantTimestamp);

		root.appendChild(assistantRow);

		this.conversationContainer.appendChild(root);

		entry = {
			root,
			userBubble,
			assistantBubble,
			pendingElement: pending,
			userRow,
			assistantRow,
			userTimestamp,
			assistantTimestamp,
			userCopyButton,
			assistantCopyButton,
			typingIndicator,
			request,
		};
		this.messageItems.set(request.id, entry);
		return entry;
	}

	private attachResponse(
		entry: IMonitorXChatMessageDom,
		response: IChatResponseModel
	): void {
		entry.responseListener?.dispose();
		entry.responseMarkdown?.dispose();

		// Hide typing indicator when response starts
		if (entry.typingIndicator) {
			entry.typingIndicator.style.display = "none";
		}

		const render = () => {
			entry.responseMarkdown?.dispose();
			clearNode(entry.assistantBubble);

			const markdown = response.response.getMarkdown();
			if (!markdown) {
				// Still waiting for response
				if (entry.typingIndicator) {
					entry.typingIndicator.style.display = "";
				}
				entry.assistantBubble.appendChild(entry.pendingElement);
				// Update copy button to be hidden
				if (entry.assistantCopyButton) {
					entry.assistantCopyButton.classList.add(
						"ren-monitorx-chat-message-copy-hidden"
					);
				}
				return;
			}

			// Response is ready - hide typing indicator
			if (entry.typingIndicator) {
				entry.typingIndicator.style.display = "none";
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

			// Update copy button for assistant response
			if (entry.assistantCopyButton) {
				entry.assistantCopyButton.classList.remove(
					"ren-monitorx-chat-message-copy-hidden"
				);

				// Update copy button handler with actual response text
				// Remove old listeners by cloning
				const newCopyButton = entry.assistantCopyButton.cloneNode(
					true
				) as HTMLElement;
				newCopyButton.className = entry.assistantCopyButton.className;
				newCopyButton.setAttribute("aria-label", "Copy message");
				newCopyButton.setAttribute("title", "Copy message");

				const newCopyIcon = newCopyButton.querySelector(
					".codicon"
				) as HTMLElement;
				if (newCopyIcon) {
					newCopyButton.addEventListener("click", async (e) => {
						e.stopPropagation();
						const success = await this.copyToClipboard(markdown);
						if (success) {
							newCopyIcon.className = "codicon codicon-check";
							newCopyButton.setAttribute("aria-label", "Copied!");
							setTimeout(() => {
								newCopyIcon.className = "codicon codicon-copy";
								newCopyButton.setAttribute("aria-label", "Copy message");
							}, 2000);
						}
					});
				}

				entry.assistantCopyButton.replaceWith(newCopyButton);
				entry.assistantCopyButton = newCopyButton;
			}

			// Update assistant timestamp when response completes
			if (entry.assistantTimestamp && response.isComplete) {
				entry.assistantTimestamp.textContent = this.formatMessageTimestamp(
					Date.now()
				);
			}
		};

		render();
		entry.responseListener = response.onDidChange(() => {
			render();
			// Update typing indicator visibility based on response state
			if (entry.typingIndicator) {
				const isInProgress = !response.isComplete && !response.isCanceled;
				entry.typingIndicator.style.display = isInProgress ? "" : "none";
			}
		});
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

	private readonly suggestedPrompts = [
		"Explain this code",
		"Fix bugs in my code",
		"Generate unit tests",
		"Write documentation",
		"Refactor code",
		"Optimize performance",
		"Add error handling",
		"Review code quality",
	];

	private renderSuggestedPrompts(): void {
		clearNode(this.suggestedPromptsContainer);

		const promptGrid = document.createElement("div");
		promptGrid.className = "ren-monitorx-chat-suggested-prompts-grid";

		for (const prompt of this.suggestedPrompts) {
			const promptButton = document.createElement("button");
			promptButton.className = "ren-monitorx-chat-suggested-prompt";
			promptButton.textContent = prompt;
			promptButton.setAttribute("aria-label", `Use prompt: ${prompt}`);
			promptButton.addEventListener("click", () => {
				this.inputArea.value = prompt;
				this.inputArea.focus();
				this.updateComposerState();
				this.updateCharacterCount();
				this.autoResizeTextarea();
				this.updateSuggestedPromptsVisibility();
			});
			promptGrid.appendChild(promptButton);
		}

		this.suggestedPromptsContainer.appendChild(promptGrid);
		this.updateSuggestedPromptsVisibility();
	}

	private updateSuggestedPromptsVisibility(): void {
		const isEmpty = this.inputArea.value.trim().length === 0;
		const isFocused = document.activeElement === this.inputArea;
		const shouldShow = isEmpty && isFocused;

		this.suggestedPromptsContainer.classList.toggle(
			"ren-monitorx-chat-suggested-prompts-visible",
			shouldShow
		);
	}
}
