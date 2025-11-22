/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from "../../../../../../nls.js";
import {
	Disposable,
	IDisposable,
} from "../../../../../../base/common/lifecycle.js";
import {
	ViewPane,
	IViewPaneOptions,
} from "../../../../../browser/parts/views/viewPane.js";
import { IDocsService } from "../../services/docsService.js";
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
import { ITextModelService } from "../../../../../../editor/common/services/resolverService.js";
import { ILanguageFeaturesService } from "../../../../../../editor/common/services/languageFeatures.js";
import { CancellationToken } from "../../../../../../base/common/cancellation.js";
import { Range, IRange } from "../../../../../../editor/common/core/range.js";
import { Position } from "../../../../../../editor/common/core/position.js";
import { TextEditorSelectionRevealType } from "../../../../../../platform/editor/common/editor.js";
import { IWorkspaceContextService } from "../../../../../../platform/workspace/common/workspace.js";
import { IFileDialogService } from "../../../../../../platform/dialogs/common/dialogs.js";
import { basename } from "../../../../../../base/common/resources.js";

type DocsMode = "file" | "directory";

export class DocsViewPane extends ViewPane {
	private contentContainer: HTMLElement | undefined;
	private renderedMarkdownDisposable: IDisposable | undefined;
	private currentFileUri: URI | undefined;
	private selectedDirectory: URI | undefined;
	private mode: DocsMode = "file";
	private toolbarContainer: HTMLElement | undefined;

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
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILanguageFeaturesService
		private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService
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

		// Listen to file docs updates
		this._register(
			this.docsService.onDidUpdateFileDocs((fileDoc) => {
				// If this is the current file, update view immediately
				if (this.mode === "file" && this.currentFileUri?.toString() === fileDoc.uri.toString()) {
					this.updateForActiveFile();
				}
			})
		);

		// Listen to directory docs updates
		this._register(
			this.docsService.onDidUpdateDirectoryDocs((directoryDoc) => {
				// If this is the current directory, update view immediately
				if (this.mode === "directory" && this.selectedDirectory?.toString() === directoryDoc.uri.toString()) {
					this.updateForSelectedDirectory();
				}
			})
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Ensure container is visible and sized
		container.classList.add("ren-docs-view");
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.height = "100%";
		container.style.width = "100%";
		container.style.overflow = "hidden";

		// Create wrapper div for our layout
		const wrapper = document.createElement("div");
		wrapper.style.display = "flex";
		wrapper.style.flexDirection = "column";
		wrapper.style.height = "100%";
		wrapper.style.width = "100%";
		wrapper.style.flex = "1";
		wrapper.style.overflow = "hidden";
		wrapper.style.background = "var(--vscode-editor-background)"; // Ensure background matches editor
		
		container.appendChild(wrapper);

		// Create toolbar container
		this.toolbarContainer = document.createElement("div");
		this.toolbarContainer.style.padding = "8px 12px";
		this.toolbarContainer.style.borderBottom = "1px solid var(--vscode-panel-border)";
		this.toolbarContainer.style.display = "flex";
		this.toolbarContainer.style.gap = "8px";
		this.toolbarContainer.style.alignItems = "center";
		this.toolbarContainer.style.flexShrink = "0";
		this.toolbarContainer.style.minHeight = "35px";
		this.toolbarContainer.style.background = "var(--vscode-sideBar-background)"; // Ensure toolbar background
		wrapper.appendChild(this.toolbarContainer);

		// Create single content container with improved styling
		this.contentContainer = document.createElement("div");
		this.contentContainer.className = "ren-docs-view__content";
		this.contentContainer.style.flex = "1";
		this.contentContainer.style.minHeight = "0";
		this.contentContainer.style.overflowY = "auto";
		this.contentContainer.style.overflowX = "hidden";
		this.contentContainer.style.padding = "20px";
		this.contentContainer.style.maxWidth = "100%";
		this.contentContainer.style.fontFamily = "var(--vscode-font-family)";
		this.contentContainer.style.fontSize = "13px";
		this.contentContainer.style.lineHeight = "1.6";
		this.contentContainer.style.position = "relative";
		wrapper.appendChild(this.contentContainer);

		// Initialize toolbar and content
		this.updateToolbar();
		if (this.mode === "file") {
			this.updateForActiveFile();
		} else {
			this.updateForSelectedDirectory();
		}
	}

