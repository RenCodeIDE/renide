/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { basename } from "../../../../../base/common/resources.js";
import { URI } from "../../../../../base/common/uri.js";
import { generateUuid } from "../../../../../base/common/uuid.js";
import { ICommandService } from "../../../../../platform/commands/common/commands.js";

export interface ISelectionContext {
	selectedText: string;
	sourceUri: URI | undefined;
	sourcePath: string;
	lineInfo: string;
}

/**
 * A floating button that appears when text is selected in the docs view.
 * Clicking it opens the chat with the selected text as context.
 */
export class SelectionQuestionButton extends Disposable {
	private readonly buttonElement: HTMLElement;
	private isVisible: boolean = false;
	private currentContext: ISelectionContext | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly commandService: ICommandService
	) {
		super();
		console.log("[SelectionQuestionButton] Constructor called");
		console.log("[SelectionQuestionButton] container:", container);
		console.log("[SelectionQuestionButton] commandService:", commandService);

		// Create the floating button
		this.buttonElement = document.createElement("button");
		this.buttonElement.className = "ren-docs-ask-question-btn";
		this.buttonElement.textContent = "Ask in chat";
		this.buttonElement.title = "Ask the AI about the selected text";

		// Style the button
		this.applyButtonStyles();

		// Add click handler
		this.buttonElement.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.handleAskQuestion();
		});

		// Append to document body for fixed positioning
		this.buttonElement.style.display = "none";
		document.body.appendChild(this.buttonElement);

		// Set up selection detection
		this.setupSelectionDetection();
	}

	private applyButtonStyles(): void {
		const btn = this.buttonElement;
		btn.style.position = "fixed";
		btn.style.zIndex = "10000";
		btn.style.padding = "8px 14px";
		btn.style.borderRadius = "6px";
		btn.style.border = "1px solid rgba(255, 255, 255, 0.15)";
		// Solid opaque background - no transparency
		btn.style.backgroundColor = "#0078d4";
		btn.style.color = "#ffffff";
		btn.style.fontSize = "12px";
		btn.style.fontWeight = "600";
		btn.style.cursor = "pointer";
		btn.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
		btn.style.transition = "all 0.15s ease";
		btn.style.whiteSpace = "nowrap";
		btn.style.display = "flex";
		btn.style.alignItems = "center";
		btn.style.gap = "6px";
		btn.style.opacity = "1";
		btn.style.backdropFilter = "none";
		btn.style.letterSpacing = "0.3px";

		// Hover effects
		btn.addEventListener("mouseenter", () => {
			btn.style.backgroundColor = "#1a8cff";
			btn.style.transform = "translateY(-1px)";
			btn.style.boxShadow = "0 6px 16px rgba(0, 120, 212, 0.4)";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.backgroundColor = "#0078d4";
			btn.style.transform = "translateY(0)";
			btn.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
		});
	}

	private setupSelectionDetection(): void {
		console.log("[SelectionQuestionButton] Setting up selection detection");
		// Listen for mouseup to detect selection
		const handleMouseUp = () => {
			// Small delay to let selection finalize
			setTimeout(() => this.checkSelection(), 10);
		};

		// Listen for selection changes (handles keyboard selection too)
		const handleSelectionChange = () => {
			this.checkSelection();
		};

		this.container.addEventListener("mouseup", handleMouseUp);
		document.addEventListener("selectionchange", handleSelectionChange);

		// Click elsewhere to hide
		const handleClickOutside = (e: MouseEvent) => {
			if (!this.buttonElement.contains(e.target as Node)) {
				// Check if there's still a selection in our container
				const selection = window.getSelection();
				if (
					!selection ||
					selection.isCollapsed ||
					!this.isSelectionInContainer(selection)
				) {
					this.hide();
				}
			}
		};
		document.addEventListener("mousedown", handleClickOutside);

		// Hide on scroll to prevent button from appearing in wrong position
		const handleScroll = () => {
			if (this.isVisible) {
				this.hide();
			}
		};
		this.container.addEventListener("scroll", handleScroll);

		// Hide on Escape key
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && this.isVisible) {
				this.hide();
				window.getSelection()?.removeAllRanges();
			}
		};
		document.addEventListener("keydown", handleKeyDown);

		this._register({
			dispose: () => {
				this.container.removeEventListener("mouseup", handleMouseUp);
				document.removeEventListener("selectionchange", handleSelectionChange);
				document.removeEventListener("mousedown", handleClickOutside);
				this.container.removeEventListener("scroll", handleScroll);
				document.removeEventListener("keydown", handleKeyDown);
			},
		});
	}

	private checkSelection(): void {
		console.log("[SelectionQuestionButton] checkSelection called");
		const selection = window.getSelection();
		console.log("[SelectionQuestionButton] Selection:", selection?.toString());

		if (!selection || selection.isCollapsed) {
			this.hide();
			return;
		}

		// Check if selection is within our container
		if (!this.isSelectionInContainer(selection)) {
			this.hide();
			return;
		}

		const selectedText = selection.toString().trim();
		if (selectedText.length < 3) {
			// Require at least 3 characters
			this.hide();
			return;
		}

		// Show the button near the selection
		this.showNearSelection(selection, selectedText);
	}

	private isSelectionInContainer(selection: Selection): boolean {
		if (!selection.anchorNode || !selection.focusNode) {
			return false;
		}

		const anchorInContainer = this.container.contains(selection.anchorNode);
		const focusInContainer = this.container.contains(selection.focusNode);

		return anchorInContainer && focusInContainer;
	}

	private showNearSelection(selection: Selection, selectedText: string): void {
		const range = selection.getRangeAt(0);
		const rect = range.getBoundingClientRect();

		// Calculate position relative to viewport (fixed positioning)
		// Position above the selection, centered horizontally
		const buttonWidth = 100; // Approximate button width
		let left = rect.left + rect.width / 2 - buttonWidth / 2;
		let top = rect.top - 40; // 40px above selection

		// Keep button within viewport bounds
		const viewportWidth = window.innerWidth;
		left = Math.max(10, Math.min(left, viewportWidth - buttonWidth - 10));

		// If button would be above the viewport, show below selection instead
		if (top < 10) {
			top = rect.bottom + 10;
		}

		// Get context info (line estimation from DOM structure)
		const lineInfo = this.estimateLineInfo(selection);

		// Store context for when button is clicked
		this.currentContext = {
			selectedText,
			sourceUri: undefined, // Will be set by DocsViewPane
			sourcePath: "",
			lineInfo,
		};

		// Position and show
		this.buttonElement.style.left = `${left}px`;
		this.buttonElement.style.top = `${top}px`;
		this.buttonElement.style.display = "flex";
		this.isVisible = true;
	}

	private estimateLineInfo(selection: Selection): string {
		// Try to determine context from the DOM structure
		// Look for heading ancestors or nearby headings
		const anchorNode = selection.anchorNode;
		if (!anchorNode) {
			return "";
		}

		let element: Element | null =
			anchorNode.nodeType === Node.ELEMENT_NODE
				? (anchorNode as Element)
				: anchorNode.parentElement;

		// Look for the nearest heading
		let sectionTitle = "";
		while (element && element !== this.container) {
			// Check for headings
			const heading = element.querySelector("h1, h2, h3, h4, h5, h6");
			if (heading) {
				sectionTitle = heading.textContent?.trim() || "";
				break;
			}
			// Check if element itself is a heading
			if (/^H[1-6]$/.test(element.tagName)) {
				sectionTitle = element.textContent?.trim() || "";
				break;
			}
			// Look for previous sibling headings
			let sibling = element.previousElementSibling;
			while (sibling) {
				if (/^H[1-6]$/.test(sibling.tagName)) {
					sectionTitle = sibling.textContent?.trim() || "";
					break;
				}
				sibling = sibling.previousElementSibling;
			}
			if (sectionTitle) break;

			element = element.parentElement;
		}

		return sectionTitle ? `Section: "${sectionTitle}"` : "";
	}

	private hide(): void {
		if (this.isVisible) {
			this.buttonElement.style.display = "none";
			this.isVisible = false;
			this.currentContext = undefined;
		}
	}

	/**
	 * Set the source document context (called by DocsViewPane)
	 */
	public setSourceContext(uri: URI | undefined, sourcePath: string): void {
		if (this.currentContext) {
			this.currentContext.sourceUri = uri;
			this.currentContext.sourcePath = sourcePath;
		}
	}

	/**
	 * Update source context for future selections
	 */
	private _sourcePath: string = "";

	public updateSourceInfo(_uri: URI | undefined, sourcePath: string): void {
		// URI stored for potential future use (e.g., file attachments)
		this._sourcePath = sourcePath;
	}

	private async handleAskQuestion(): Promise<void> {
		if (!this.currentContext) {
			return;
		}

		const { selectedText, lineInfo } = this.currentContext;
		const sourcePath = this.currentContext.sourcePath || this._sourcePath;

		try {
			// Create a generic attachment context
			const attachmentContext = {
				id: generateUuid(),
				kind: "generic",
				name: `Selected from docs: ${basename(URI.file(sourcePath))}`,
				fullName: `Documentation context from ${sourcePath}${
					lineInfo ? ` (${lineInfo})` : ""
				}`,
				value: selectedText,
			};

			// Use command to open chat with attachment
			await this.commandService.executeCommand("workbench.action.chat.open", {
				query: "", // Clean query
				isPartialQuery: true,
				attachContext: [attachmentContext],
			});
		} catch (error) {
			console.error("[SelectionQuestionButton] Failed to open chat:", error);
		}

		// Hide the button after action
		this.hide();
	}

	override dispose(): void {
		if (this.buttonElement.parentNode) {
			this.buttonElement.remove();
		}
		super.dispose();
	}
}
