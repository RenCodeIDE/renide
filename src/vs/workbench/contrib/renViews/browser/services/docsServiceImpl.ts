import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import { IDocsService, ChunkDocs } from "./docsService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../platform/storage/common/storage.js";
import { IChunkIndexService } from "./chunkIndexService.js";
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
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { streamToBuffer } from "../../../../../base/common/buffer.js";

const STORAGE_KEY = "ren.docs.latest";
const STORAGE_KEY_PREFIX_CHUNK = "ren.docs.content.";
const REN_AUTH_STORAGE_KEYS = {
	ACCESS_TOKEN: "ren.auth.accessToken",
};

function getChunkId(uri: URI, hash: string): string {
	return `${uri.toString()}#${hash}`;
}

function getChunkStorageKey(chunkId: string): string {
	return `${STORAGE_KEY_PREFIX_CHUNK}${chunkId}`;
}

export class DocsService extends Disposable implements IDocsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateDocs = this._register(new Emitter<string>());
	readonly onDidUpdateDocs = this._onDidUpdateDocs.event;

	private readonly _onDidUpdateChunkDocs = this._register(
		new Emitter<ChunkDocs>()
	);
	readonly onDidUpdateChunkDocs = this._onDidUpdateChunkDocs.event;

	private latest: string | undefined;
	private chunkDocsCache: Map<string, ChunkDocs> = new Map();

	private readonly symbolToChunkIndex: Map<string, string> = new Map();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IChunkIndexService private readonly chunkIndexService: IChunkIndexService,
		@IFileService private readonly fileService: IFileService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService
		private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService
	) {
		super();
		this.latest = this.storageService.get(
			STORAGE_KEY,
			StorageScope.WORKSPACE,
			undefined
		);
		this.loadChunkDocsFromStorage();
	}

	private loadChunkDocsFromStorage(): void {
		// Load all chunk docs from storage (lazy load on access would be better, but this is simpler for now)
		// We'll rely on getChunkDocs to load on-demand
	}

	private async getChunkText(
		chunk: import("./chunkIndexService.js").ChunkRecord
	): Promise<string> {
		try {
			const fileContent = await this.fileService.readFile(chunk.uri);
			const content = fileContent.value.toString();
			const lines = content.split(/\r?\n/);

			if (chunk.range) {
				// Extract lines for this chunk (1-indexed to 0-indexed)
				const startLine = chunk.range.startLineNumber - 1;
				const endLine = chunk.range.endLineNumber;
				return lines.slice(startLine, endLine).join("\n");
			}

			return content;
		} catch (error) {
			this.logService.error(
				`[DocsService] Failed to read file for chunk: ${chunk.uri.fsPath}`,
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

	private async generateChunkDocContent(
		chunk: import("./chunkIndexService.js").ChunkRecord
	): Promise<string> {
		try {
			// Get access token
			const accessToken = await this.secretStorageService.get(
				REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN
			);
			if (!accessToken) {
				this.logService.warn(
					"[DocsService] No access token available, using placeholder content"
				);
				return this.generatePlaceholderContent(chunk);
			}

			// Get chunk text
			const chunkText = await this.getChunkText(chunk);
			if (!chunkText.trim()) {
				this.logService.warn(
					`[DocsService] Empty chunk text for ${chunk.uri.fsPath}`
				);
				return this.generatePlaceholderContent(chunk);
			}

			// Get server address
			const serverAddress = await this.getServerAddress();
			const endpoint = "/api/bg-agent/generate-docs";
			const url = `${serverAddress}${endpoint}`;

			// Prepare request payload
			const fileExtension = chunk.uri.path.split(".").pop() || "";
			const language = this.detectLanguage(fileExtension);

			const payload = {
				chunks: [
					{
						text: chunkText,
						metadata: {
							filePath: chunk.uri.fsPath,
							language: language,
							startLine: chunk.range?.startLineNumber,
							endLine: chunk.range?.endLineNumber,
							functionName: chunk.refs.functions[0]?.name,
							className: chunk.refs.symbols.find((s) => s.kind === "class")
								?.name,
						},
					},
				],
				options: {
					documentationStyle: "markdown" as const,
					includeExamples: true,
					includeParameters: true,
				},
			};

			// Make API call
			this.logService.info(
				`[DocsService] Generating docs for chunk ${chunk.hash.substring(
					0,
					8
				)}...`
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
				return this.generatePlaceholderContent(chunk);
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
			}>(response);

			if (!result) {
				this.logService.warn(`[DocsService] API returned empty response`);
				return this.generatePlaceholderContent(chunk);
			}

			if (result.documentation) {
				this.logService.info(
					`[DocsService] Successfully generated docs for chunk ${chunk.hash.substring(
						0,
						8
					)}... (model: ${result.model})`
				);
				return this.enhanceWithClickableSymbols(chunk, result.documentation);
			}

			this.logService.warn(
				`[DocsService] API response missing documentation field`
			);
			return this.generatePlaceholderContent(chunk);
		} catch (error) {
			this.logService.error(`[DocsService] Error generating docs:`, error);
			return this.generatePlaceholderContent(chunk);
		}
	}

	private buildSymbolKey(name: string, uri: URI, startLine?: number): string {
		return `${name}|${uri.toString()}|${startLine ?? 0}`;
	}

	private buildSymbolCommandLink(args: {
		uri: URI;
		position?: { lineNumber: number; column: number };
		symbolName?: string;
		chunkId?: string;
	}): string {
		const payload = [
			{
				uri: args.uri.toJSON(),
				position: args.position,
				symbolName: args.symbolName,
				chunkId: args.chunkId,
			},
		];
		return `command:ren.symbol.open?${encodeURIComponent(
			JSON.stringify(payload)
		)}`;
	}

	private enhanceWithClickableSymbols(
		chunk: import("./chunkIndexService.js").ChunkRecord,
		markdown: string
	): string {
		const enabled =
			this.configurationService.getValue<boolean>(
				"ren.docs.clickableSymbols.enabled"
			) !== false;
		if (!enabled) {
			return markdown;
		}

		const lines: string[] = [];
		lines.push(markdown.trim());
		lines.push("\n\n---\n");
		lines.push(`### Symbols`);

		const chunkId = getChunkId(chunk.uri, chunk.hash);

		// Index symbols and list them with links
		const addEntry = (
			name: string,
			uri: URI,
			startLine?: number,
			startColumn?: number
		) => {
			const key = this.buildSymbolKey(name, uri, startLine);
			this.symbolToChunkIndex.set(key, chunkId);
			const link = this.buildSymbolCommandLink({
				uri,
				position:
					startLine && startColumn
						? { lineNumber: startLine, column: startColumn }
						: undefined,
				symbolName: name,
				chunkId,
			});
			lines.push(`- [${name}](${link})`);
		};

		// From symbols
		for (const s of chunk.refs.symbols ?? []) {
			addEntry(s.name, s.uri, s.range?.startLineNumber, s.range?.startColumn);
		}
		// From functions
		for (const f of chunk.refs.functions ?? []) {
			addEntry(
				f.name,
				chunk.uri,
				f.range?.startLineNumber,
				f.range?.startColumn
			);
		}

		return lines.join("\n");
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

	private generatePlaceholderContent(
		chunk: import("./chunkIndexService.js").ChunkRecord
	): string {
		// Fallback placeholder content
		const lines: string[] = [];
		lines.push(`# ${chunk.description || "Chunk Documentation"}`);
		lines.push("");
		lines.push(`**File:** \`${chunk.uri.fsPath}\``);
		lines.push(`**Hash:** \`${chunk.hash.substring(0, 16)}...\``);
		if (chunk.parentHash) {
			lines.push(
				`**Parent Hash:** \`${chunk.parentHash.substring(0, 16)}...\``
			);
		}
		if (chunk.range) {
			lines.push(
				`**Range:** Lines ${chunk.range.startLineNumber}-${chunk.range.endLineNumber}`
			);
		}
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
	): Promise<ChunkDocs[]> {
		this.logService.info(
			`[DocsService] generateDocsForFile called for ${uri.fsPath}, mode: ${mode}`
		);
		const chunks = await this.chunkIndexService.getChunksForFile(uri);
		this.logService.info(
			`[DocsService] Found ${chunks.length} chunks for file`
		);
		const results: ChunkDocs[] = [];

		for (const chunk of chunks) {
			const chunkId = getChunkId(chunk.uri, chunk.hash);
			this.logService.info(
				`[DocsService] Processing chunk ${chunkId.substring(
					chunkId.length - 8
				)}...`
			);
			const content = await this.generateChunkDocContent(chunk);
			const chunkDoc: ChunkDocs = {
				chunkId,
				content,
				format: "markdown",
				generatedAt: Date.now(),
			};

			// Store in cache and storage
			this.chunkDocsCache.set(chunkId, chunkDoc);
			this.logService.info(
				`[DocsService] Stored chunk doc in cache: ${chunkId}, content length: ${content.length} chars`
			);
			const storageKey = getChunkStorageKey(chunkId);
			this.storageService.store(
				storageKey,
				JSON.stringify(chunkDoc),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			this.logService.info(
				`[DocsService] Stored chunk doc in storage: ${storageKey}`
			);

			results.push(chunkDoc);
			this.logService.info(
				`[DocsService] Firing onDidUpdateChunkDocs event for chunk: ${chunkId}`
			);
			this._onDidUpdateChunkDocs.fire(chunkDoc);
		}

		this.logService.info(
			`[DocsService] generateDocsForFile completed, returning ${results.length} docs`
		);
		return results;
	}

	getChunkDocs(chunkId: string): ChunkDocs | undefined {
		// Check cache first
		if (this.chunkDocsCache.has(chunkId)) {
			const doc = this.chunkDocsCache.get(chunkId);
			this.logService.debug(
				`[DocsService] getChunkDocs: Found in cache for ${chunkId}, content length: ${
					doc?.content.length || 0
				}`
			);
			return doc;
		}

		this.logService.debug(
			`[DocsService] getChunkDocs: Not in cache, checking storage for ${chunkId}`
		);
		// Load from storage
		const storageKey = getChunkStorageKey(chunkId);
		const stored = this.storageService.get(
			storageKey,
			StorageScope.WORKSPACE,
			undefined
		);
		if (stored) {
			try {
				const chunkDoc = JSON.parse(stored) as ChunkDocs;
				this.chunkDocsCache.set(chunkId, chunkDoc);
				this.logService.debug(
					`[DocsService] getChunkDocs: Loaded from storage for ${chunkId}, content length: ${chunkDoc.content.length}`
				);
				return chunkDoc;
			} catch (e) {
				this.logService.error(
					"[DocsService] Failed to parse stored chunk docs:",
					e
				);
			}
		} else {
			this.logService.debug(
				`[DocsService] getChunkDocs: No stored doc found for ${chunkId}`
			);
		}

		return undefined;
	}

	listDocsForFile(uri: URI): ChunkDocs[] {
		const chunks = this.chunkIndexService.listFileChunks(uri);
		const docs: ChunkDocs[] = [];

		for (const chunk of chunks) {
			const chunkId = getChunkId(chunk.uri, chunk.hash);
			const doc = this.getChunkDocs(chunkId);
			if (doc) {
				docs.push(doc);
			}
		}

		return docs.sort((a, b) => a.generatedAt - b.generatedAt);
	}

	async refreshChangedChunks(
		uri: URI,
		changedChunkHashes: string[]
	): Promise<ChunkDocs[]> {
		const chunks = await this.chunkIndexService.getChunksForFile(uri);
		const results: ChunkDocs[] = [];

		for (const chunk of chunks) {
			if (changedChunkHashes.includes(chunk.hash)) {
				const chunkId = getChunkId(chunk.uri, chunk.hash);
				const content = await this.generateChunkDocContent(chunk);
				const chunkDoc: ChunkDocs = {
					chunkId,
					content,
					format: "markdown",
					generatedAt: Date.now(),
				};

				this.chunkDocsCache.set(chunkId, chunkDoc);
				const storageKey = getChunkStorageKey(chunkId);
				this.storageService.store(
					storageKey,
					JSON.stringify(chunkDoc),
					StorageScope.WORKSPACE,
					StorageTarget.MACHINE
				);

				results.push(chunkDoc);
				this._onDidUpdateChunkDocs.fire(chunkDoc);
			}
		}

		return results;
	}

	async regenerateChunk(chunkId: string): Promise<ChunkDocs | undefined> {
		// Get chunk from chunk index
		const chunk = this.chunkIndexService.getChunk(chunkId);
		if (!chunk) {
			console.warn(
				`[DocsService] regenerateChunk: Chunk not found for chunkId: ${chunkId}`
			);
			return undefined;
		}

		// Generate new doc content
		const content = await this.generateChunkDocContent(chunk);
		const chunkDoc: ChunkDocs = {
			chunkId,
			content,
			format: "markdown",
			generatedAt: Date.now(),
		};

		// Store in cache and storage
		this.chunkDocsCache.set(chunkId, chunkDoc);
		const storageKey = getChunkStorageKey(chunkId);
		this.storageService.store(
			storageKey,
			JSON.stringify(chunkDoc),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);

		// Emit update event
		this._onDidUpdateChunkDocs.fire(chunkDoc);

		console.log(
			`[DocsService] Regenerated chunk ${chunkId} for file ${chunk.uri.fsPath}`
		);

		return chunkDoc;
	}

	async removeDocsForFile(uri: URI): Promise<void> {
		// Get old chunks before they're removed (if they exist)
		const oldChunks = this.chunkIndexService.listFileChunks(uri);
		const fileUri = uri.toString();

		// Remove docs for all old chunks
		for (const chunk of oldChunks) {
			const chunkId = getChunkId(chunk.uri, chunk.hash);

			// Remove from cache
			this.chunkDocsCache.delete(chunkId);

			// Remove from storage
			const storageKey = getChunkStorageKey(chunkId);
			this.storageService.remove(storageKey, StorageScope.WORKSPACE);
		}

		// Also clean up any orphaned docs in cache that match this file URI
		// (in case chunks were removed without calling this method)
		const uriPrefix = fileUri + "#";
		for (const chunkId of this.chunkDocsCache.keys()) {
			if (chunkId.startsWith(uriPrefix)) {
				// Check if this chunkId still exists in chunk index
				const chunk = this.chunkIndexService.getChunk(chunkId);
				if (!chunk) {
					// Orphaned doc - remove it
					this.chunkDocsCache.delete(chunkId);
					const storageKey = getChunkStorageKey(chunkId);
					this.storageService.remove(storageKey, StorageScope.WORKSPACE);
				}
			}
		}
	}
}

registerSingleton(IDocsService, DocsService, InstantiationType.Delayed);
