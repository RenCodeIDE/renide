/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from "../../../../../../nls.js";
import { Disposable, IDisposable } from "../../../../../../base/common/lifecycle.js";
import {
	ViewPane,
	IViewPaneOptions,
} from "../../../../../browser/parts/views/viewPane.js";
import { IDocsService } from "../../services/docsService.js";
import { IChunkIndexService } from "../../services/chunkIndexService.js";
import { IInstantiationService } from "../../../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../../../platform/keybinding/common/keybinding.js";
import { IContextMenuService } from "../../../../../../platform/contextview/browser/contextView.js";
import { IConfigurationService } from "../../../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../../../platform/contextkey/common/contextkey.js";
import { IViewDescriptorService } from "../../../../../common/views.js";
import { IOpenerService } from "../../../../../../platform/opener/common/opener.js";
import { IThemeService } from "../../../../../../platform/theme/common/themeService.js";
import { IHoverService } from "../../../../../../platform/hover/browser/hover.js";
import { IEditorService } from "../../../../../services/editor/common/editorService.js";
import {
	EditorResourceAccessor,
	SideBySideEditor,
} from "../../../../../common/editor.js";
import { URI } from "../../../../../../base/common/uri.js";
import { ICommandService } from "../../../../../../platform/commands/common/commands.js";
import { IMarkdownRendererService } from "../../../../../../platform/markdown/browser/markdownRenderer.js";
import { MarkdownString } from "../../../../../../base/common/htmlContent.js";

export class DocsViewPane extends ViewPane {
	private chunksListContainer: HTMLElement | undefined;
	private previewContainer: HTMLElement | undefined;
	private selectedChunkId: string | undefined;
    private renderedMarkdownDisposable: IDisposable | undefined;

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
		@IDocsService private readonly docsService: IDocsService,
		@IChunkIndexService private readonly chunkIndexService: IChunkIndexService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService
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

		// Listen to active editor changes
		this._register(
			this.editorService.onDidActiveEditorChange(() => {
				this.updateForActiveFile();
			})
		);

		// Listen to chunk docs updates
		this._register(
			this.docsService.onDidUpdateChunkDocs((chunkDoc) => {
				console.log("[DocsViewPane] Chunk docs updated:", chunkDoc.chunkId);
				// If this is the selected chunk, update preview immediately
				if (this.selectedChunkId === chunkDoc.chunkId) {
					console.log(
						"[DocsViewPane] Selected chunk updated, refreshing preview immediately"
					);
					this.renderChunkPreview(chunkDoc.chunkId);
				}
				// Also refresh the full view
				this.updateForActiveFile();
			})
		);

		// Listen to chunk index changes
		this._register(
			this.chunkIndexService.onDidChange(() => {
				this.updateForActiveFile();
			})
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add("ren-docs-view");

		// Create split layout: chunks list on left, preview on right
		const splitContainer = document.createElement("div");
		splitContainer.className = "ren-docs-view__split";
		splitContainer.style.display = "flex";
		splitContainer.style.height = "100%";
		container.appendChild(splitContainer);

		// Chunks list (left)
		this.chunksListContainer = document.createElement("div");
		this.chunksListContainer.className = "ren-docs-view__chunks-list";
		this.chunksListContainer.style.flex = "0 0 250px";
		this.chunksListContainer.style.borderRight =
			"1px solid var(--vscode-panel-border)";
		this.chunksListContainer.style.overflowY = "auto";
		splitContainer.appendChild(this.chunksListContainer);

		// Preview (right)
		this.previewContainer = document.createElement("div");
		this.previewContainer.className = "ren-docs-view__preview";
		this.previewContainer.style.flex = "1";
		this.previewContainer.style.overflowY = "auto";
		this.previewContainer.style.padding = "16px";
		splitContainer.appendChild(this.previewContainer);

		this.updateForActiveFile();
	}

