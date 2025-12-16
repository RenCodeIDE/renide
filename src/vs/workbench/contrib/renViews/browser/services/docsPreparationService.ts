/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	joinPath,
	relativePath,
	dirname as resourceDirname,
} from '../../../../../base/common/resources.js';
import { extname, basename } from '../../../../../base/common/path.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IMerkleTreeService, MerkleTreeNode } from '../../../../../platform/merkleTree/common/merkleTreeService.js';
import { FileChunk } from '../../../../../platform/merkleTree/common/merkleTreeTypes.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDocsService, FileDocs } from './docsService.js';
import { IChunkIndexService, ChunkRecord } from './chunkIndexService.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Location, LocationLink } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Emitter } from '../../../../../base/common/event.js';

export const IDocsPreparationService = createDecorator<IDocsPreparationService>('docsPreparationService');

export interface IDocsPreparationService {
	readonly _serviceBrand: undefined;
	prepareWorkspace(force?: boolean): Promise<void>;
	prepareFile(uri: URI): Promise<void>;
}

export class DocsPreparationService
	extends Disposable
	implements IDocsPreparationService
{
	declare readonly _serviceBrand: undefined;

	private static readonly BINARY_EXTENSIONS = new Set<string>([
		// Image formats
		'.jpg',
		'.jpeg',
		'.png',
		'.gif',
		'.bmp',
		'.webp',
		'.svg',
		'.ico',
		'.tiff',
		'.tif',
		// Media files
		'.mp4',
		'.mp3',
		'.avi',
		'.mov',
		'.wav',
		'.ogg',
		'.flac',
		// Archives
		'.zip',
		'.tar',
		'.gz',
		'.rar',
		'.7z',
		'.bz2',
		// Executables
		'.exe',
		'.dll',
		'.so',
		'.dylib',
		'.bin',
		// Documents
		'.pdf',
		'.doc',
		'.docx',
		'.xls',
		'.xlsx',
		'.ppt',
		'.pptx',
		// Fonts
		'.woff',
		'.woff2',
		'.ttf',
		'.otf',
		'.eot',
	]);

	private static readonly BINARY_FILENAMES = new Set<string>([
		'.ds_store',
		'thumbs.db',
	]);

	private lastProcessedRootHash: string | undefined;
	private processingQueue: Promise<void> = Promise.resolve();
	private readonly onWillProcessFileEmitter = new Emitter<URI>();
	readonly onWillProcessFile = this.onWillProcessFileEmitter.event;

	constructor(
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IDocsService private readonly docsService: IDocsService,
		@IChunkIndexService private readonly chunkIndexService: IChunkIndexService,
		@IOutlineModelService private readonly outlineModelService: IOutlineModelService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(
			this.merkleTreeService.onDidChangeTree(async ({ newHash }) => {
				await this.prepareWorkspace(false, newHash);
			})
		);
		this._register(toDisposable(() => this.onWillProcessFileEmitter.dispose()));
	}

	prepareWorkspace(force = false, targetRootHash?: string): Promise<void> {
		this.processingQueue = this.processingQueue
			.then(() => this.prepareWorkspaceInternal(force, targetRootHash))
			.catch((error) => {
				this.logService.error(`[DocsPrep] Failed to prepare workspace docs: ${error}`);
			});
		return this.processingQueue;
	}

	async prepareFile(uri: URI): Promise<void> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			return;
		}


		await this.processFileUri(uri, workspaceRoot);
	}

	private async prepareWorkspaceInternal(force: boolean, targetRootHash?: string): Promise<void> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			this.logService.warn('[DocsPrep] Skipping workspace preparation because no workspace folder is open');
			return;
		}

		let tree: MerkleTreeNode;
		try {
			tree = await this.merkleTreeService.getTree();
		} catch (error) {
			this.logService.warn(`[DocsPrep] Unable to fetch Merkle tree: ${error}`);
			return;
		}

		if (!force && this.lastProcessedRootHash === tree.hash) {
			return;
		}

		if (targetRootHash && tree.hash !== targetRootHash) {
			// Tree updated again, defer to next invocation.
			return;
		}

		this.lastProcessedRootHash = tree.hash;
		this.logService.info(`[DocsPrep] Preparing documentation for workspace. Root hash ${tree.hash.substring(0, 16)}...`);

		await this.processNode(tree, workspaceRoot);
	}

	private async processNode(node: MerkleTreeNode, workspaceRoot: URI): Promise<void> {
		if (node.type === 'file') {
			// Skip virtual URIs from JSON Schema registry (e.g., /lm/tool/*, /schemas-associations.json, etc.)
			if (this.isVirtualPath(node.path)) {
				return;
			}
			const fileUri = this.toWorkspaceUri(node.path, workspaceRoot);
			await this.processFileNode(node, fileUri);
		}

		if (node.children) {
			for (const child of node.children) {
				await this.processNode(child, workspaceRoot);
			}
		}
	}

	/**
	 * Check if a path is a virtual schema path from the JSON Schema registry.
	 * These paths (e.g., /lm/tool/*, /schemas-associations.json) are not real files.
	 */
	private isVirtualPath(path: string): boolean {
		const normalizedPath = path.startsWith('/') ? path : `/${path}`;
		// Virtual schema paths from JSON Schema registry
		const virtualPatterns = [
			'/lm/',           // Language model tool schemas
			'/settings/',     // Virtual settings paths
			'/schemas-associations.json',
			'/toolsets',
			'/keybindings',
			'/inlineCompletionProviderIdArgs',
			'/vscode-extensions',
			'/launch',
		];
		return virtualPatterns.some(pattern => normalizedPath.startsWith(pattern));
	}

	private isBinaryFile(uri: URI): boolean {
		const path = uri.path.toLowerCase();
		const extension = extname(path).toLowerCase();
		const filename = basename(path).toLowerCase();

		// Check if the filename itself is a known binary file (e.g., .DS_Store)
		if (DocsPreparationService.BINARY_FILENAMES.has(filename)) {
			return true;
		}

		// Check if the extension indicates a binary file
		if (extension && DocsPreparationService.BINARY_EXTENSIONS.has(extension)) {
			return true;
		}

		return false;
	}

	private async processFileNode(node: MerkleTreeNode, fileUri: URI): Promise<void> {
		try {
			this.onWillProcessFileEmitter.fire(fileUri);

			// Skip binary files early to avoid processing errors
			if (this.isBinaryFile(fileUri)) {
				this.logService.debug(`[DocsPrep] Skipping binary file: ${node.path}`);
				return;
			}

			const relativePath = node.path;
			const fileChunks = node.chunks ?? (await this.merkleTreeService.getFileChunks(relativePath)) ?? [];
			if (fileChunks.length === 0) {
				this.logService.debug(`[DocsPrep] No chunks available for ${relativePath}, skipping`);
				return;
			}

			const storedChunks = await this.chunkIndexService.getChunksForFile(fileUri);
			const storedHashes = storedChunks.map((chunk) => chunk.hash);
			const currentHashes = fileChunks.map((chunk) => chunk.hash);
			const hashesChanged =
				storedHashes.length !== currentHashes.length ||
				currentHashes.some((hash, index) => hash !== storedHashes[index]);

			if (hashesChanged) {
				this.logService.info(
					`[DocsPrep] Chunk hashes changed for ${relativePath}. Rebuilding metadata and documentation.`
				);
				await this.chunkIndexService.removeChunksForFile(fileUri);
				await this.createChunkMetadata(fileUri, fileChunks, node.fileHash ?? node.hash);
				const mode = storedHashes.length > 0 ? 'regenerate' : 'initialize';
				const doc = await this.docsService.generateDocsForFile(fileUri, mode);
				if (doc) {
					await this.logDocGeneration(relativePath, doc);
				}
			} else {
				const existingDoc = this.docsService.getFileDocs(fileUri);
				if (!existingDoc) {
					this.logService.info(
						`[DocsPrep] No existing documentation for ${relativePath}. Generating initial docs.`
					);
					const doc = await this.docsService.generateDocsForFile(fileUri, 'initialize');
					if (doc) {
						await this.logDocGeneration(relativePath, doc);
					}
				}
			}
		} catch (error) {
			this.logService.warn(`[DocsPrep] Failed to process ${node.path}: ${error}`);
		}
	}

	private async createChunkMetadata(
		fileUri: URI,
		chunks: FileChunk[],
		fileHash?: string
	): Promise<void> {
		const fileContent = await this.fileService.readFile(fileUri);
		const fileLines = fileContent.value.toString().split(/\r?\n/);
		const parentHash = fileHash;

		for (let index = 0; index < chunks.length; index++) {
			const fileChunk = chunks[index];
			const symbols = await this.extractSymbolsForRange(
				fileUri,
				fileChunk.startLine,
				fileChunk.endLine
			);

			const chunkLines = fileLines.slice(fileChunk.startLine, fileChunk.endLine);
			const includeUris = this.extractIncludeDependencies(fileUri, chunkLines);

			const referencedFiles = new Map<string, URI>();
			for (const uri of includeUris) {
				referencedFiles.set(uri.toString(), uri);
			}

			for (const symbol of symbols) {
				if (symbol.uri && symbol.uri.toString() !== fileUri.toString()) {
					referencedFiles.set(symbol.uri.toString(), symbol.uri);
				}
			}

			const functionPointers =
				symbols
					.filter((symbol) => {
						const kind = symbol.kind.toLowerCase();
						return kind.includes('function') || kind.includes('method') || kind.includes('class');
					})
					.map((symbol) => ({
						name: symbol.name,
						uri: symbol.uri,
						range: symbol.range,
					})) ?? [];

			const chunk: ChunkRecord = {
				uri: fileUri,
				hash: fileChunk.hash,
				parentHash,
				ordinal: index,
				description: `Chunk ${index + 1} (lines ${fileChunk.startLine + 1}-${fileChunk.endLine})`,
				range: new Range(fileChunk.startLine + 1, 1, fileChunk.endLine, 1),
				refs: {
					symbols,
					files: Array.from(referencedFiles.values()),
					functions: functionPointers,
				},
				updatedAt: Date.now(),
			};

			await this.chunkIndexService.upsertChunk(chunk);
			this.logService.info(
				`[DocsPrep] Stored chunk hash for ${fileUri.fsPath} [${fileChunk.startLine + 1}-${fileChunk.endLine}]: ${fileChunk.hash.substring(0, 12)}...`
			);
		}
	}

	private async extractSymbolsForRange(
		uri: URI,
		startLine: number,
		endLine: number
	): Promise<ChunkRecord['refs']['symbols']> {
		const reference = await this.textModelService.createModelReference(uri);
		try {
			const textModel = reference.object.textEditorModel;
			const outline = await this.outlineModelService.getOrCreate(textModel, CancellationToken.None);
			const topLevelSymbols = outline.getTopLevelSymbols();

			const symbols: ChunkRecord['refs']['symbols'] = [];
			for (const symbol of topLevelSymbols) {
				if (
					symbol.range.startLineNumber >= startLine + 1 &&
					symbol.range.endLineNumber <= endLine + 1
				) {
					const symbolPosition = new Position(symbol.selectionRange.startLineNumber, symbol.selectionRange.startColumn);
					const originUri = await this.resolveSymbolOrigin(textModel, symbolPosition);

					symbols.push({
						name: symbol.name,
						kind: symbol.kind.toString(),
						uri: originUri,
						range: symbol.range,
					});
				}
			}
			return symbols;
		} finally {
			reference.dispose();
		}
	}

	private extractIncludeDependencies(fileUri: URI, chunkLines: string[]): URI[] {
		const includePattern = /^\s*#\s*include\s+([<"])([^">]+)[">]/;
		const dependencies = new Map<string, URI>();
		const baseDir = resourceDirname(fileUri);

		for (const line of chunkLines) {
			const match = includePattern.exec(line);
			if (!match) {
				continue;
			}

			const delimiter = match[1];
			const target = match[2].trim();
			if (!target) {
				continue;
			}

			if (delimiter === '"') {
				const segments = target.split('/').filter((segment) => segment.length > 0);
				try {
					const resolved = joinPath(baseDir, ...segments);
					dependencies.set(resolved.toString(), resolved);
				} catch (error) {
					this.logService.debug(
						`[DocsPrep] Failed to resolve include ${target} for ${fileUri.toString(true)}: ${error}`
					);
				}
			} else {
				const systemUri = URI.from({
					scheme: 'sysinclude',
					path: `/${target}`,
				});
				dependencies.set(systemUri.toString(), systemUri);
			}
		}

		return Array.from(dependencies.values());
	}

	private async resolveSymbolOrigin(textModel: ITextModel, position: Position): Promise<URI> {
		const definitionProviders = this.languageFeaturesService.definitionProvider.all(textModel);
		for (const provider of definitionProviders) {
			try {
				const result = await provider.provideDefinition(textModel, position, CancellationToken.None);
				const linkArray: readonly (Location | LocationLink)[] = Array.isArray(result)
					? result
					: result
						? [result as Location]
						: [];

				for (const link of linkArray) {
					if (link && (link as Location).uri) {
						return (link as Location).uri;
					}
				}
			} catch (error) {
				this.logService.debug(`[DocsPrep] Definition provider failed: ${error}`);
			}
		}

		return textModel.uri;
	}

	private async logDocGeneration(relativePath: string, doc: FileDocs): Promise<void> {
		try {
			const docHash = await this.hashString(doc.content);
			this.logService.info(
				`[DocsPrep] Generated documentation for ${relativePath}. Doc hash ${docHash.substring(0, 16)}..., generated at ${new Date(doc.generatedAt).toISOString()}`
			);
		} catch (error) {
			this.logService.warn(`[DocsPrep] Failed to compute documentation hash for ${relativePath}: ${error}`);
		}
	}

	private async hashString(input: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(input);

		if (typeof process !== 'undefined' && process.versions && process.versions.node) {
			try {
				const nodeCrypto = await import('crypto');
				return nodeCrypto.createHash('sha256').update(data).digest('hex');
			} catch {
				// Fallback to web crypto
			}
		}

		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	private toWorkspaceUri(relativePath: string, workspaceRoot: URI): URI {
		const segments = relativePath.split(/[\\/]+/).filter((segment) => !!segment);
		let uri = workspaceRoot;
		for (const segment of segments) {
			uri = joinPath(uri, segment);
		}
		return uri;
	}

	private getRelativePath(fileUri: URI, workspaceRoot: URI): string {
		return relativePath(workspaceRoot, fileUri) ?? fileUri.path;
	}

	private async processFileUri(fileUri: URI, workspaceRoot: URI): Promise<void> {
		const relative = this.getRelativePath(fileUri, workspaceRoot);
		let node: MerkleTreeNode | undefined;

		try {
			const tree = await this.merkleTreeService.getTree();
			node = this.findNodeByPath(tree, relative);
		} catch (error) {
			this.logService.debug(`[DocsPrep] Failed to fetch Merkle tree for ${relative}: ${error}`);
		}

		if (!node) {
			const chunks = await this.merkleTreeService.getFileChunks(relative);
			if (!chunks) {
				this.logService.debug(`[DocsPrep] No Merkle tree data available for ${relative}`);
				return;
			}

			node = {
				hash: '',
				path: relative,
				type: 'file',
				chunks,
			};
		}

		await this.processFileNode(node, fileUri);
	}

	private findNodeByPath(node: MerkleTreeNode, relativePath: string): MerkleTreeNode | undefined {
		if (node.path === relativePath) {
			return node;
		}

		if (!node.children) {
			return undefined;
		}

		for (const child of node.children) {
			const found = this.findNodeByPath(child, relativePath);
			if (found) {
				return found;
			}
		}

		return undefined;
	}

	private getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		if (folders.length > 1) {
			this.logService.warn('[DocsPrep] Multiple workspace folders detected. Using the first folder for documentation preparation.');
		}
		return folders[0].uri;
	}
}

registerSingleton(IDocsPreparationService, DocsPreparationService, InstantiationType.Delayed);