	public override shouldShowWelcome(): boolean {
		// Always manage our own empty state UI
		return false;
	}

	private updateToolbar(): void {
		if (!this.toolbarContainer) {
			return;
		}

		// Get mode select before clearing
		const modeSelect = this.toolbarContainer.querySelector("select") as HTMLSelectElement | null;
		const modeValue = modeSelect?.value || this.mode;

		// Clear all children
		this.toolbarContainer.replaceChildren();

		// Recreate mode select
		const newModeSelect = document.createElement("select");
		newModeSelect.style.padding = "4px 8px";
		newModeSelect.style.border = "1px solid var(--vscode-dropdown-border)";
		newModeSelect.style.background = "var(--vscode-dropdown-background)";
		newModeSelect.style.color = "var(--vscode-dropdown-foreground)";
		newModeSelect.style.borderRadius = "2px";
		newModeSelect.style.fontSize = "12px";
		newModeSelect.style.cursor = "pointer";
		
		const fileOption = document.createElement("option");
		fileOption.value = "file";
		fileOption.textContent = "File";
		newModeSelect.appendChild(fileOption);
		
		const directoryOption = document.createElement("option");
		directoryOption.value = "directory";
		directoryOption.textContent = "Directory";
		newModeSelect.appendChild(directoryOption);
		
		newModeSelect.value = modeValue;
		newModeSelect.addEventListener("change", () => {
			this.mode = newModeSelect.value as DocsMode;
			this.updateToolbar();
			if (this.mode === "file") {
				this.updateForActiveFile();
			} else {
				this.updateForSelectedDirectory();
			}
		});
		this.toolbarContainer.appendChild(newModeSelect);

		if (this.mode === "directory") {
			// Add "Select Folder" button
			const selectFolderBtn = document.createElement("button");
			selectFolderBtn.textContent = "Select Folder";
			selectFolderBtn.style.padding = "4px 8px";
			selectFolderBtn.style.cursor = "pointer";
			selectFolderBtn.style.border = "1px solid var(--vscode-button-border)";
			selectFolderBtn.style.background = "var(--vscode-button-background)";
			selectFolderBtn.style.color = "var(--vscode-button-foreground)";
			selectFolderBtn.style.borderRadius = "2px";
			selectFolderBtn.style.fontSize = "12px";
			selectFolderBtn.addEventListener("click", async () => {
				const folder = await this.pickFolder(this.selectedDirectory);
				if (folder) {
					this.selectedDirectory = folder;
					this.updateForSelectedDirectory();
				}
			});
			this.toolbarContainer.appendChild(selectFolderBtn);
		}
	}