	private async updateForActiveFile(): Promise<void> {
		const activeEditor = this.editorService.activeEditor;
		const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		});

		if (!uri || uri.scheme !== "file") {
			this.renderEmptyState();
			return;
		}

		await this.renderChunksForFile(uri);
	}

	private async renderChunksForFile(uri: URI): Promise<void> {
		if (!this.chunksListContainer || !this.previewContainer) {
			return;
		}

		// Clear existing content
		this.chunksListContainer.textContent = "";
		this.previewContainer.textContent = "";

		// Get chunks for file
		const chunks = await this.chunkIndexService.getChunksForFile(uri);

		if (chunks.length === 0) {
			this.renderEmptyState();
			return;
		}

		// Render chunks list
		const listTitle = document.createElement("div");
		listTitle.className = "ren-docs-view__chunks-title";
		listTitle.textContent = localize("renDocs.chunks.title", "Chunks");
		listTitle.style.padding = "8px";
		listTitle.style.fontWeight = "bold";
		listTitle.style.borderBottom = "1px solid var(--vscode-panel-border)";
		this.chunksListContainer.appendChild(listTitle);

		for (const chunk of chunks) {
			const chunkId = `${chunk.uri.toString()}#${chunk.hash}`;
			console.log("[DocsViewPane] Rendering chunk item with chunkId:", chunkId);
			const chunkItem = document.createElement("div");
			chunkItem.className = "ren-docs-view__chunk-item";
			chunkItem.dataset.chunkId = chunkId;
			chunkItem.style.padding = "8px";
			chunkItem.style.cursor = "pointer";
			chunkItem.style.borderBottom = "1px solid var(--vscode-panel-border)";

			if (this.selectedChunkId === chunkId) {
				chunkItem.style.backgroundColor =
					"var(--vscode-list-activeSelectionBackground)";
			}

			chunkItem.addEventListener("click", () => {
				this.selectedChunkId = chunkId;
				this.renderChunkPreview(chunkId);
				this.updateChunksListSelection();
			});

			const chunkName = document.createElement("div");
			chunkName.textContent =
				chunk.description || `Chunk ${chunk.hash.substring(0, 8)}`;
			chunkName.style.fontWeight = "500";
			chunkItem.appendChild(chunkName);

			if (chunk.range) {
				const rangeText = document.createElement("div");
				rangeText.textContent = `Lines ${chunk.range.startLineNumber}-${chunk.range.endLineNumber}`;
				rangeText.style.fontSize = "11px";
				rangeText.style.color = "var(--vscode-descriptionForeground)";
				chunkItem.appendChild(rangeText);
			}

			// Regenerate button
			const regenBtn = document.createElement("button");
			regenBtn.textContent = localize("renDocs.regenerate", "Regenerate");
			regenBtn.style.marginTop = "4px";
			regenBtn.style.fontSize = "11px";
			regenBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				await this.commandService.executeCommand(
					"ren.docs.regenerateChunk",
					chunkId
				);
			});
			chunkItem.appendChild(regenBtn);

			this.chunksListContainer.appendChild(chunkItem);
		}

		// Select first chunk by default
		if (chunks.length > 0 && !this.selectedChunkId) {
			const firstChunkId = `${chunks[0].uri.toString()}#${chunks[0].hash}`;
			this.selectedChunkId = firstChunkId;
			this.renderChunkPreview(firstChunkId);
			this.updateChunksListSelection();
		} else if (this.selectedChunkId) {
			// Restore preview if chunk was already selected
			console.log(
				"[DocsViewPane] Restoring preview for selected chunk:",
				this.selectedChunkId
			);
			this.renderChunkPreview(this.selectedChunkId);
			this.updateChunksListSelection();
		}
	}

	private updateChunksListSelection(): void {
		if (!this.chunksListContainer) {
			return;
		}

		const items = this.chunksListContainer.querySelectorAll(
			".ren-docs-view__chunk-item"
		);
		for (const item of items) {
			(item as HTMLElement).style.backgroundColor = "";
		}

		// Find and highlight selected
		const itemsArray = Array.from(items);
		for (const item of itemsArray) {
			const chunkId = (item as HTMLElement).dataset.chunkId;
			if (chunkId === this.selectedChunkId) {
				(item as HTMLElement).style.backgroundColor =
					"var(--vscode-list-activeSelectionBackground)";
			}
		}
	}

	private renderChunkPreview(chunkId: string): void {
		if (!this.previewContainer) {
			console.warn(
				"[DocsViewPane] renderChunkPreview: previewContainer not available"
			);
			return;
		}

		console.log("[DocsViewPane] Rendering preview for chunk:", chunkId);
		
		// Dispose previous markdown render
		if (this.renderedMarkdownDisposable) {
			this.renderedMarkdownDisposable.dispose();
			this.renderedMarkdownDisposable = undefined;
		}
		
		this.previewContainer.textContent = "";

		const doc = this.docsService.getChunkDocs(chunkId);
		if (!doc) {
			console.log(
				"[DocsViewPane] No doc found for chunk:",
				chunkId,
				"- showing loading state"
			);
			const loading = document.createElement("div");
			loading.textContent = localize("renDocs.loading", "Loading...");
			this.previewContainer.appendChild(loading);
			return;
		}

		console.log(
			"[DocsViewPane] Doc found, content length:",
			doc.content.length,
			"chars"
		);
		
		// Render markdown content using markdown renderer service
		const markdown = new MarkdownString(doc.content, { isTrusted: true });
        const renderedMarkdown = this.markdownRendererService.render(
			markdown,
			{
                sanitizerConfig: {
                    allowedTags: {
                        override: [
                            "p", "h1", "h2", "h3", "h4", "h5", "h6",
                            "ul", "ol", "li",
                            "code", "pre", "blockquote",
                            "strong", "em", "a", "img",
                            "table", "thead", "tbody", "tr", "th", "td"
                        ]
                    },
                    allowedAttributes: {
                        // Attribute allow-list across all tags
                        override: ["href", "title", "src", "alt", "class", "id", "name", "role", "tabindex"]
                    }
                },
			}
		);
		
		// Store disposable for cleanup
		this.renderedMarkdownDisposable = renderedMarkdown;
		
		// Add styling class and append to container
		renderedMarkdown.element.classList.add("ren-docs-view__preview-content");
		this.previewContainer.appendChild(renderedMarkdown.element);
		console.log("[DocsViewPane] Preview rendered successfully");
	}

	private renderEmptyState(): void {
		if (!this.chunksListContainer || !this.previewContainer) {
			return;
		}

		this.chunksListContainer.textContent = "";
		this.previewContainer.textContent = "";

		const empty = document.createElement("div");
		empty.style.padding = "16px";
		empty.style.textAlign = "center";
		empty.style.color = "var(--vscode-descriptionForeground)";
		empty.textContent = localize(
			"renDocs.empty",
			"No file selected or no chunks available. Open a file to see its documentation chunks."
		);
		this.previewContainer.appendChild(empty);
	}

	protected override layoutBody(height: number, width: number): void {
		// No-op, flex layout handles it
	}

	override dispose(): void {
		// Dispose markdown renderer
		if (this.renderedMarkdownDisposable) {
			this.renderedMarkdownDisposable.dispose();
			this.renderedMarkdownDisposable = undefined;
		}
		super.dispose();
	}
}

export class DocsViewModel extends Disposable {}
