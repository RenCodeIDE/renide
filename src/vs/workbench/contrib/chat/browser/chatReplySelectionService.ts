/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from "../../../../base/browser/dom.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";

export interface ISelectionInfo {
	messageId: string;
	messageType: "request" | "response";
	selectedText: string;
	range: globalThis.Range;
	domNode: HTMLElement;
}

export class ChatReplySelectionService extends Disposable {
	private readonly _onDidChangeSelection = this._register(
		new Emitter<ISelectionInfo | undefined>()
	);
	readonly onDidChangeSelection: Event<ISelectionInfo | undefined> =
		this._onDidChangeSelection.event;

	private currentSelection: ISelectionInfo | undefined;
	private container: HTMLElement | undefined;
	private selectionChangeListener: (() => void) | undefined;

	attach(container: HTMLElement): void {
		if (this.container === container) {
			return;
		}

		this.detach();

		this.container = container;

		// Listen to mouseup events to detect selection
		this._register(
			dom.addStandardDisposableListener(
				container,
				dom.EventType.MOUSE_UP,
				() => {
					// Delay to allow selection to be set
					setTimeout(() => this.handleSelectionChange(), 10);
				}
			)
		);

		// Listen to selectionchange events
		const handleSelectionChange = () => this.handleSelectionChange();
		dom
			.getWindow(container)
			.document.addEventListener("selectionchange", handleSelectionChange);
		this.selectionChangeListener = () => {
			dom
				.getWindow(container)
				.document.removeEventListener("selectionchange", handleSelectionChange);
		};
	}

	detach(): void {
		if (this.selectionChangeListener) {
			this.selectionChangeListener();
			this.selectionChangeListener = undefined;
		}
		this.container = undefined;
		this.clearSelection();
	}

	private handleSelectionChange(): void {
		if (!this.container) {
			return;
		}

		const window = dom.getWindow(this.container);
		const selection = window.getSelection();

		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			this.clearSelection();
			return;
		}

		const range = selection.getRangeAt(0);
		const selectedText = selection.toString().trim();

		if (!selectedText || selectedText.length === 0) {
			this.clearSelection();
			return;
		}

		// Find the chat message container that contains this selection
		let containerElement: HTMLElement | null =
			range.commonAncestorContainer as HTMLElement;
		if (containerElement.nodeType !== Node.ELEMENT_NODE) {
			containerElement = containerElement.parentElement;
		}

		// Walk up the DOM tree to find the chat message container
		while (containerElement && containerElement !== this.container) {
			if (containerElement.classList.contains("interactive-item-container")) {
				// Found a chat message container
				const messageId = this.getMessageId(containerElement);
				const messageType = this.getMessageType(containerElement);

				if (messageId && messageType) {
					// Check if selection is in a code block (optional - we allow it for now)
					const _isInCodeBlock = this.isSelectionInCodeBlock(range);
					void _isInCodeBlock; // Suppress unused variable warning - kept for future use

					const selectionInfo: ISelectionInfo = {
						messageId,
						messageType,
						selectedText,
						range: range.cloneRange(),
						domNode: containerElement,
					};

					// Only update if selection actually changed
					if (
						!this.currentSelection ||
						this.currentSelection.messageId !== selectionInfo.messageId ||
						this.currentSelection.selectedText !== selectionInfo.selectedText
					) {
						this.currentSelection = selectionInfo;
						this._onDidChangeSelection.fire(selectionInfo);
					}
					return;
				}
			}
			containerElement = containerElement.parentElement;
		}

		// Selection is not within a chat message
		this.clearSelection();
	}

	private getMessageId(element: HTMLElement): string | undefined {
		// Look for the data-chat-message-id attribute set by the renderer
		let current: HTMLElement | null = element;
		while (current && current !== this.container) {
			const messageId = current.getAttribute("data-chat-message-id");
			if (messageId) {
				return messageId;
			}
			current = current.parentElement;
		}

		return undefined;
	}

	private getMessageType(
		element: HTMLElement
	): "request" | "response" | undefined {
		if (element.classList.contains("interactive-request")) {
			return "request";
		}
		if (element.classList.contains("interactive-response")) {
			return "response";
		}
		return undefined;
	}

	private isSelectionInCodeBlock(range: Range): boolean {
		let node: Node | null = range.startContainer;
		while (node) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const element = node as HTMLElement;
				if (
					element.classList.contains("code-block") ||
					element.classList.contains("monaco-editor") ||
					element.closest(".code-block") ||
					element.closest(".monaco-editor")
				) {
					return true;
				}
			}
			node = node.parentNode;
		}
		return false;
	}

	clearSelection(): void {
		if (this.currentSelection) {
			this.currentSelection = undefined;
			this._onDidChangeSelection.fire(undefined);
		}
	}

	getCurrentSelection(): ISelectionInfo | undefined {
		return this.currentSelection;
	}

	override dispose(): void {
		this.detach();
		super.dispose();
	}
}
