/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ISearchService, IFileQuery, QueryType, ISearchConfiguration, getExcludes } from '../../../../services/search/common/search.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';
import { IMerkleTreeService } from '../../../../../platform/merkleTree/common/merkleTreeService.js';
import { IChunkIndexService, ChunkRecord } from '../../../../contrib/renViews/browser/services/chunkIndexService.js';
import { IDocsService } from '../../../../contrib/renViews/browser/services/docsService.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Location, LocationLink } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';

export const GetDocsToolData: IToolData = {
	id: 'get_docs',
	toolReferenceName: 'getDocs',
	displayName: localize('getDocsTool.displayName', 'Get Documentation'),
	modelDescription: localize('getDocsTool.modelDescription', 'Retrieves generated documentation for a code file. The documentation is automatically generated from the file\'s code and provides explanations of functions, classes, and other symbols. Supports both full paths/URIs and filenames. When given a filename, searches recursively across the entire workspace with fuzzy matching. If multiple matches are found, returns a list for you to choose from.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			uri: {
				type: 'string',
				description: localize('getDocsTool.uri', 'The URI, file path, or filename to get documentation for. Can be a full path/URI or just a filename. If a filename is provided, the tool will search the workspace recursively with fuzzy matching.')
			},
			regenerate: {
				type: 'boolean',
				description: localize('getDocsTool.regenerate', 'Optional: Force regeneration of documentation even if it already exists. Default is false.')
			}
		},
		required: ['uri']
	}
};

export interface IGetDocsToolInput {
	uri: string;
	regenerate?: boolean;
}

export class GetDocsTool implements IToolImpl {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IChunkIndexService private readonly chunkIndexService: IChunkIndexService,
		@IDocsService private readonly docsService: IDocsService,
		@IOutlineModelService private readonly outlineModelService: IOutlineModelService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as IGetDocsToolInput;

		const displayPath = this.isFullPath(args.uri)
			? this.parseUri(args.uri).fsPath
			: args.uri;

