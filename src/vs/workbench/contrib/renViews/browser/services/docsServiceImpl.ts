import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import { IDocsService, FileDocs, DirectoryDocs } from "./docsService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../platform/storage/common/storage.js";
import { URI } from "../../../../../base/common/uri.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import {
	IRequestService,
	isSuccess,
	asJson,
} from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { IProductService } from "../../../../../platform/product/common/productService.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { env } from "../../../../../base/common/process.js";
import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { streamToBuffer } from "../../../../../base/common/buffer.js";
import {
	ITextModelService,
	IResolvedTextEditorModel,
} from "../../../../../editor/common/services/resolverService.js";
import { ILanguageFeaturesService } from "../../../../../editor/common/services/languageFeatures.js";
import { SymbolKind } from "../../../../../editor/common/languages.js";
import { IRange } from "../../../../../editor/common/core/range.js";
import { IReference } from "../../../../../base/common/lifecycle.js";
import { ITextModel } from "../../../../../editor/common/model.js";
import { basename, extname } from "../../../../../base/common/resources.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { computeWorkspaceHashSync } from "./workspaceHash.js";
import { IRenWorkspaceStore } from "../../common/renWorkspaceStore.js";
import { IMerkleTreeService } from "../../../../../platform/merkleTree/common/merkleTreeService.js";

const STORAGE_KEY = "ren.docs.latest";
const STORAGE_KEY_PREFIX_FILE = "ren.docs.file.";
const STORAGE_KEY_PREFIX_DIRECTORY = "ren.docs.directory.";
const REN_AUTH_STORAGE_KEYS = {
	ACCESS_TOKEN: "ren.auth.accessToken",
};

function getFileStorageKey(uri: URI): string {
	return `${STORAGE_KEY_PREFIX_FILE}${uri.toString()}`;
}

function getDirectoryStorageKey(uri: URI): string {
	return `${STORAGE_KEY_PREFIX_DIRECTORY}${uri.toString()}`;
}

