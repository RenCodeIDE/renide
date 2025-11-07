/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions,
} from "../../../common/contributions.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import { IDocsService } from "./services/docsService.js";
import {
	IChunkIndexService,
	ChunkRecord,
} from "./services/chunkIndexService.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import {
	EditorResourceAccessor,
	SideBySideEditor,
} from "../../../common/editor.js";
import { IMerkleTreeService } from "../../../../platform/merkleTree/common/merkleTreeService.js";
import { URI } from "../../../../base/common/uri.js";
import { IOutlineModelService } from "../../../../editor/contrib/documentSymbols/browser/outlineModel.js";
import { ITextModelService } from "../../../../editor/common/services/resolverService.js";
import { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";
import { Range } from "../../../../editor/common/core/range.js";
import { Position } from "../../../../editor/common/core/position.js";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import { Location, LocationLink } from "../../../../editor/common/languages.js";
import { ITextModel } from "../../../../editor/common/model.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";

export class DocsAgentContribution
	extends Disposable
	implements IWorkbenchContribution
{
	private currentActiveFile: URI | undefined;
	private readonly debouncedProcessActiveFile = new RunOnceScheduler(
		() => this.processActiveFile(),
		500
	);
	private readonly debouncedProcessMerkleChange = new RunOnceScheduler(
		() => this.processMerkleChange(),
		1000
	);
	private lastKnownChunks: Map<string, string[]> = new Map(); // fileUri -> chunk hashes
	private lastChangeTimestamps: Map<string, number> = new Map(); // fileUri -> timestamp of last hash change
	private readonly COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

	constructor(
		@IDocsService private readonly docsService: IDocsService,
		@IChunkIndexService private readonly chunkIndexService: IChunkIndexService,
		@IEditorService private readonly editorService: IEditorService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IOutlineModelService
		private readonly outlineModelService: IOutlineModelService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILanguageFeaturesService
		private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) {
		super();

		// Listen to active editor changes
		this._register(
			this.editorService.onDidActiveEditorChange(() => {
				this.debouncedProcessActiveFile.schedule();
			})
		);

		// Listen to Merkle tree changes
		this._register(
			this.merkleTreeService.onDidChangeTree(() => {
				this.debouncedProcessMerkleChange.schedule();
			})
		);

		// Listen to manual doc updates (from button clicks) to update timestamps
		this._register(
			this.docsService.onDidUpdateFileDocs((fileDocs) => {
				const fileUri = fileDocs.uri.toString();
				// Update timestamp for manual regeneration (bypasses cooldown)
				this.lastChangeTimestamps.set(fileUri, Date.now());
				// Also update stored hashes if we have them
				const relativePath = this.getRelativePath(fileDocs.uri);
				if (relativePath) {
					this.merkleTreeService
						.getFileChunks(relativePath)
						.then((chunks) => {
							if (chunks) {
								const hashes = chunks.map((c) => c.hash);
								this.lastKnownChunks.set(fileUri, hashes);
							}
						});
				}
			})
		);

		// Process initial active file
		this.debouncedProcessActiveFile.schedule();
	}

	private async processActiveFile(): Promise<void> {
		const activeEditor = this.editorService.activeEditor;
		const uri = EditorResourceAccessor.getOriginalUri(activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		});

		if (!uri || uri.scheme !== "file") {
			this.currentActiveFile = undefined;
			return;
		}

		if (this.currentActiveFile?.toString() === uri.toString()) {
			return; // Already processed
		}

		this.currentActiveFile = uri;
		await this.ensureChunksForFile(uri);
	}

	private async processMerkleChange(): Promise<void> {
		if (!this.currentActiveFile) {
			return;
		}

		await this.handleMerkleChangeForFile(this.currentActiveFile);
	}

	private async ensureChunkMetadataForFile(uri: URI): Promise<void> {
		const fileUri = uri.toString();
		const existingChunks = this.chunkIndexService.listFileChunks(uri);

		if (existingChunks.length > 0) {
			// Chunk metadata already exists
			return;
		}

		// Ensure file is tracked in Merkle tree (if lazy tracking is enabled)
		await this.merkleTreeService.ensureTracked(uri);

		// Build chunks from Merkle tree
		const relativePath = this.getRelativePath(uri);
		if (!relativePath) {
			return;
		}

		// Get chunks with retry logic - force creation if needed
		let fileChunks = await this.merkleTreeService.getFileChunks(relativePath);

		if (!fileChunks || fileChunks.length === 0) {
			// Force Merkle tree to process this file with priority
			console.log(
				`[DocsAgent] No chunks found for ${relativePath} (workspace-relative path), forcing Merkle tree to process file...`
			);

			// Retry with exponential backoff
			const maxRetries = 3;
			let retryDelay = 100;
			
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				// Invalidate path to force recalculation
				await this.merkleTreeService.invalidatePath(uri);
				
				// Ensure file is tracked again
				await this.merkleTreeService.ensureTracked(uri);
				
				// Wait for async processing with exponential backoff
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
				
				// Retry getting chunks
				fileChunks = await this.merkleTreeService.getFileChunks(relativePath);
				
				if (fileChunks && fileChunks.length > 0) {
					console.log(
						`[DocsAgent] Successfully got chunks for ${relativePath} after ${attempt + 1} attempt(s) (${fileChunks.length} chunks)`
					);
					break;
				}
				
				console.log(
					`[DocsAgent] Retry ${attempt + 1}/${maxRetries}: Still no chunks for ${relativePath}, waiting ${retryDelay}ms...`
				);
				
				// Exponential backoff: 100ms -> 200ms -> 400ms
				retryDelay *= 2;
			}

			if (!fileChunks || fileChunks.length === 0) {
				// After retries, still no chunks - file might not be accessible
				console.warn(
					`[DocsAgent] Failed to get chunks for ${relativePath} after ${maxRetries} retries. File may not be accessible or Merkle tree may not have processed it yet.`
				);
				return;
			}
		} else {
			console.log(
				`[DocsAgent] Found ${fileChunks.length} chunks for ${relativePath} (workspace-relative path)`
			);
		}

		// Create chunk records from Merkle chunks
		const chunkHashes: string[] = [];

		for (let i = 0; i < fileChunks.length; i++) {
			const fileChunk = fileChunks[i];
			const hash = fileChunk.hash;
			chunkHashes.push(hash);

			// Extract symbols for this chunk range
			const symbols = await this.extractSymbolsForRange(
				uri,
				fileChunk.startLine,
				fileChunk.endLine
			);

			const chunk: ChunkRecord = {
				uri,
				hash,
				parentHash: fileChunk.parentHash, // Use parentHash from Merkle tree
				description: `Chunk ${i + 1} (lines ${fileChunk.startLine + 1}-${
					fileChunk.endLine
				})`,
				refs: {
					symbols,
					files: [],
					functions: [],
				},
				range: new Range(fileChunk.startLine + 1, 1, fileChunk.endLine, 1),
				updatedAt: Date.now(),
			};

			await this.chunkIndexService.upsertChunk(chunk);
		}

		this.lastKnownChunks.set(fileUri, chunkHashes);
	}

	private async ensureChunksForFile(uri: URI): Promise<void> {
		const fileUri = uri.toString();
		const relativePath = this.getRelativePath(uri);

		// First ensure chunk metadata exists (this ensures file is tracked in Merkle tree)
		await this.ensureChunkMetadataForFile(uri);

		// Get current hashes from Merkle tree
		let currentHashes: string[] = [];
		if (relativePath) {
			const currentChunks = await this.merkleTreeService.getFileChunks(
				relativePath
			);
			if (currentChunks) {
				currentHashes = currentChunks.map((c) => c.hash);
			}
		}

		// Check if hashes changed (comparing with stored hashes)
		const storedHashes = this.lastKnownChunks.get(fileUri) || [];
		const hashesChanged =
			currentHashes.length !== storedHashes.length ||
			currentHashes.some((hash, i) => hash !== storedHashes[i]);

		// Check if file doc exists
		const existingFileDoc = this.docsService.getFileDocs(uri);

		// If hashes changed (active file switch), regenerate entire file doc (bypass cooldown)
		if (hashesChanged && currentHashes.length > 0) {
			console.log(
				`[DocsAgent] Active file ${relativePath} hashes changed: regenerating file-level docs (bypassing cooldown)`
			);

			// Update metadata first
			await this.chunkIndexService.removeChunksForFile(uri);
			await this.ensureChunkMetadataForFile(uri);
			
			// Regenerate entire file doc
			await this.docsService.generateDocsForFile(uri, "regenerate");
			
			// Update stored hashes and timestamp
			this.lastKnownChunks.set(fileUri, currentHashes);
			this.lastChangeTimestamps.set(fileUri, Date.now());
		} else if (!existingFileDoc && currentHashes.length > 0) {
			// Generate docs if missing
			console.log(
				`[DocsAgent] Generating initial file-level docs for ${relativePath}`
			);
			await this.docsService.generateDocsForFile(uri, "initialize");
			// Update stored hashes if we have them
			this.lastKnownChunks.set(fileUri, currentHashes);
		} else if (currentHashes.length > 0) {
			// Update stored hashes even if no regeneration needed
			this.lastKnownChunks.set(fileUri, currentHashes);
		}
	}

	private async handleMerkleChangeForFile(uri: URI): Promise<void> {
		const relativePath = this.getRelativePath(uri);
		if (!relativePath) {
			return;
		}

		const currentChunks = await this.merkleTreeService.getFileChunks(
			relativePath
		);
		if (!currentChunks) {
			return;
		}

		const fileUri = uri.toString();
		const oldHashes = this.lastKnownChunks.get(fileUri) || [];
		const newHashes = currentChunks.map((c) => c.hash);

		// Check if any chunks changed
		const hasChanges =
			oldHashes.length !== newHashes.length ||
			newHashes.some((hash, i) => hash !== oldHashes[i]);

		if (hasChanges) {
			// Update timestamp to track when change occurred
			this.lastChangeTimestamps.set(fileUri, Date.now());
			console.log(
				`[DocsAgent] File ${relativePath} changed: regenerating file-level docs`
			);
		}

		// Only regenerate if:
		// 1. Hashes changed
		// 2. File is currently active
		// 3. Cooldown has expired (5 minutes since last change)
		const isActiveFile = uri.toString() === this.currentActiveFile?.toString();
		if (hasChanges && isActiveFile && this.hasCooldownExpired(fileUri)) {
			console.log(
				`[DocsAgent] Regenerating file-level docs for active file ${relativePath} (cooldown expired)`
			);
			// Rebuild chunk metadata (this will update symbols, etc.)
			await this.chunkIndexService.removeChunksForFile(uri);
			await this.ensureChunkMetadataForFile(uri);
			// Regenerate entire file doc
			await this.docsService.generateDocsForFile(uri, "regenerate");
			// Update timestamp after regeneration
			this.lastChangeTimestamps.set(fileUri, Date.now());
		} else if (hasChanges && isActiveFile) {
			console.log(
				`[DocsAgent] File ${relativePath} changed but cooldown not expired (will regenerate in ${Math.ceil((this.COOLDOWN_MS - (Date.now() - (this.lastChangeTimestamps.get(fileUri) || 0))) / 1000)}s)`
			);
		} else if (hasChanges && !isActiveFile) {
			console.log(
				`[DocsAgent] File ${relativePath} changed but not active (will regenerate when file becomes active)`
			);
		}

		this.lastKnownChunks.set(fileUri, newHashes);
	}

	private async extractSymbolsForRange(
		uri: URI,
		startLine: number,
		endLine: number
	): Promise<ChunkRecord["refs"]["symbols"]> {
		try {
			const reference = await this.textModelService.createModelReference(uri);
			try {
				const textModel = reference.object.textEditorModel;
				const outline = await this.outlineModelService.getOrCreate(
					textModel,
					CancellationToken.None
				);
				const topLevelSymbols = outline.getTopLevelSymbols();

				const symbols: ChunkRecord["refs"]["symbols"] = [];
				for (const symbol of topLevelSymbols) {
					if (
						symbol.range.startLineNumber >= startLine + 1 &&
						symbol.range.endLineNumber <= endLine + 1
					) {
						// Resolve symbol origin: check if it's defined locally or imported from another file
						const symbolPosition = new Position(
							symbol.selectionRange.startLineNumber,
							symbol.selectionRange.startColumn
						);
						const originUri = await this.resolveSymbolOrigin(
							textModel,
							symbolPosition
						);

						symbols.push({
							name: symbol.name,
							kind: symbol.kind.toString(),
							uri: originUri, // Use origin file URI (where symbol is actually defined)
							range: symbol.range,
						});
					}
				}
				return symbols;
			} finally {
				reference.dispose();
			}
		} catch (e) {
			console.warn("[DocsAgent] Failed to extract symbols:", e);
			return [];
		}
	}

	private async resolveSymbolOrigin(
		textModel: ITextModel,
		position: Position
	): Promise<URI> {
		try {
			// Get definition providers for this text model
			const definitionProviders =
				this.languageFeaturesService.definitionProvider.all(textModel);

			if (definitionProviders.length === 0) {
				// No definition provider, assume it's defined locally
				return URI.from(textModel.uri);
			}

			// Try to get definition for this symbol
			const definitions = await Promise.all(
				definitionProviders.map(async (provider) => {
					try {
						return await provider.provideDefinition(
							textModel,
							position,
							CancellationToken.None
						);
					} catch (e) {
						return undefined;
					}
				})
			);

			// Find first valid definition
			for (const def of definitions) {
				if (!def) {
					continue;
				}

				// Handle LocationLink[] or Location[]
				// Definition can be Location, Location[], or LocationLink[]
				const locations: (Location | LocationLink)[] = Array.isArray(def)
					? def
					: [def];

				for (const location of locations) {
					if (!location) {
						continue;
					}

					// LocationLink and Location both have uri and range
					const uri = location.uri;
					if (uri) {
						const definitionUri = URI.from(uri);
						// If definition is in different file, use that as origin
						if (definitionUri.toString() !== textModel.uri.toString()) {
							return definitionUri;
						}
					}
				}
			}

			// If definition is in same file or not found, use current file
			return URI.from(textModel.uri);
		} catch (e) {
			// On error, assume it's defined locally
			console.warn("[DocsAgent] Failed to resolve symbol origin:", e);
			return URI.from(textModel.uri);
		}
	}

	private hasCooldownExpired(fileUri: string): boolean {
		const lastChange = this.lastChangeTimestamps.get(fileUri);
		if (!lastChange) {
			return true; // No previous change, allow regeneration
		}
		return Date.now() - lastChange >= this.COOLDOWN_MS;
	}

	private getRelativePath(uri: URI): string | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return uri.fsPath; // Fallback to absolute
		}

		const rootPath = workspace.folders[0].uri.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, "");
		}

		return absolutePath;
	}

	override dispose(): void {
		super.dispose();
	}
}

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench
);
workbenchRegistry.registerWorkbenchContribution(
	DocsAgentContribution,
	LifecyclePhase.Restored
);