	private async updateForActiveFile(): Promise<void> {
		if (this.mode !== "file") {
			return;
		}

		const activeEditor = this.editorService.activeEditor;
		const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		});

		if (!uri || uri.scheme !== "file") {
			this.currentFileUri = undefined;
			this.renderEmptyState("No file selected. Open a file to see its documentation.");
			return;
		}

		this.currentFileUri = uri;
		await this.renderFileDocs(uri);
	}

	private async updateForSelectedDirectory(): Promise<void> {
		if (this.mode !== "directory") {
			return;
		}

		if (!this.selectedDirectory) {
			this.renderEmptyState("No directory selected. Click 'Select Folder' to choose a directory.");
			return;
		}

		await this.renderDirectoryDocs(this.selectedDirectory);
	}

	private async renderFileDocs(uri: URI): Promise<void> {
		console.log("[DocsViewPane] renderFileDocs - start", uri.fsPath);
		if (!this.contentContainer) {
			console.log("[DocsViewPane] renderFileDocs - missing container");
			return;
		}

		// Clear existing content
		this.contentContainer.textContent = "";

		// Dispose previous markdown render
		if (this.renderedMarkdownDisposable) {
			this.renderedMarkdownDisposable.dispose();
			this.renderedMarkdownDisposable = undefined;
		}

		// Get file docs
		const fileDoc = this.docsService.getFileDocs(uri);
		if (!fileDoc) {
			console.log(
				"[DocsViewPane] No doc found for file:",
				uri.fsPath,
				"- showing loading state"
			);
			const loadingContainer = document.createElement("div");
			loadingContainer.style.padding = "16px";
			loadingContainer.style.textAlign = "center";

			const loading = document.createElement("div");
			loading.textContent = localize("renDocs.loading", "Loading...");
			loadingContainer.appendChild(loading);

			const generateBtn = document.createElement("button");
			generateBtn.textContent = localize("renDocs.generate", "Generate Docs");
			generateBtn.style.marginTop = "8px";
			generateBtn.addEventListener("click", async () => {
				await this.commandService.executeCommand("ren.docs.initialize");
			});
			loadingContainer.appendChild(generateBtn);

			this.contentContainer.appendChild(loadingContainer);
			return;
		}

		console.log("[DocsViewPane] renderFileDocs - doc length:", fileDoc.content.length);

		// Create header with file info and regenerate button
		const header = document.createElement("div");
		header.style.marginBottom = "20px";
		header.style.paddingBottom = "12px";
		header.style.borderBottom = "2px solid var(--vscode-panel-border)";
		header.style.display = "flex";
		header.style.justifyContent = "space-between";
		header.style.alignItems = "flex-start";
		header.style.gap = "12px";

		const fileInfo = document.createElement("div");
		fileInfo.style.flex = "1";
		fileInfo.style.minWidth = "0";
		
		const fileName = document.createElement("div");
		fileName.textContent = uri.fsPath.split("/").pop() || uri.fsPath;
		fileName.style.fontWeight = "600";
		fileName.style.fontSize = "14px";
		fileName.style.marginBottom = "4px";
		fileName.style.color = "var(--vscode-foreground)";
		fileInfo.appendChild(fileName);
		
		const filePath = document.createElement("div");
		filePath.textContent = uri.fsPath;
		filePath.style.fontSize = "11px";
		filePath.style.color = "var(--vscode-descriptionForeground)";
		filePath.style.marginBottom = "6px";
		filePath.style.wordBreak = "break-all";
		fileInfo.appendChild(filePath);
		
		const generatedAt = document.createElement("div");
		generatedAt.textContent = `Last updated: ${new Date(fileDoc.generatedAt).toLocaleString()}`;
		generatedAt.style.fontSize = "11px";
		generatedAt.style.color = "var(--vscode-descriptionForeground)";
		fileInfo.appendChild(generatedAt);
		header.appendChild(fileInfo);

		const regenBtn = document.createElement("button");
		regenBtn.textContent = localize("renDocs.regenerate", "Regenerate");
		regenBtn.style.padding = "6px 12px";
		regenBtn.style.cursor = "pointer";
		regenBtn.style.border = "1px solid var(--vscode-button-border)";
		regenBtn.style.background = "var(--vscode-button-background)";
		regenBtn.style.color = "var(--vscode-button-foreground)";
		regenBtn.style.borderRadius = "2px";
		regenBtn.addEventListener("mouseenter", () => {
			regenBtn.style.background = "var(--vscode-button-hoverBackground)";
		});
		regenBtn.addEventListener("mouseleave", () => {
			regenBtn.style.background = "var(--vscode-button-background)";
		});
		regenBtn.addEventListener("click", async () => {
			regenBtn.disabled = true;
			regenBtn.textContent = "Regenerating...";
			try {
				await this.commandService.executeCommand(
					"ren.docs.regenerateFile"
				);
			} finally {
				regenBtn.disabled = false;
				regenBtn.textContent = localize("renDocs.regenerate", "Regenerate");
			}
		});
		header.appendChild(regenBtn);

		this.contentContainer.appendChild(header);

		// Render markdown content using markdown renderer service
		const markdown = new MarkdownString(fileDoc.content, { isTrusted: true, supportHtml: true });
		
		let renderedMarkdown: any;
		try {
			renderedMarkdown = this.markdownRendererService.render(markdown, {
				sanitizerConfig: {
					allowedTags: {
						override: ['html', 'body', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'br', 'strong', 'em', 'b', 'i', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'del', 'sup', 'sub']
					},
					allowedAttributes: {
						override: [
							'class', 'style', 'title', 'id', 'name', 'role', 'aria-label', 'aria-hidden',
							'href', 'target', 'rel',
							'src', 'alt', 'width', 'height'
						]
					}
				}
			});
		} catch (error) {
			console.error("[DocsViewPane] Markdown render failed (TrustedHTML issue?):", error);
		}

		if (renderedMarkdown) {
			// Store disposable for cleanup
			this.renderedMarkdownDisposable = renderedMarkdown;

			// Add styling class and append to container
			renderedMarkdown.element.classList.add("ren-docs-view__content-markdown");
			
			// Debug check: if empty, show raw
			if (!renderedMarkdown.element.innerHTML && fileDoc.content) {
				console.warn("[DocsViewPane] Markdown renderer produced empty output. Falling back to raw text.");
				const rawPre = document.createElement("pre");
				rawPre.style.whiteSpace = "pre-wrap";
				rawPre.style.wordBreak = "break-word";
				rawPre.textContent = fileDoc.content;
				renderedMarkdown.element.appendChild(rawPre);
			}
			
			// Apply enhanced styling to markdown content
			this.applyMarkdownStyles(renderedMarkdown.element);
			
			// Enhance markdown with clickable symbols
			if (uri) {
				this.enhanceMarkdownWithClickableSymbols(renderedMarkdown.element, uri);
			}
			
			this.contentContainer.appendChild(renderedMarkdown.element);
		} else {
			// Hard fallback if render threw exception
			console.warn("[DocsViewPane] Render failed completely. Showing raw text fallback.");
			const rawPre = document.createElement("pre");
			rawPre.style.whiteSpace = "pre-wrap";
			rawPre.style.wordBreak = "break-word";
			rawPre.style.fontFamily = "var(--vscode-editor-font-family)";
			rawPre.textContent = fileDoc.content;
			this.contentContainer.appendChild(rawPre);
		}

		console.log("[DocsViewPane] renderFileDocs - completed");
	}

	private async enhanceMarkdownWithClickableSymbols(
		element: HTMLElement,
		uri: URI
	): Promise<void> {
		// Find all code elements (symbol names in backticks)
		const codeElements = element.querySelectorAll("code");
		
		if (codeElements.length === 0) {
			return;
		}

		try {
			// Get text model for symbol lookup
			const reference = await this.textModelService.createModelReference(uri);
			try {
				const textModel = reference.object.textEditorModel;
				
				// Process each code element
				for (const codeEl of Array.from(codeElements)) {
					const symbolName = codeEl.textContent?.trim();
					if (!symbolName || symbolName.includes(" ") || symbolName.includes("\n")) {
						continue; // Skip multi-word or multi-line code blocks
					}

					// Extract clean symbol name (remove function params if present)
					const cleanName = symbolName.replace(/\([^)]*\)$/, "").trim();
					if (!cleanName || cleanName.length < 2) {
						continue;
					}

					// Try to find the symbol in the document
					const symbolLocation = await this.findSymbolInDocument(
						textModel,
						cleanName
					);

					if (symbolLocation) {
						// Make it clickable
						codeEl.style.cursor = "pointer";
						codeEl.style.color = "var(--vscode-textLink-foreground)";
						codeEl.style.textDecoration = "underline";
						codeEl.style.transition = "opacity 0.2s";
						
						const isExternal = symbolLocation.uri && symbolLocation.uri.toString() !== uri.toString();
						const locationText = isExternal 
							? `Go to ${cleanName} in ${symbolLocation.uri?.fsPath.split("/").pop() || "file"}`
							: `Go to ${cleanName}${symbolLocation.lineNumber ? ` (line ${symbolLocation.lineNumber})` : ""}`;
						codeEl.title = locationText;

						codeEl.addEventListener("click", async (e) => {
							e.preventDefault();
							e.stopPropagation();
							const targetUri = symbolLocation.uri || uri;
							await this.navigateToSymbol(targetUri, {
								lineNumber: symbolLocation.lineNumber,
								column: symbolLocation.column,
							});
						});

						codeEl.addEventListener("mouseenter", () => {
							codeEl.style.opacity = "0.8";
						});

						codeEl.addEventListener("mouseleave", () => {
							codeEl.style.opacity = "1";
						});
					} else {
						// Try to find in other files via definition providers
						const definition = await this.findSymbolDefinition(textModel, cleanName);
						if (definition) {
							codeEl.style.cursor = "pointer";
							codeEl.style.color = "var(--vscode-textLink-foreground)";
							codeEl.style.textDecoration = "underline";
							codeEl.style.transition = "opacity 0.2s";
							
							const defUri = definition.uri;
							const isExternal = defUri.toString() !== uri.toString();
							const locationText = isExternal
								? `Go to ${cleanName} in ${defUri.fsPath.split("/").pop() || "file"}`
								: `Go to ${cleanName} (line ${definition.lineNumber})`;
							codeEl.title = locationText;

							codeEl.addEventListener("click", async (e) => {
								e.preventDefault();
								e.stopPropagation();
								await this.navigateToSymbol(defUri, {
									lineNumber: definition.lineNumber,
									column: definition.column,
								});
							});

							codeEl.addEventListener("mouseenter", () => {
								codeEl.style.opacity = "0.8";
							});

							codeEl.addEventListener("mouseleave", () => {
								codeEl.style.opacity = "1";
							});
						}
					}
				}
			} finally {
				reference.dispose();
			}
		} catch (error) {
			console.warn("[DocsViewPane] Failed to enhance markdown with clickable symbols:", error);
		}
	}

	private async findSymbolDefinition(
		textModel: any,
		symbolName: string
	): Promise<{ uri: URI; lineNumber: number; column: number } | null> {
		try {
			// Search for the symbol in the document first
			const content = textModel.getValue();
			const lines = content.split(/\r?\n/);
			const symbolRegex = new RegExp(
				`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
			);

			for (let i = 0; i < lines.length; i++) {
				const match = symbolRegex.exec(lines[i]);
				if (match) {
					// Try to get definition
					const position = new Position(i + 1, match.index + 1);
					const providers =
						this.languageFeaturesService.definitionProvider.all(textModel);

					for (const provider of providers) {
						try {
							const definitions = await provider.provideDefinition(
								textModel,
								position,
								CancellationToken.None
							);
							if (!definitions) continue;

							const defs = Array.isArray(definitions) ? definitions : [definitions];
							for (const def of defs) {
								if (def && def.uri && def.range) {
									// Extract line/column from IRange
									const range = def.range as IRange;
									return {
										uri: URI.from(def.uri),
										lineNumber: range.startLineNumber,
										column: range.startColumn || 1,
									};
								}
							}
						} catch (e) {
							continue;
						}
					}
				}
			}
		} catch (error) {
			console.warn("[DocsViewPane] Error finding symbol definition:", error);
		}

		return null;
	}

	private async findSymbolInDocument(
		textModel: any,
		symbolName: string
	): Promise<{ uri?: URI; lineNumber: number; column: number } | null> {
		try {
			// Get document symbols
			const providers =
				this.languageFeaturesService.documentSymbolProvider.all(textModel);
			
			for (const provider of providers) {
				try {
					const symbols = await provider.provideDocumentSymbols(
						textModel,
						CancellationToken.None
					);
					if (!symbols) continue;

					// Flatten symbols
					const flattenSymbols = (syms: any[]): any[] => {
						const result: any[] = [];
						for (const sym of syms) {
							if (
								sym.name === symbolName ||
								sym.name.replace(/\([^)]*\)$/, "").trim() === symbolName
							) {
								result.push(sym);
							}
							if (sym.children && sym.children.length > 0) {
								result.push(...flattenSymbols(sym.children));
							}
						}
						return result;
					};

					const flatSymbols = flattenSymbols(
						Array.isArray(symbols) ? symbols : [symbols]
					);

					// Find matching symbol
					for (const symbol of flatSymbols) {
						const name = symbol.name?.replace(/\([^)]*\)$/, "").trim();
						if (name === symbolName && symbol.range) {
							return {
								lineNumber: symbol.range.startLineNumber,
								column: symbol.range.startColumn || 1,
							};
						}
					}
				} catch (e) {
					// Continue to next provider
					continue;
				}
			}

			// Fallback: search in document text
			const content = textModel.getValue();
			const lines = content.split(/\r?\n/);
			const symbolRegex = new RegExp(
				`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
			);

			for (let i = 0; i < lines.length; i++) {
				const match = symbolRegex.exec(lines[i]);
				if (match) {
					// Check if it looks like a declaration
					const line = lines[i];
					if (
						/^\s*(export\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+/.test(
							line.substring(0, match.index + 50)
						)
					) {
						return {
							lineNumber: i + 1,
							column: match.index + 1,
						};
					}
				}
			}
		} catch (error) {
			console.warn("[DocsViewPane] Error finding symbol:", error);
		}

		return null;
	}

	private async navigateToSymbol(
		uri: URI,
		location: { lineNumber: number; column: number }
	): Promise<void> {
		try {
			await this.editorService.openEditor({
				resource: uri,
				options: {
					selection: new Range(
						location.lineNumber,
						location.column,
						location.lineNumber,
						location.column
					),
					selectionRevealType: TextEditorSelectionRevealType.CenterIfOutsideViewport,
				},
			});
		} catch (error) {
			console.warn("[DocsViewPane] Failed to navigate to symbol:", error);
		}
	}

	private applyMarkdownStyles(element: HTMLElement): void {
		// Style headings
		const headings = element.querySelectorAll("h1, h2, h3, h4, h5, h6");
		for (const heading of Array.from(headings)) {
			(heading as HTMLElement).style.marginTop = "24px";
			(heading as HTMLElement).style.marginBottom = "12px";
			(heading as HTMLElement).style.fontWeight = "600";
			(heading as HTMLElement).style.color = "var(--vscode-foreground)";
		}

		// Style paragraphs
		const paragraphs = element.querySelectorAll("p");
		for (const p of Array.from(paragraphs)) {
			(p as HTMLElement).style.marginBottom = "12px";
			(p as HTMLElement).style.lineHeight = "1.6";
		}

		// Style lists
		const lists = element.querySelectorAll("ul, ol");
		for (const list of Array.from(lists)) {
			(list as HTMLElement).style.marginBottom = "12px";
			(list as HTMLElement).style.paddingLeft = "24px";
		}

		const listItems = element.querySelectorAll("li");
		for (const li of Array.from(listItems)) {
			(li as HTMLElement).style.marginBottom = "6px";
			(li as HTMLElement).style.lineHeight = "1.6";
		}

		// Style code blocks
		const codeBlocks = element.querySelectorAll("pre code");
		for (const code of Array.from(codeBlocks)) {
			(code as HTMLElement).style.padding = "12px";
			(code as HTMLElement).style.borderRadius = "4px";
			(code as HTMLElement).style.backgroundColor = "var(--vscode-textCodeBlock-background)";
			(code as HTMLElement).style.display = "block";
			(code as HTMLElement).style.overflowX = "auto";
		}

		// Style inline code (but not code blocks)
		const inlineCodes = element.querySelectorAll("code");
		for (const code of Array.from(inlineCodes)) {
			const parent = code.parentElement;
			if (parent && parent.tagName === "PRE") {
				continue; // Skip code blocks
			}
			(code as HTMLElement).style.backgroundColor = "var(--vscode-textCodeBlock-background)";
			(code as HTMLElement).style.padding = "2px 4px";
			(code as HTMLElement).style.borderRadius = "3px";
			(code as HTMLElement).style.fontFamily = "var(--vscode-editor-font-family)";
			(code as HTMLElement).style.fontSize = "12px";
		}

		// Style links
		const links = element.querySelectorAll("a");
		for (const link of Array.from(links)) {
			(link as HTMLElement).style.color = "var(--vscode-textLink-foreground)";
			(link as HTMLElement).style.textDecoration = "underline";
			(link as HTMLElement).style.cursor = "pointer";
		}

		// Add spacing between sections
		const h2s = element.querySelectorAll("h2");
		for (let i = 1; i < h2s.length; i++) {
			(h2s[i] as HTMLElement).style.marginTop = "32px";
		}
	}

	private renderEmptyState(message?: string): void {
		if (!this.contentContainer) {
			return;
		}

		this.contentContainer.textContent = "";

		const empty = document.createElement("div");
		empty.style.padding = "16px";
		empty.style.textAlign = "center";
		empty.style.color = "var(--vscode-descriptionForeground)";
		empty.textContent = message || localize(
			"renDocs.empty",
			"No file selected. Open a file to see its documentation."
		);
		this.contentContainer.appendChild(empty);
	}

	private async pickFolder(initialFolder?: URI): Promise<URI | undefined> {
		const defaultUri =
			initialFolder ||
			(this.workspaceContextService.getWorkspace().folders.length > 0
				? this.workspaceContextService.getWorkspace().folders[0].uri
				: undefined);

		const result = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: defaultUri,
			title: "Select Folder for Documentation",
			openLabel: "Select Folder",
		});

		if (result && result.length > 0) {
			return result[0];
		}

		return undefined;
	}

	private async renderDirectoryDocs(uri: URI): Promise<void> {
		console.log("[DocsViewPane] renderDirectoryDocs - start", uri.fsPath);
		if (!this.contentContainer) {
			console.log("[DocsViewPane] renderDirectoryDocs - missing container");
			return;
		}

		// Clear existing content
		this.contentContainer.textContent = "";

		// Dispose previous markdown render
		if (this.renderedMarkdownDisposable) {
			this.renderedMarkdownDisposable.dispose();
			this.renderedMarkdownDisposable = undefined;
		}

		// Get directory docs
		const directoryDoc = this.docsService.getDirectoryDocs(uri);
		if (!directoryDoc) {
			console.log(
				"[DocsViewPane] No directory doc found for:",
				uri.fsPath,
				"- showing loading state"
			);
			const loadingContainer = document.createElement("div");
			loadingContainer.style.padding = "16px";
			loadingContainer.style.textAlign = "center";

			const loading = document.createElement("div");
			loading.textContent = "Loading...";
			loadingContainer.appendChild(loading);

			const generateBtn = document.createElement("button");
			generateBtn.textContent = "Generate Docs";
			generateBtn.style.marginTop = "8px";
			generateBtn.style.padding = "6px 12px";
			generateBtn.style.cursor = "pointer";
			generateBtn.style.border = "1px solid var(--vscode-button-border)";
			generateBtn.style.background = "var(--vscode-button-background)";
			generateBtn.style.color = "var(--vscode-button-foreground)";
			generateBtn.style.borderRadius = "2px";
			generateBtn.addEventListener("click", async () => {
				generateBtn.disabled = true;
				generateBtn.textContent = "Generating...";
				try {
					await this.docsService.generateDocsForDirectory(uri, "initialize");
					await this.updateForSelectedDirectory();
				} finally {
					generateBtn.disabled = false;
					generateBtn.textContent = "Generate Docs";
				}
			});
			loadingContainer.appendChild(generateBtn);

			this.contentContainer.appendChild(loadingContainer);
			return;
		}

		console.log(
			"[DocsViewPane] renderDirectoryDocs - doc length:",
			directoryDoc.content.length,
			"files:",
			directoryDoc.fileCount || 0
		);

		// Create header with directory info and regenerate button
		const header = document.createElement("div");
		header.style.marginBottom = "20px";
		header.style.paddingBottom = "12px";
		header.style.borderBottom = "2px solid var(--vscode-panel-border)";
		header.style.display = "flex";
		header.style.justifyContent = "space-between";
		header.style.alignItems = "flex-start";
		header.style.gap = "12px";

		const directoryInfo = document.createElement("div");
		directoryInfo.style.flex = "1";
		directoryInfo.style.minWidth = "0";
		
		const directoryName = document.createElement("div");
		directoryName.textContent = basename(uri) || uri.fsPath;
		directoryName.style.fontWeight = "600";
		directoryName.style.fontSize = "14px";
		directoryName.style.marginBottom = "4px";
		directoryName.style.color = "var(--vscode-foreground)";
		directoryInfo.appendChild(directoryName);
		
		const directoryPath = document.createElement("div");
		directoryPath.textContent = uri.fsPath;
		directoryPath.style.fontSize = "11px";
		directoryPath.style.color = "var(--vscode-descriptionForeground)";
		directoryPath.style.marginBottom = "6px";
		directoryPath.style.wordBreak = "break-all";
		directoryInfo.appendChild(directoryPath);

		const fileCount = document.createElement("div");
		fileCount.textContent = `Files: ${directoryDoc.fileCount || 0}`;
		fileCount.style.fontSize = "11px";
		fileCount.style.color = "var(--vscode-descriptionForeground)";
		fileCount.style.marginBottom = "6px";
		directoryInfo.appendChild(fileCount);
		
		const generatedAt = document.createElement("div");
		generatedAt.textContent = `Last updated: ${new Date(directoryDoc.generatedAt).toLocaleString()}`;
		generatedAt.style.fontSize = "11px";
		generatedAt.style.color = "var(--vscode-descriptionForeground)";
		directoryInfo.appendChild(generatedAt);
		header.appendChild(directoryInfo);

		const regenBtn = document.createElement("button");
		regenBtn.textContent = "Regenerate";
		regenBtn.style.padding = "6px 12px";
		regenBtn.style.cursor = "pointer";
		regenBtn.style.border = "1px solid var(--vscode-button-border)";
		regenBtn.style.background = "var(--vscode-button-background)";
		regenBtn.style.color = "var(--vscode-button-foreground)";
		regenBtn.style.borderRadius = "2px";
		regenBtn.addEventListener("mouseenter", () => {
			regenBtn.style.background = "var(--vscode-button-hoverBackground)";
		});
		regenBtn.addEventListener("mouseleave", () => {
			regenBtn.style.background = "var(--vscode-button-background)";
		});
		regenBtn.addEventListener("click", async () => {
			regenBtn.disabled = true;
			regenBtn.textContent = "Regenerating...";
			try {
				await this.docsService.generateDocsForDirectory(uri, "regenerate");
				await this.updateForSelectedDirectory();
			} finally {
				regenBtn.disabled = false;
				regenBtn.textContent = "Regenerate";
			}
		});
		header.appendChild(regenBtn);

		this.contentContainer.appendChild(header);

		// Render markdown content using markdown renderer service
		const markdown = new MarkdownString(directoryDoc.content, { isTrusted: true, supportHtml: true });
		
		let renderedMarkdown: any;
		try {
			renderedMarkdown = this.markdownRendererService.render(markdown, {
				sanitizerConfig: {
					allowedTags: {
						override: ['html', 'body', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'br', 'strong', 'em', 'b', 'i', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'del', 'sup', 'sub']
					},
					allowedAttributes: {
						override: [
							'class', 'style', 'title', 'id', 'name', 'role', 'aria-label', 'aria-hidden',
							'href', 'target', 'rel',
							'src', 'alt', 'width', 'height'
						]
					}
				}
			});
		} catch (error) {
			console.error("[DocsViewPane] Directory markdown render failed:", error);
		}

		if (renderedMarkdown) {
			// Store disposable for cleanup
			this.renderedMarkdownDisposable = renderedMarkdown;

			// Add styling class and append to container
			renderedMarkdown.element.classList.add("ren-docs-view__content-markdown");
			
			// Debug check: if empty, show raw
			if (!renderedMarkdown.element.innerHTML && directoryDoc.content) {
				console.warn("[DocsViewPane] Markdown renderer produced empty output. Falling back to raw text.");
				const rawPre = document.createElement("pre");
				rawPre.style.whiteSpace = "pre-wrap";
				rawPre.style.wordBreak = "break-word";
				rawPre.textContent = directoryDoc.content;
				renderedMarkdown.element.appendChild(rawPre);
			}
			
			// Apply enhanced styling to markdown content
			this.applyMarkdownStyles(renderedMarkdown.element);
			
			this.contentContainer.appendChild(renderedMarkdown.element);
		} else {
			// Fallback
			const rawPre = document.createElement("pre");
			rawPre.style.whiteSpace = "pre-wrap";
			rawPre.style.wordBreak = "break-word";
			rawPre.textContent = directoryDoc.content;
			this.contentContainer.appendChild(rawPre);
		}

		console.log("[DocsViewPane] renderDirectoryDocs - completed");
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		console.log(`[DocsViewPane] layoutBody - ${width}x${height}`);
		if (this.contentContainer?.parentElement) {
			const wrapper = this.contentContainer.parentElement as HTMLElement;
			wrapper.style.height = `${height}px`;
			wrapper.style.width = `${width}px`;
		}
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