export class DocsService extends Disposable implements IDocsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateDocs = this._register(new Emitter<string>());
	readonly onDidUpdateDocs = this._onDidUpdateDocs.event;

	private readonly _onDidUpdateFileDocs = this._register(
		new Emitter<FileDocs>()
	);
	readonly onDidUpdateFileDocs = this._onDidUpdateFileDocs.event;

	private readonly _onDidUpdateDirectoryDocs = this._register(
		new Emitter<DirectoryDocs>()
	);
	readonly onDidUpdateDirectoryDocs = this._onDidUpdateDirectoryDocs.event;

	private latest: string | undefined;
	private fileDocsCache: Map<string, FileDocs> = new Map();
	private directoryDocsCache: Map<string, DirectoryDocs> = new Map();
	private cachedProjectHash: string | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService
		private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILanguageFeaturesService
		private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService
	) {
		super();
		this.latest = this.storageService.get(
			STORAGE_KEY,
			StorageScope.WORKSPACE,
			undefined
		);
	}

	/**
	 * Get or compute the project hash for the current workspace.
	 * Uses the first workspace folder's URI to generate a consistent hash.
	 */
	private getProjectHash(): string | undefined {
		if (this.cachedProjectHash) {
			return this.cachedProjectHash;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		// Use the first workspace folder as the project identifier
		const workspaceRoot = folders[0].uri;
		this.cachedProjectHash = computeWorkspaceHashSync(workspaceRoot);
		this.logService.debug(
			`[DocsService] Computed project hash: ${this.cachedProjectHash} for workspace: ${workspaceRoot.fsPath}`
		);

		return this.cachedProjectHash;
	}

	/**
	 * Get relative path from URI to workspace root
	 */
	private getRelativePath(uri: URI): string | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const workspaceRoot = folders[0].uri.fsPath;
		const absolutePath = uri.fsPath;
		if (absolutePath.startsWith(workspaceRoot)) {
			return absolutePath.slice(workspaceRoot.length).replace(/^[/\\]+/, "");
		}
		return undefined;
	}

	/**
	 * Get file hash from Merkle tree service.
	 * Uses the file-level hash (aggregate of all chunks) for consistency with database storage.
	 * Falls back to computing hash from first chunk if file hash not available.
	 */
	private async getFileHashFromMerkleTree(
		uri: URI
	): Promise<string | undefined> {
		try {
			const relativePath = this.getRelativePath(uri);
			if (!relativePath) {
				this.logService.debug(
					`[DocsService] Cannot get relative path for ${uri.fsPath}, cannot use Merkle tree hash`
				);
				return undefined;
			}

			// Ensure file is tracked in Merkle tree
			await this.merkleTreeService.ensureTracked(uri);

			// Try to get file-level hash first (aggregate of all chunks)
			let hash = await this.merkleTreeService.getPathHash(relativePath);
			if (hash) {
				this.logService.debug(
					`[DocsService] Got file hash from Merkle tree for ${relativePath}: ${hash.substring(
						0,
						8
					)}...`
				);
				return hash;
			}

			// Fallback: get chunks and use first chunk's hash
			// This matches what's stored in database for single-chunk file docs
			const fileChunks = await this.merkleTreeService.getFileChunks(
				relativePath
			);
			if (fileChunks && fileChunks.length > 0) {
				const chunkHash = fileChunks[0].hash;
				this.logService.debug(
					`[DocsService] Using first chunk hash from Merkle tree for ${relativePath}: ${chunkHash.substring(
						0,
						8
					)}...`
				);
				return chunkHash;
			}

			this.logService.warn(
				`[DocsService] No Merkle tree data available for ${relativePath}`
			);
			return undefined;
		} catch (error) {
			this.logService.warn(
				`[DocsService] Failed to get hash from Merkle tree for ${uri.fsPath}:`,
				error
			);
			return undefined;
		}
	}

	/**
	 * Generate a chunk ID from a file URI.
	 * Uses the file path relative to workspace or absolute path as a stable identifier.
	 */
	private getChunkIdFromUri(uri: URI): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const workspaceRoot = folders[0].uri.fsPath;
			if (uri.fsPath.startsWith(workspaceRoot)) {
				// Use relative path for consistency
				return uri.fsPath.substring(workspaceRoot.length).replace(/^[/\\]/, "");
			}
		}
		// Fall back to absolute path
		return uri.fsPath;
	}

	private async getFileContent(uri: URI): Promise<string> {
		try {
			const fileContent = await this.fileService.readFile(uri);
			return fileContent.value.toString();
		} catch (error) {
			this.logService.error(
				`[DocsService] Failed to read file: ${uri.fsPath}`,
				error
			);
			return "";
		}
	}

	private async getServerAddress(): Promise<string> {
		const serverAddress = env["SERVER_ADDRESS"];

		if (serverAddress) {
			let normalized = serverAddress.trim();
			if (
				!normalized.startsWith("http://") &&
				!normalized.startsWith("https://")
			) {
				normalized = `https://${normalized}`;
			}
			return normalized.replace(/\/+$/, "");
		}

		// Fallback to product.json
		const apiBaseUrl = this.productService.renAccount?.apiBaseUrl;
		if (apiBaseUrl) {
			return apiBaseUrl.replace(/\/+$/, "");
		}

		throw new Error(
			"Server address not configured. Set SERVER_ADDRESS environment variable or configure apiBaseUrl in product.json"
		);
	}

	private normalizeEndpoint(serverAddress: string, endpoint: string): string {
		const normalizedAddress = serverAddress.trim().replace(/\/+$/, "");
		// If serverAddress already ends with /api and endpoint starts with /api/, remove the duplicate /api
		if (normalizedAddress.endsWith("/api") && endpoint.startsWith("/api/")) {
			return `${normalizedAddress}${endpoint.substring(4)}`;
		}
		return `${normalizedAddress}${endpoint}`;
	}

	private async generateFileDocContent(uri: URI): Promise<string> {
		try {
			// Get access token
			const accessToken = await this.secretStorageService.get(
				REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN
			);
			if (!accessToken) {
				this.logService.warn(
					"[DocsService] No access token available, using placeholder content"
				);
				return this.generatePlaceholderContent(uri);
			}

			// Get file content
			const fileContent = await this.getFileContent(uri);
			if (!fileContent.trim()) {
				this.logService.warn(
					`[DocsService] Empty file content for ${uri.fsPath}`
				);
				return this.generatePlaceholderContent(uri);
			}

			// Get server address
			const serverAddress = await this.getServerAddress();
			const endpoint = "/api/bg-agent/generate-docs";
			const url = this.normalizeEndpoint(serverAddress, endpoint);

			// Prepare request payload - send entire file as single chunk
			const fileExtension = uri.path.split(".").pop() || "";
			const language = this.detectLanguage(fileExtension);

			// Collect symbol/state summary to help documentation quality
			const symbolSummary = await this.collectSymbolSummary(uri);

			// Get hash from Merkle tree service (SHA256) to match database storage
			// This ensures hash checking works correctly
			const projectHash = this.getProjectHash();
			const merkleHash = await this.getFileHashFromMerkleTree(uri);
			const chunkId = this.getChunkIdFromUri(uri);

			if (!merkleHash) {
				this.logService.warn(
					`[DocsService] Could not get Merkle tree hash for ${uri.fsPath}, hash checking may not work`
				);
			}

			this.logService.debug(
				`[DocsService] File doc metadata: chunkId=${chunkId}, projectHash=${projectHash}, merkleHash=${merkleHash}`
			);

			const payload = {
				chunks: [
					{
						text: fileContent,
						metadata: {
							filePath: uri.fsPath,
							language: language,
							symbolSummary: symbolSummary,
							// Include hash-checking metadata for server-side deduplication
							merkleHash: merkleHash,
							chunkId: chunkId,
							projectHash: projectHash,
							// userName is extracted from auth token on server side
						},
					},
				],
				options: {
					documentationStyle: "markdown" as const,
				},
			};

			// Make API call
			this.logService.info(
				`[DocsService] Generating docs for file ${uri.fsPath}...`
			);
			const response = await this.requestService.request(
				{
					type: "POST",
					url,
					data: JSON.stringify(payload),
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
					},
				},
				CancellationToken.None
			);

			if (!isSuccess(response)) {
				const errorBuffer = await streamToBuffer(response.stream);
				const errorText = errorBuffer.toString();
				let errorMessage = `Server error: ${response.res.statusCode}`;
				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.message || errorJson.error || errorMessage;
				} catch {
					if (errorText) {
						errorMessage += ` - ${errorText}`;
					}
				}
				this.logService.error(`[DocsService] API call failed: ${errorMessage}`);
				return this.generatePlaceholderContent(uri);
			}

			// Parse response
			const result = await asJson<{
				documentation: string;
				model: string;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					total_tokens: number;
				};
				skipped?: boolean;
				message?: string;
			}>(response);

			if (!result) {
				this.logService.warn(`[DocsService] API returned empty response`);
				return this.generatePlaceholderContent(uri);
			}

			// Check if generation was skipped due to unchanged hash
			if (result.skipped) {
				this.logService.info(
					`[DocsService] Doc generation skipped for ${uri.fsPath}: ${
						result.message || "hash unchanged"
					}`
				);
				// Return cached content if available, otherwise use placeholder
				const cached = this.getFileDocs(uri);
				if (cached?.content) {
					return cached.content;
				}
				return this.generatePlaceholderContent(uri);
			}

			if (result.documentation) {
				this.logService.info(
					`[DocsService] Successfully generated docs for file ${uri.fsPath} (model: ${result.model})`
				);
				return result.documentation;
			}

			this.logService.warn(
				`[DocsService] API response missing documentation field`
			);
			return this.generatePlaceholderContent(uri);
		} catch (error) {
			this.logService.error(`[DocsService] Error generating docs:`, error);
			return this.generatePlaceholderContent(uri);
		}
	}

	private async collectSymbolSummary(uri: URI): Promise<string | undefined> {
		let reference: IReference<IResolvedTextEditorModel> | undefined;
		try {
			reference = await this.textModelService.createModelReference(uri);
			const textModel = reference.object.textEditorModel;
			const providers =
				this.languageFeaturesService.documentSymbolProvider.all(textModel);

			const symbolNodes = await this.getDocumentSymbols(providers, textModel);
			if (!symbolNodes || symbolNodes.length === 0) {
				return undefined;
			}

			const topLevelLines: string[] = [];
			const nestedLines: string[] = [];
			const functionLines: string[] = [];
			const stateLines: string[] = [];

			const visit = (
				symbol: SymbolNode,
				depth: number,
				ancestors: string[]
			): void => {
				const lineSpan = this.formatRange(symbol.range);
				const kindLabel = this.describeSymbolKind(symbol.kind);
				const parentName = ancestors[ancestors.length - 1];

				if (this.isSummarizableSymbol(symbol.kind)) {
					if (depth === 0) {
						const childNames = (symbol.children || [])
							.filter((child) => this.isSummarizableSymbol(child.kind))
							.map((child) => `\`${child.name}\``);
						const childSuffix = childNames.length
							? ` -> children: ${childNames.join(", ")}`
							: "";
						topLevelLines.push(
							`- ${kindLabel} \`${symbol.name}\` (${lineSpan})${childSuffix}`
						);
					} else {
						nestedLines.push(
							`- ${kindLabel} \`${symbol.name}\` (${lineSpan}) inside ${parentName}`
						);
					}
				}

				if (this.isFunctionSymbol(symbol.kind)) {
					const context = parentName ? ` inside ${parentName}` : " (top-level)";
					functionLines.push(
						`- \`${symbol.name}\` (${kindLabel}, ${lineSpan})${context}`
					);
				}

				if (this.isStateSymbol(symbol.kind)) {
					const context = parentName ? `inside ${parentName}` : "top-level";
					stateLines.push(
						`- \`${symbol.name}\` (${kindLabel}, ${lineSpan}) ${context}`
					);
				}

				for (const child of symbol.children || []) {
					visit(child, depth + 1, [...ancestors, symbol.name]);
				}
			};

			for (const symbol of symbolNodes) {
				visit(symbol, 0, []);
			}

			const sections: string[] = [];
			if (topLevelLines.length > 0) {
				sections.push(
					"Top-Level Symbols:\n" + this.joinWithLimit(topLevelLines)
				);
			}
			if (nestedLines.length > 0) {
				sections.push("Nested Symbols:\n" + this.joinWithLimit(nestedLines));
			}
			if (stateLines.length > 0) {
				sections.push("State Candidates:\n" + this.joinWithLimit(stateLines));
			}
			if (functionLines.length > 0) {
				sections.push(
					"Functions & Methods:\n" + this.joinWithLimit(functionLines)
				);
			}

			if (sections.length === 0) {
				return undefined;
			}

			return sections.join("\n\n");
		} catch (error) {
			this.logService.warn(
				"[DocsService] Failed to collect symbol summary for docs:",
				error
			);
			return undefined;
		} finally {
			reference?.dispose();
		}
	}

	private async getDocumentSymbols(
		providers: readonly any[],
		textModel: ITextModel
	): Promise<SymbolNode[] | undefined> {
		let fallback: SymbolNode[] | undefined;
		for (const provider of providers) {
			try {
				const result = await provider.provideDocumentSymbols(
					textModel,
					CancellationToken.None
				);
				if (!result) {
					continue;
				}

				if (Array.isArray(result) && result.length > 0) {
					// DocumentSymbol[] has children property
					if (typeof result[0].children !== "undefined") {
						return result.map((symbol: any) =>
							this.convertDocumentSymbol(symbol)
						);
					}

					// SymbolInformation[] – treat as flat list
					if (!fallback) {
						fallback = result.map((info: any) =>
							this.convertSymbolInformation(info)
						);
					}
				}
			} catch (error) {
				this.logService.debug(
					"[DocsService] document symbol provider failed:",
					error
				);
				continue;
			}
		}
		return fallback;
	}

	private convertDocumentSymbol(symbol: any): SymbolNode {
		return {
			name: symbol.name,
			kind: typeof symbol.kind === "number" ? symbol.kind : SymbolKind.Variable,
			range: symbol.range as IRange,
			children: (symbol.children || []).map((child: any) =>
				this.convertDocumentSymbol(child)
			),
		};
	}

	private convertSymbolInformation(symbol: any): SymbolNode {
		const range = symbol.location?.range || symbol.range;
		return {
			name: symbol.name,
			kind: typeof symbol.kind === "number" ? symbol.kind : SymbolKind.Variable,
			range: range as IRange,
			children: [],
		};
	}

	private formatRange(range: IRange): string {
		if (!range) {
			return "unknown lines";
		}
		const start = range.startLineNumber;
		const end = range.endLineNumber;
		return start === end ? `line ${start}` : `lines ${start}-${end}`;
	}

	private describeSymbolKind(kind: number): string {
		switch (kind) {
			case SymbolKind.Function:
				return "function";
			case SymbolKind.Method:
				return "method";
			case SymbolKind.Constructor:
				return "constructor";
			case SymbolKind.Class:
				return "class";
			case SymbolKind.Interface:
				return "interface";
			case SymbolKind.Module:
				return "module";
			case SymbolKind.Namespace:
				return "namespace";
			case SymbolKind.Enum:
				return "enum";
			case SymbolKind.Variable:
				return "variable";
			case SymbolKind.Constant:
				return "const";
			case SymbolKind.Property:
				return "property";
			case SymbolKind.Field:
				return "field";
			case SymbolKind.TypeParameter:
				return "type";
			default:
				return "symbol";
		}
	}

	private isSummarizableSymbol(kind: number): boolean {
		return (
			this.isFunctionSymbol(kind) ||
			this.isStateSymbol(kind) ||
			kind === SymbolKind.Class ||
			kind === SymbolKind.Interface ||
			kind === SymbolKind.Module ||
			kind === SymbolKind.Namespace ||
			kind === SymbolKind.Enum
		);
	}

	private isFunctionSymbol(kind: number): boolean {
		return (
			kind === SymbolKind.Function ||
			kind === SymbolKind.Method ||
			kind === SymbolKind.Constructor
		);
	}

	private isStateSymbol(kind: number): boolean {
		return (
			kind === SymbolKind.Variable ||
			kind === SymbolKind.Constant ||
			kind === SymbolKind.Property ||
			kind === SymbolKind.Field ||
			kind === SymbolKind.EnumMember
		);
	}

	private joinWithLimit(lines: string[], max = 24): string {
		if (lines.length <= max) {
			return lines.join("\n");
		}
		const sliced = lines.slice(0, max);
		sliced.push(`- ... (+${lines.length - max} more)`);
		return sliced.join("\n");
	}

	private detectLanguage(fileExtension: string): string {
		const extensionMap: Record<string, string> = {
			ts: "typescript",
			tsx: "typescript",
			js: "javascript",
			jsx: "javascript",
			py: "python",
			java: "java",
			go: "go",
			rs: "rust",
			cpp: "cpp",
			c: "c",
			cs: "csharp",
			php: "php",
			rb: "ruby",
			swift: "swift",
			kt: "kotlin",
			md: "markdown",
			json: "json",
			xml: "xml",
			html: "html",
			css: "css",
			scss: "scss",
		};
		return extensionMap[fileExtension.toLowerCase()] || fileExtension;
	}

	private generatePlaceholderContent(uri: URI): string {
		// Fallback placeholder content
		const lines: string[] = [];
		lines.push(`# File Documentation`);
		lines.push("");
		lines.push(`**File:** \`${uri.fsPath}\``);
		lines.push("");
		lines.push(`*Placeholder content - API call failed or not available*`);
		return lines.join("\n");
	}

	getLatestDocs(): string | undefined {
		return this.latest;
	}

	async generateDocs(trigger: "auto" | "manual"): Promise<string> {
		// TODO: Replace with real server call. For now, produce placeholder content.
		const now = new Date().toISOString();
		const content = `Generated docs (${trigger}) at ${now}.\n\nThis is placeholder content.`;
		this.latest = content;
		this.storageService.store(
			STORAGE_KEY,
			content,
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
		this._onDidUpdateDocs.fire(content);
		return content;
	}

	async generateDocsForFile(
		uri: URI,
		mode: "initialize" | "regenerate" = "regenerate"
	): Promise<FileDocs | undefined> {
		this.logService.info(
			`[DocsService] generateDocsForFile called for ${uri.fsPath}, mode: ${mode}`
		);

		// Generate file-level documentation
		const content = await this.generateFileDocContent(uri);
		const fileDoc: FileDocs = {
			uri,
			content,
			format: "markdown",
			generatedAt: Date.now(),
		};

		// Store in cache and storage
		const fileUri = uri.toString();
		this.fileDocsCache.set(fileUri, fileDoc);
		this.logService.info(
			`[DocsService] Stored file doc in cache: ${fileUri}, content length: ${content.length} chars`
		);
		const storageKey = getFileStorageKey(uri);
		this.storageService.store(
			storageKey,
			JSON.stringify(fileDoc),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
		this.logService.info(
			`[DocsService] Stored file doc in storage: ${storageKey}`
		);

		// Emit update event
		this._onDidUpdateFileDocs.fire(fileDoc);
		this.logService.info(
			`[DocsService] Firing onDidUpdateFileDocs event for file: ${fileUri}`
		);

		this.logService.info(
			`[DocsService] generateDocsForFile completed for ${uri.fsPath}`
		);
		return fileDoc;
	}

	getFileDocs(uri: URI): FileDocs | undefined {
		const fileUri = uri.toString();
		// Check cache first
		if (this.fileDocsCache.has(fileUri)) {
			const doc = this.fileDocsCache.get(fileUri);
			this.logService.debug(
				`[DocsService] getFileDocs: Found in cache for ${fileUri}, content length: ${
					doc?.content.length || 0
				}`
			);
			return doc;
		}

		this.logService.debug(
			`[DocsService] getFileDocs: Not in cache, checking storage for ${fileUri}`
		);
		// Load from storage
		const storageKey = getFileStorageKey(uri);
		const stored = this.storageService.get(
			storageKey,
			StorageScope.WORKSPACE,
			undefined
		);
		if (stored) {
			try {
				const fileDoc = JSON.parse(stored) as FileDocs;
				this.fileDocsCache.set(fileUri, fileDoc);
				this.logService.debug(
					`[DocsService] getFileDocs: Loaded from storage for ${fileUri}, content length: ${fileDoc.content.length}`
				);
				return fileDoc;
			} catch (e) {
				this.logService.error(
					"[DocsService] Failed to parse stored file docs:",
					e
				);
			}
		} else {
			this.logService.debug(
				`[DocsService] getFileDocs: No stored doc found for ${fileUri}`
			);
		}

		return undefined;
	}

	async removeDocsForFile(uri: URI): Promise<void> {
		const fileUri = uri.toString();

		// Remove from cache
		this.fileDocsCache.delete(fileUri);

		// Remove from storage
		const storageKey = getFileStorageKey(uri);
		this.storageService.remove(storageKey, StorageScope.WORKSPACE);

		this.logService.info(`[DocsService] Removed file docs for ${uri.fsPath}`);
	}

	// Directory-level methods

	private async collectFilesFromDirectory(
		directoryUri: URI,
		maxFiles: number = 50
	): Promise<URI[]> {
		const files: URI[] = [];
		const excludedDirs = new Set([
			"node_modules",
			".git",
			"dist",
			"build",
			"out",
			".next",
			".cache",
			"coverage",
			".nyc_output",
		]);
		const codeExtensions = new Set([
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".java",
			".go",
			".rs",
			".cpp",
			".c",
			".cs",
			".php",
			".rb",
			".swift",
			".kt",
		]);

		const collectRecursive = async (dirUri: URI): Promise<void> => {
			if (files.length >= maxFiles) {
				return;
			}

			try {
				const stat = await this.fileService.resolve(dirUri);
				if (!stat.isDirectory) {
					return;
				}

				const children = stat.children || [];
				for (const child of children) {
					if (files.length >= maxFiles) {
						break;
					}

					if (child.isDirectory) {
						const dirName = basename(child.resource);
						if (!excludedDirs.has(dirName.toLowerCase())) {
							await collectRecursive(child.resource);
						}
					} else if (child.isFile) {
						const ext = extname(child.resource).toLowerCase();
						if (codeExtensions.has(ext)) {
							files.push(child.resource);
						}
					}
				}
			} catch (error) {
				this.logService.warn(
					`[DocsService] Failed to read directory ${dirUri.fsPath}:`,
					error
				);
			}
		};

		await collectRecursive(directoryUri);
		return files.slice(0, maxFiles);
	}

	private async generateDirectoryDocContent(
		directoryUri: URI
	): Promise<{ content: string; includedFiles: URI[] }> {
		try {
			// Get access token
			const accessToken = await this.secretStorageService.get(
				REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN
			);
			if (!accessToken) {
				this.logService.warn(
					"[DocsService] No access token available for directory docs, using placeholder content"
				);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: [],
				};
			}

			// Collect files from directory
			const files = await this.collectFilesFromDirectory(directoryUri, 50);
			if (files.length === 0) {
				this.logService.warn(
					`[DocsService] No code files found in directory ${directoryUri.fsPath}`
				);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: [],
				};
			}

			// Get server address
			const serverAddress = await this.getServerAddress();
			const endpoint = "/api/bg-agent/generate-directory-docs";
			const url = this.normalizeEndpoint(serverAddress, endpoint);

			// Prepare chunks for all files
			const chunks: Array<{
				text: string;
				metadata: {
					filePath: string;
					language: string;
					symbolSummary?: string;
					merkleHash?: string;
					chunkId?: string;
					projectHash?: string;
				};
			}> = [];

			// Get project hash once for all chunks
			const projectHash = this.getProjectHash();

			for (const fileUri of files) {
				try {
					const fileContent = await this.getFileContent(fileUri);
					if (!fileContent.trim()) {
						continue;
					}

					const fileExtension = fileUri.path.split(".").pop() || "";
					const language = this.detectLanguage(fileExtension);
					const symbolSummary = await this.collectSymbolSummary(fileUri);

					// Get hash from Merkle tree service (SHA256) to match database storage
					const merkleHash = await this.getFileHashFromMerkleTree(fileUri);
					const chunkId = this.getChunkIdFromUri(fileUri);

					if (!merkleHash) {
						this.logService.warn(
							`[DocsService] Could not get Merkle tree hash for ${fileUri.fsPath}, skipping from directory docs`
						);
						continue;
					}

					chunks.push({
						text: fileContent,
						metadata: {
							filePath: fileUri.fsPath,
							language: language,
							symbolSummary: symbolSummary,
							// Include hash-checking metadata for server-side deduplication
							merkleHash: merkleHash,
							chunkId: chunkId,
							projectHash: projectHash,
						},
					});
				} catch (error) {
					this.logService.warn(
						`[DocsService] Failed to process file ${fileUri.fsPath} for directory docs:`,
						error
					);
				}
			}

			if (chunks.length === 0) {
				this.logService.warn(
					`[DocsService] No valid files to document in directory ${directoryUri.fsPath}`
				);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: [],
				};
			}

			const payload = {
				chunks: chunks,
				options: {
					documentationStyle: "markdown" as const,
					directoryMode: true,
					includeArchitecture: true,
					includeMermaid: true,
				},
			};

			// Make API call
			this.logService.info(
				`[DocsService] Generating directory docs for ${directoryUri.fsPath} (${chunks.length} files)...`
			);
			const response = await this.requestService.request(
				{
					type: "POST",
					url,
					data: JSON.stringify(payload),
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
					},
					timeout: 120000, // 2 minutes timeout for large directory docs
				},
				CancellationToken.None
			);

			if (!isSuccess(response)) {
				const errorBuffer = await streamToBuffer(response.stream);
				const errorText = errorBuffer.toString();
				let errorMessage = `Server error: ${response.res.statusCode}`;
				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.message || errorJson.error || errorMessage;
				} catch {
					if (errorText) {
						errorMessage += ` - ${errorText}`;
					}
				}
				this.logService.error(`[DocsService] API call failed: ${errorMessage}`);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: files,
				};
			}

			// Parse response
			const result = await asJson<{
				documentation: string;
				model: string;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					total_tokens: number;
				};
				skipped?: boolean;
				message?: string;
			}>(response);

			if (!result) {
				this.logService.warn(`[DocsService] API returned empty response`);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: files,
				};
			}

			// Check if generation was skipped due to unchanged hash
			if (result.skipped) {
				this.logService.info(
					`[DocsService] Directory doc generation skipped for ${
						directoryUri.fsPath
					}: ${result.message || "hash unchanged"}`
				);
				// Return cached content if available, otherwise use placeholder
				const cached = this.getDirectoryDocs(directoryUri);
				if (cached?.content) {
					return {
						content: cached.content,
						includedFiles: cached.includedFiles || files,
					};
				}
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: files,
				};
			}

			if (!result.documentation) {
				this.logService.warn(
					`[DocsService] API response missing documentation field`
				);
				return {
					content: this.generateDirectoryPlaceholderContent(directoryUri),
					includedFiles: files,
				};
			}

			this.logService.info(
				`[DocsService] Successfully generated directory docs for ${directoryUri.fsPath} (${chunks.length} files, model: ${result.model})`
			);
			return {
				content: result.documentation,
				includedFiles: files,
			};
		} catch (error) {
			this.logService.error(
				`[DocsService] Error generating directory docs:`,
				error
			);
			return {
				content: this.generateDirectoryPlaceholderContent(directoryUri),
				includedFiles: [],
			};
		}
	}

	private generateDirectoryPlaceholderContent(uri: URI): string {
		const lines: string[] = [];
		lines.push(`# Directory Documentation`);
		lines.push("");
		lines.push(`**Directory:** \`${uri.fsPath}\``);
		lines.push("");
		lines.push(`*Placeholder content - API call failed or not available*`);
		return lines.join("\n");
	}

	async generateDocsForDirectory(
		uri: URI,
		mode: "initialize" | "regenerate" = "regenerate"
	): Promise<DirectoryDocs | undefined> {
		this.logService.info(
			`[DocsService] generateDocsForDirectory called for ${uri.fsPath}, mode: ${mode}`
		);

		// Generate directory-level documentation
		const { content, includedFiles } = await this.generateDirectoryDocContent(
			uri
		);
		const directoryDoc: DirectoryDocs = {
			uri,
			content,
			format: "markdown",
			generatedAt: Date.now(),
			fileCount: includedFiles.length,
			includedFiles: includedFiles,
		};

		// Store in cache and storage
		const directoryUri = uri.toString();
		this.directoryDocsCache.set(directoryUri, directoryDoc);
		this.logService.info(
			`[DocsService] Stored directory doc in cache: ${directoryUri}, content length: ${content.length} chars, ${includedFiles.length} files`
		);
		const storageKey = getDirectoryStorageKey(uri);
		this.storageService.store(
			storageKey,
			JSON.stringify(directoryDoc),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
		this.logService.info(
			`[DocsService] Stored directory doc in storage: ${storageKey}`
		);

		// Emit update event
		this._onDidUpdateDirectoryDocs.fire(directoryDoc);
		this.logService.info(
			`[DocsService] Firing onDidUpdateDirectoryDocs event for directory: ${directoryUri}`
		);

		// If this is the workspace root directory, store as project description
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.folders && workspace.folders.length > 0) {
			const rootFolder = workspace.folders[0];
			if (
				this.workspaceContextService.getWorkspaceFolder(uri)?.uri.toString() ===
					rootFolder.uri.toString() ||
				uri.toString() === rootFolder.uri.toString()
			) {
				// Store as project description for Monitor View
				this.workspaceStore.setString("projectDescription", content);
				this.logService.info(
					`[DocsService] Stored project description from root directory docs`
				);
			}
		}

		this.logService.info(
			`[DocsService] generateDocsForDirectory completed for ${uri.fsPath}`
		);
		return directoryDoc;
	}

	getDirectoryDocs(uri: URI): DirectoryDocs | undefined {
		const directoryUri = uri.toString();
		// Check cache first
		if (this.directoryDocsCache.has(directoryUri)) {
			const doc = this.directoryDocsCache.get(directoryUri);
			this.logService.debug(
				`[DocsService] getDirectoryDocs: Found in cache for ${directoryUri}, content length: ${
					doc?.content.length || 0
				}, files: ${doc?.fileCount || 0}`
			);
			return doc;
		}

		this.logService.debug(
			`[DocsService] getDirectoryDocs: Not in cache, checking storage for ${directoryUri}`
		);
		// Load from storage
		const storageKey = getDirectoryStorageKey(uri);
		const stored = this.storageService.get(
			storageKey,
			StorageScope.WORKSPACE,
			undefined
		);
		if (stored) {
			try {
				const directoryDoc = JSON.parse(stored) as DirectoryDocs;
				this.directoryDocsCache.set(directoryUri, directoryDoc);
				this.logService.debug(
					`[DocsService] getDirectoryDocs: Loaded from storage for ${directoryUri}, content length: ${
						directoryDoc.content.length
					}, files: ${directoryDoc.fileCount || 0}`
				);
				return directoryDoc;
			} catch (e) {
				this.logService.error(
					"[DocsService] Failed to parse stored directory docs:",
					e
				);
			}
		} else {
			this.logService.debug(
				`[DocsService] getDirectoryDocs: No stored doc found for ${directoryUri}`
			);
		}

		return undefined;
	}

	async removeDocsForDirectory(uri: URI): Promise<void> {
		const directoryUri = uri.toString();

		// Remove from cache
		this.directoryDocsCache.delete(directoryUri);

		// Remove from storage
		const storageKey = getDirectoryStorageKey(uri);
		this.storageService.remove(storageKey, StorageScope.WORKSPACE);

		this.logService.info(
			`[DocsService] Removed directory docs for ${uri.fsPath}`
		);
	}
}

registerSingleton(IDocsService, DocsService, InstantiationType.Delayed);

interface SymbolNode {
	name: string;
	kind: number;
	range: IRange;
	children: SymbolNode[];
}