		return {
			invocationMessage: localize('getDocsTool.invocationMessage', 'Getting documentation for: {0}', displayPath),
			pastTenseMessage: localize('getDocsTool.pastTenseMessage', 'Retrieved documentation for: {0}', displayPath),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as IGetDocsToolInput;

		try {
			// Check if input is a full path/URI or just a filename
			if (this.isFullPath(args.uri)) {
				const uri = this.parseUri(args.uri);
				return await this.getDocsByUri(uri, args.regenerate ?? false, token);
			} else {
				// Filename - search workspace for matches
				const matches = await this.searchFilesByName(args.uri, token);

				if (matches.length === 0) {
					return {
						content: [{
							kind: 'text',
							value: localize('getDocsTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
						}],
						toolResultMessage: localize('getDocsTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', args.uri)
					};
				} else if (matches.length === 1) {
					return await this.getDocsByUri(matches[0], args.regenerate ?? false, token);
				} else {
					// Multiple matches - return list for model to choose
					const workspace = this.workspaceService.getWorkspace();
					const matchList = matches.map((uri, index) => {
						const relativePath = workspace.folders.length > 0
							? this.getRelativePath(uri, workspace.folders[0].uri)
							: uri.fsPath;
						return `${index + 1}. ${relativePath}`;
					}).join('\n');

					const fullMessage = localize('getDocsTool.multipleMatches', 'Found {0} files matching "{1}":\n\n{2}\n\nPlease specify which file to get documentation for by providing the full path or a more specific filename.', matches.length, args.uri, matchList);
					return {
						content: [{
							kind: 'text',
							value: fullMessage
						}],
						toolResultMessage: localize('getDocsTool.multipleMatchesShort', 'Found {0} files matching "{1}". Please specify which file to get documentation for.', matches.length, args.uri)
					};
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error(`[GetDocsTool] Error getting docs for ${args.uri}:`, error);
			return {
				content: [{
					kind: 'text',
					value: localize('getDocsTool.error', 'Error getting documentation for {0}: {1}', args.uri, errorMessage)
				}],
				toolResultMessage: localize('getDocsTool.error', 'Error getting documentation for {0}: {1}', args.uri, errorMessage)
			};
		}
	}

	private async getDocsByUri(uri: URI, regenerate: boolean, token: CancellationToken): Promise<IToolResult> {
		// Check if file exists
		const exists = await this.fileService.exists(uri);
		if (!exists) {
			return {
				content: [{
					kind: 'text',
					value: localize('getDocsTool.fileNotFound', 'File not found: {0}', uri.fsPath)
				}],
				toolResultMessage: localize('getDocsTool.fileNotFound', 'File not found: {0}', uri.fsPath)
			};
		}

		try {
			// Ensure chunks exist (for metadata)
			await this.ensureChunksForFile(uri, token);

			// Check if docs exist
			const existingDocs = this.docsService.getFileDocs(uri);

			// Generate docs if missing or if regeneration is requested
			if (!existingDocs || regenerate) {
				this.logService.info(`[GetDocsTool] Generating docs for ${uri.fsPath}, mode: ${regenerate ? 'regenerate' : 'initialize'}`);
				await this.docsService.generateDocsForFile(uri, regenerate ? 'regenerate' : 'initialize');
			}

			// Get docs (either existing or newly generated)
			const fileDocs = this.docsService.getFileDocs(uri);

			if (!fileDocs) {
				return {
					content: [{
						kind: 'text',
						value: localize('getDocsTool.noDocs', 'Documentation could not be generated for {0}. The file may not be accessible or may not contain any code.', uri.fsPath)
					}],
					toolResultMessage: localize('getDocsTool.noDocs', 'Documentation could not be generated for {0}.', uri.fsPath)
				};
			}

			// Return the documentation content
			return {
				content: [{
					kind: 'text',
					value: fileDocs.content
				}],
				toolResultMessage: localize('getDocsTool.success', 'Retrieved documentation for {0}', uri.fsPath)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error(`[GetDocsTool] Error processing docs for ${uri.fsPath}:`, error);
			return {
				content: [{
					kind: 'text',
					value: localize('getDocsTool.processingError', 'Error processing documentation for {0}: {1}', uri.fsPath, errorMessage)
				}],
				toolResultMessage: localize('getDocsTool.processingError', 'Error processing documentation for {0}: {1}', uri.fsPath, errorMessage)
			};
		}
	}

	private async ensureChunksForFile(uri: URI, token: CancellationToken): Promise<void> {
		// Check if chunks already exist
		const existingChunks = this.chunkIndexService.listFileChunks(uri);
		if (existingChunks.length > 0) {
			this.logService.debug(`[GetDocsTool] Chunks already exist for ${uri.fsPath}`);
			return;
		}

		// Get relative path for Merkle tree
		const relativePath = this.getRelativePath(uri);
		if (!relativePath) {
			this.logService.warn(`[GetDocsTool] Could not determine relative path for ${uri.fsPath}`);
			return;
		}

		// Ensure file is tracked in Merkle tree
		await this.merkleTreeService.ensureTracked(uri);

		// Get chunks from Merkle tree
		let fileChunks = await this.merkleTreeService.getFileChunks(relativePath);

		// If no chunks, retry with invalidation (max 3 retries)
		if (!fileChunks || fileChunks.length === 0) {
			const maxRetries = 3;
			let retryDelay = 100;

			for (let attempt = 0; attempt < maxRetries; attempt++) {
				this.logService.debug(`[GetDocsTool] No chunks found for ${relativePath}, retry ${attempt + 1}/${maxRetries}`);

				// Invalidate path to force recalculation
				await this.merkleTreeService.invalidatePath(uri);

				// Ensure file is tracked again
				await this.merkleTreeService.ensureTracked(uri);

				// Wait with exponential backoff
				await new Promise(resolve => setTimeout(resolve, retryDelay));

				// Retry getting chunks
				fileChunks = await this.merkleTreeService.getFileChunks(relativePath);

				if (fileChunks && fileChunks.length > 0) {
					this.logService.debug(`[GetDocsTool] Successfully got chunks for ${relativePath} after ${attempt + 1} retry(ies)`);
					break;
				}

				retryDelay *= 2; // Exponential backoff: 100ms -> 200ms -> 400ms
			}

			if (!fileChunks || fileChunks.length === 0) {
				this.logService.warn(`[GetDocsTool] Failed to get chunks for ${relativePath} after ${maxRetries} retries`);
				return;
			}
		}

		// Create chunk metadata
		for (let i = 0; i < fileChunks.length; i++) {
			const fileChunk = fileChunks[i];

			// Extract symbols for this chunk range
			const symbols = await this.extractSymbolsForRange(
				uri,
				fileChunk.startLine,
				fileChunk.endLine,
				token
			);

			const chunk: ChunkRecord = {
				uri,
				hash: fileChunk.hash,
				parentHash: fileChunk.parentHash,
				description: `Chunk ${i + 1} (lines ${fileChunk.startLine + 1}-${fileChunk.endLine})`,
				ordinal: i,
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

		this.logService.debug(`[GetDocsTool] Created ${fileChunks.length} chunk(s) for ${uri.fsPath}`);
	}

	private async extractSymbolsForRange(
		uri: URI,
		startLine: number,
		endLine: number,
		token: CancellationToken
	): Promise<ChunkRecord['refs']['symbols']> {
		try {
			const reference = await this.textModelService.createModelReference(uri);
			try {
				const textModel = reference.object.textEditorModel;
				const outline = await this.outlineModelService.getOrCreate(
					textModel,
					token
				);
				const topLevelSymbols = outline.getTopLevelSymbols();

				const symbols: ChunkRecord['refs']['symbols'] = [];
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
							symbolPosition,
							token
						);

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
		} catch (e) {
			this.logService.warn(`[GetDocsTool] Failed to extract symbols:`, e);
			return [];
		}
	}

	private async resolveSymbolOrigin(
		textModel: ITextModel,
		position: Position,
		token: CancellationToken
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
							token
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
			this.logService.warn(`[GetDocsTool] Failed to resolve symbol origin:`, e);
			return URI.from(textModel.uri);
		}
	}

	private isFullPath(uriString: string): boolean {
		// Check if it's a URI
		if (uriString.includes('://') || uriString.startsWith('file://')) {
			return true;
		}

		// Check if it's an absolute path
		if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
			return true;
		}

		// Check if it contains path separators (likely a relative path, not just a filename)
		if (uriString.includes('/') || (isWindows && uriString.includes('\\'))) {
			return true;
		}

		// Otherwise, treat as a filename
		return false;
	}

	private parseUri(uriString: string): URI {
		try {
			// Try parsing as URI first
			if (uriString.includes('://') || uriString.startsWith('file://')) {
				return URI.parse(uriString);
			}

			// If it's a relative path, try to resolve it relative to workspace
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri;
				// Check if it's already an absolute path
				if (uriString.startsWith('/') || (isWindows && /^[A-Za-z]:/.test(uriString))) {
					return URI.file(uriString);
				}
				// Relative path - resolve against workspace root
				return URI.joinPath(workspaceRoot, uriString);
			}

			// Fallback to file URI
			return URI.file(uriString);
		} catch {
			// If parsing fails, treat as file path
			return URI.file(uriString);
		}
	}

	private fuzzyMatchingGlobPattern(pattern: string): string {
		if (!pattern) {
			return '*';
		}
		return '*' + pattern.split('').join('*') + '*';
	}

	private caseInsensitiveGlobPattern(pattern: string): string {
		let caseInsensitiveFilePattern = '';
		for (let i = 0; i < pattern.length; i++) {
			const char = pattern[i];
			if (/[a-zA-Z]/.test(char)) {
				caseInsensitiveFilePattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
			} else {
				caseInsensitiveFilePattern += char;
			}
		}
		return caseInsensitiveFilePattern;
	}

	private async searchFilesByName(pattern: string, token: CancellationToken): Promise<URI[]> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}

		// Create fuzzy matching pattern
		const fuzzyPattern = this.fuzzyMatchingGlobPattern(pattern);
		const caseInsensitivePattern = this.caseInsensitiveGlobPattern(fuzzyPattern);

		// Search across all workspace folders
		const allMatches: URI[] = [];
		const maxResults = 50; // Limit to avoid performance issues

		for (const folder of workspace.folders) {
			const searchExcludePattern = getExcludes(this.configurationService.getValue<ISearchConfiguration>({ resource: folder.uri })) || {};
			const disregardIgnoreFiles = this.configurationService.getValue<boolean>('explorer.excludeGitIgnore');

			const searchOptions: IFileQuery = {
				folderQueries: [{
					folder: folder.uri,
					disregardIgnoreFiles,
				}],
				type: QueryType.File,
				shouldGlobMatchFilePattern: true,
				excludePattern: searchExcludePattern,
				sortByScore: true,
				maxResults,
				filePattern: `**/${caseInsensitivePattern}`
			};

			try {
				const searchResult = await this.searchService.fileSearch(searchOptions, token);
				if (token.isCancellationRequested) {
					break;
				}

				const fileResources = searchResult.results.map(result => result.resource);
				allMatches.push(...fileResources);

				// Stop if we've reached the limit
				if (allMatches.length >= maxResults) {
					break;
				}
			} catch (e) {
				// Continue with other folders if one fails
				if (token.isCancellationRequested) {
					break;
				}
			}
		}

		// Remove duplicates and limit results
		const uniqueMatches = Array.from(new Set(allMatches.map(uri => uri.toString())))
			.map(uriString => URI.parse(uriString))
			.slice(0, maxResults);

		return uniqueMatches;
	}

	private getRelativePath(uri: URI, workspaceRoot?: URI): string | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return uri.fsPath; // Fallback to absolute
		}

		const rootUri = workspaceRoot || workspace.folders[0].uri;
		const rootPath = rootUri.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, "");
		}

		return absolutePath;
	}
}

