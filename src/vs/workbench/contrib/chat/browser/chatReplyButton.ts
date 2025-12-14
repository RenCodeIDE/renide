/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { localize } from "../../../../nls.js";
import { ISelectionInfo } from "./chatReplySelectionService.js";

const $ = dom.$;

export class ChatReplyButton extends Disposable {
	private button: Button | undefined;
	private buttonContainer: HTMLElement | undefined;
	private currentSelection: ISelectionInfo | undefined;

	private readonly _onDidClick = this._register(new Emitter<ISelectionInfo>());
	readonly onDidClick: Event<ISelectionInfo> = this._onDidClick.event;

	constructor(private readonly rootContainer: HTMLElement) {
		super();
		this.createButton();
	}

	private createButton(): void {
		this.buttonContainer = $(".chat-reply-button-container");
		this.buttonContainer.style.position = "absolute";
		this.buttonContainer.style.zIndex = "10000";
		this.buttonContainer.style.display = "none";
		this.buttonContainer.style.pointerEvents = "auto";

		this.button = this._register(
			new Button(this.buttonContainer, {
				title: localize("chat.replyButton", "Reply to selection"),
				secondary: true,
			})
		);

		this.button.label = localize("chat.reply", "Reply");
		this.button.icon = Codicon.comment;
		this.button.element.classList.add("chat-reply-button");

		this._register(
			this.button.onDidClick(() => {
				if (this.currentSelection) {
					this._onDidClick.fire(this.currentSelection);
				}
			})
		);

		this.rootContainer.appendChild(this.buttonContainer);
	}

	show(selection: ISelectionInfo): void {
		if (!this.buttonContainer || !this.button) {
			return;
		}

		this.currentSelection = selection;

		// Calculate position based on selection range
		const range = selection.range;
		const rect = range.getBoundingClientRect();
		const containerRect = this.rootContainer.getBoundingClientRect();

		// Position button below the selection, or above if there's not enough space
		const buttonHeight = 32; // Approximate button height
		const spacing = 8;
		let top = rect.bottom - containerRect.top + spacing;
		let left = rect.left - containerRect.left;

		// If button would go off bottom of container, position it above selection
		if (top + buttonHeight > this.rootContainer.clientHeight) {
			top = rect.top - containerRect.top - buttonHeight - spacing;
		}

		// Ensure button doesn't go off left edge
		if (left < 0) {
			left = 8;
		}

		// Ensure button doesn't go off right edge
		const buttonWidth = 100; // Approximate button width
		if (left + buttonWidth > this.rootContainer.clientWidth) {
			left = this.rootContainer.clientWidth - buttonWidth - 8;
		}

		this.buttonContainer.style.top = `${top}px`;
		this.buttonContainer.style.left = `${left}px`;
		this.buttonContainer.style.display = "block";

		// Add fade-in animation
		this.buttonContainer.style.opacity = "0";
		setTimeout(() => {
			if (this.buttonContainer) {
				this.buttonContainer.style.transition = "opacity 0.15s ease-in";
				this.buttonContainer.style.opacity = "1";
			}
		}, 10);
	}

	hide(): void {
		if (!this.buttonContainer) {
			return;
		}

		this.currentSelection = undefined;

		// Fade out animation
		if (this.buttonContainer.style.opacity !== "0") {
			this.buttonContainer.style.transition = "opacity 0.15s ease-out";
			this.buttonContainer.style.opacity = "0";
			setTimeout(() => {
				if (this.buttonContainer) {
					this.buttonContainer.style.display = "none";
				}
			}, 150);
		} else {
			this.buttonContainer.style.display = "none";
		}
	}

	updatePosition(): void {
		if (this.currentSelection && this.buttonContainer) {
			this.show(this.currentSelection);
		}
	}

	override dispose(): void {
		if (this.buttonContainer && this.buttonContainer.parentNode) {
			this.buttonContainer.parentNode.removeChild(this.buttonContainer);
		}
		super.dispose();
	}
}
