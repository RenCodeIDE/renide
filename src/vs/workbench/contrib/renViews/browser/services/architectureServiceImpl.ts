/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import {
	registerSingleton,
	InstantiationType,
} from "../../../../../platform/instantiation/common/extensions.js";
import {
	IArchitectureService,
	ArchitectureAnalysis,
	ArchitectureNode,
	ArchitectureEdge,
	ArchitectureLayer,
	ArchitectureProgress,
	CachedArchitectureAnalysis,
	ArchNodeType,
} from "./architectureService.js";
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
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { computeWorkspaceHashSync } from "./workspaceHash.js";
import { IMerkleTreeService, MerkleTreeNode } from "../../../../../platform/merkleTree/common/merkleTreeService.js";
import { FileChunk } from "../../../../../platform/merkleTree/common/merkleTreeTypes.js";

const STORAGE_KEY_ARCHITECTURE = "ren.architecture.analysis";
const ANALYSIS_VERSION = "1.0.0";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const REN_AUTH_STORAGE_KEYS = {
	ACCESS_TOKEN: "ren.auth.accessToken",
};

/**
 * File extensions to analyze for architecture
 */
const ANALYZED_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.go', '.rs', '.java', '.kt', '.scala',
	'.vue', '.svelte', '.astro',
]);

/**
 * Directories to exclude from analysis
 */
const EXCLUDED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
	'__pycache__', '.pytest_cache', 'venv', '.venv', 'env',
	'target', 'vendor', '.cargo', 'pkg',
	'coverage', '.nyc_output', '.turbo', '.cache',
]);

/**
 * Maximum number of files to send to the API
 */
const MAX_FILES_PER_REQUEST = 100;

/**
 * Layer definitions for frontend architecture
 */
const FRONTEND_LAYERS: ArchitectureLayer[] = [
	{ id: 'pages', label: 'Pages', order: 0, color: '#3B82F6', borderColor: '#1E40AF', nodeCount: 0 },
	{ id: 'layouts', label: 'Layouts', order: 1, color: '#8B5CF6', borderColor: '#5B21B6', nodeCount: 0 },
	{ id: 'components', label: 'Components', order: 2, color: '#10B981', borderColor: '#047857', nodeCount: 0 },
	{ id: 'hooks', label: 'Hooks', order: 3, color: '#F59E0B', borderColor: '#B45309', nodeCount: 0 },
	{ id: 'state', label: 'State Management', order: 4, color: '#6366F1', borderColor: '#4338CA', nodeCount: 0 },
	{ id: 'api-client', label: 'API Client', order: 5, color: '#14B8A6', borderColor: '#0D9488', nodeCount: 0 },
];

/**
 * Layer definitions for backend architecture
 */
const BACKEND_LAYERS: ArchitectureLayer[] = [
	{ id: 'routes', label: 'Routes', order: 0, color: '#3B82F6', borderColor: '#1E40AF', nodeCount: 0 },
	{ id: 'controllers', label: 'Controllers', order: 1, color: '#0EA5E9', borderColor: '#0369A1', nodeCount: 0 },
	{ id: 'services', label: 'Services', order: 2, color: '#22C55E', borderColor: '#15803D', nodeCount: 0 },
	{ id: 'repositories', label: 'Repositories', order: 3, color: '#A855F7', borderColor: '#7E22CE', nodeCount: 0 },
	{ id: 'models', label: 'Models', order: 4, color: '#F97316', borderColor: '#C2410C', nodeCount: 0 },
	{ id: 'middleware', label: 'Middleware', order: 5, color: '#EF4444', borderColor: '#B91C1C', nodeCount: 0 },
];

/**
 * Shared layers
 */
const SHARED_LAYERS: ArchitectureLayer[] = [
	{ id: 'shared', label: 'Shared', order: 10, color: '#6B7280', borderColor: '#374151', nodeCount: 0 },
	{ id: 'config', label: 'Config', order: 11, color: '#9CA3AF', borderColor: '#4B5563', nodeCount: 0 },
	{ id: 'types', label: 'Types', order: 12, color: '#D1D5DB', borderColor: '#6B7280', nodeCount: 0 },
	{ id: 'external', label: 'External', order: 13, color: '#E5E7EB', borderColor: '#9CA3AF', nodeCount: 0 },
];

/**
 * Interface for file data sent to API
 */
interface FileAnalysisData {
	path: string;
	language: string;
	chunks: Array<{
		startLine: number;
		endLine: number;
		hash: string;
		content: string;
	}>;
	staticHints: {
		possibleType: ArchNodeType;
		possibleLayer: string;
		imports: string[];
		exports: string[];
	};
}

/**
 * API response structure
 */
interface ArchitectureAnalysisResponse {
	codebaseType: 'frontend' | 'backend' | 'fullstack' | 'unknown';
	primaryFramework?: string;
	layers: Array<{
		id: string;
		label: string;
		order: number;
		nodes: Array<{
			id: string;
			type: ArchNodeType;
			label: string;
			conciseLabel: string;
			filePath: string;
			description?: string;
			imports?: string[];
			exports?: string[];
		}>;
	}>;
	edges: Array<{
		source: string;
		target: string;
		type: string;
		label?: string;
	}>;
	summary: string[];
	recommendations?: string[];
}

export class ArchitectureService extends Disposable implements IArchitectureService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateAnalysis = this._register(new Emitter<ArchitectureAnalysis>());
	readonly onDidUpdateAnalysis: Event<ArchitectureAnalysis> = this._onDidUpdateAnalysis.event;

	private readonly _onAnalysisProgress = this._register(new Emitter<ArchitectureProgress>());
	readonly onAnalysisProgress: Event<ArchitectureProgress> = this._onAnalysisProgress.event;

	private cachedAnalysis: ArchitectureAnalysis | undefined;
	private cachedProjectHash: string | undefined;
	private _isAnalyzing = false;
	private analysisPromise: Promise<ArchitectureAnalysis> | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService
	) {
		super();
		this.loadCachedAnalysis();
	}

	/**
	 * Load cached analysis from storage
	 */
	private loadCachedAnalysis(): void {
		try {
			const stored = this.storageService.get(
				STORAGE_KEY_ARCHITECTURE,
				StorageScope.WORKSPACE,
				undefined
			);
			if (stored) {
				const cached: CachedArchitectureAnalysis = JSON.parse(stored);
				// Check if cache is still valid
				if (
					cached.timestamp + cached.ttl > Date.now() &&
					cached.merkleRootHash === this.merkleTreeService.rootHash
				) {
					// Reconstruct URI from stored path
					const folders = this.workspaceContextService.getWorkspace().folders;
					if (folders.length > 0) {
						cached.analysis.workspaceUri = folders[0].uri;
					}
					this.cachedAnalysis = cached.analysis;
					this.logService.info(
						`[ArchitectureService] Loaded cached analysis with ${cached.analysis.nodes.length} nodes`
					);
				} else {
					this.logService.info(
						`[ArchitectureService] Cached analysis is stale (hash or TTL mismatch)`
					);
				}
			}
		} catch (error) {
			this.logService.warn("[ArchitectureService] Failed to load cached analysis:", error);
		}
	}

	/**
	 * Save analysis to cache
	 */
	private saveAnalysisToCache(analysis: ArchitectureAnalysis): void {
		try {
			const cached: CachedArchitectureAnalysis = {
				analysis: {
					...analysis,
					workspaceUri: undefined as unknown as URI, // Don't store URI directly
				},
				merkleRootHash: analysis.merkleRootHash,
				timestamp: Date.now(),
				ttl: CACHE_TTL_MS,
			};
			this.storageService.store(
				STORAGE_KEY_ARCHITECTURE,
				JSON.stringify(cached),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
			this.logService.info(
				`[ArchitectureService] Saved analysis to cache with ${analysis.nodes.length} nodes`
			);
		} catch (error) {
			this.logService.warn("[ArchitectureService] Failed to save analysis to cache:", error);
		}
	}

	/**
	 * Get the project hash for cache validation
	 */
	private getProjectHash(): string | undefined {
		if (this.cachedProjectHash) {
			return this.cachedProjectHash;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		const workspaceRoot = folders[0].uri;
		this.cachedProjectHash = computeWorkspaceHashSync(workspaceRoot);
		return this.cachedProjectHash;
	}

	/**
	 * Get server address for API calls
	 */
	private async getServerAddress(): Promise<string> {
		const serverAddress = env["SERVER_ADDRESS"];

		if (serverAddress) {
			let normalized = serverAddress.trim();
			if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
				normalized = `https://${normalized}`;
			}
			return normalized.replace(/\/+$/, "");
		}

		const apiBaseUrl = this.productService.renAccount?.apiBaseUrl;
		if (apiBaseUrl) {
			return apiBaseUrl.replace(/\/+$/, "");
		}

		throw new Error("Server address not configured");
	}

	/**
	 * Normalize endpoint URL
	 */
	private normalizeEndpoint(serverAddress: string, endpoint: string): string {
		const normalizedAddress = serverAddress.trim().replace(/\/+$/, "");
		if (normalizedAddress.endsWith("/api") && endpoint.startsWith("/api/")) {
			return `${normalizedAddress}${endpoint.substring(4)}`;
		}
		return `${normalizedAddress}${endpoint}`;
	}

	/**
	 * Check if a path should be analyzed
	 */
	private shouldAnalyzePath(path: string, isDirectory: boolean): boolean {
		const segments = path.split(/[/\\]/);

		// Check for excluded directories
		for (const segment of segments) {
			if (EXCLUDED_DIRS.has(segment)) {
				return false;
			}
		}

		if (isDirectory) {
			return true;
		}

		// Check file extension
		const ext = '.' + path.split('.').pop()?.toLowerCase();
		return ANALYZED_EXTENSIONS.has(ext);
	}

	/**
	 * Collect files from Merkle tree for analysis
	 */
	private async collectFilesFromTree(
		node: MerkleTreeNode,
		files: Map<string, FileAnalysisData>,
		depth: number = 0
	): Promise<void> {
		if (files.size >= MAX_FILES_PER_REQUEST) {
			return;
		}

		if (!this.shouldAnalyzePath(node.path, node.type === 'directory')) {
			return;
		}

		if (node.type === 'file' && node.chunks && node.chunks.length > 0) {
			// Analyze this file
			const staticHints = this.getStaticHints(node.path);
			const chunks = await this.getFileChunks(node.path, node.chunks);

			if (chunks.length > 0) {
				files.set(node.path, {
					path: node.path,
					language: this.detectLanguage(node.path),
					chunks,
					staticHints,
				});
			}
		}

		// Recurse into directories
		if (node.type === 'directory' && node.children) {
			for (const child of node.children) {
				await this.collectFilesFromTree(child, files, depth + 1);
				if (files.size >= MAX_FILES_PER_REQUEST) {
					break;
				}
			}
		}
	}

	/**
	 * Get chunks for a file (limited to MAX_CHUNKS_PER_FILE)
	 */
	private async getFileChunks(
		relativePath: string,
		fileChunks: FileChunk[]
	): Promise<Array<{ startLine: number; endLine: number; hash: string; content: string }>> {
		const result: Array<{ startLine: number; endLine: number; hash: string; content: string }> = [];

		// Select chunks based on file size
		let selectedChunks: FileChunk[] = [];
		const totalChunks = fileChunks.length;

		if (totalChunks <= 1) {
			// Small file - take all
			selectedChunks = fileChunks;
		} else if (totalChunks <= 3) {
			// Medium file - take first and last
			selectedChunks = [fileChunks[0], fileChunks[totalChunks - 1]];
		} else {
			// Large file - take first, middle, last
			const middleIndex = Math.floor(totalChunks / 2);
			selectedChunks = [fileChunks[0], fileChunks[middleIndex], fileChunks[totalChunks - 1]];
		}

		// Get content for selected chunks
		for (const chunk of selectedChunks) {
			if (chunk.content) {
				result.push({
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					hash: chunk.hash,
					content: chunk.content,
				});
			} else {
				// Need to read content from file
				try {
					const folders = this.workspaceContextService.getWorkspace().folders;
					if (folders.length > 0) {
						const fileUri = URI.joinPath(folders[0].uri, relativePath);
						const content = await this.fileService.readFile(fileUri);
						const lines = content.value.toString().split('\n');
						const chunkContent = lines.slice(chunk.startLine, chunk.endLine).join('\n');
						result.push({
							startLine: chunk.startLine,
							endLine: chunk.endLine,
							hash: chunk.hash,
							content: chunkContent,
						});
					}
				} catch (error) {
					this.logService.debug(`[ArchitectureService] Failed to read chunk content for ${relativePath}:`, error);
				}
			}
		}

		return result;
	}

	/**
	 * Detect language from file path
	 */
	private detectLanguage(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() || '';
		const languageMap: Record<string, string> = {
			'ts': 'typescript',
			'tsx': 'typescriptreact',
			'js': 'javascript',
			'jsx': 'javascriptreact',
			'mjs': 'javascript',
			'cjs': 'javascript',
			'py': 'python',
			'go': 'go',
			'rs': 'rust',
			'java': 'java',
			'kt': 'kotlin',
			'scala': 'scala',
			'vue': 'vue',
			'svelte': 'svelte',
			'astro': 'astro',
		};
		return languageMap[ext] || 'unknown';
	}

	/**
	 * Get static hints for a file based on path patterns
	 */
	private getStaticHints(filePath: string): FileAnalysisData['staticHints'] {
		const pathLower = filePath.toLowerCase();
		const fileName = filePath.split(/[/\\]/).pop() || '';
		const fileNameLower = fileName.toLowerCase();

		let possibleType: ArchNodeType = 'unknown';
		let possibleLayer = 'shared';

		// Frontend patterns
		if (pathLower.includes('/pages/') || pathLower.includes('/app/') && fileNameLower.includes('page')) {
			possibleType = 'page';
			possibleLayer = 'pages';
		} else if (pathLower.includes('/layouts/') || fileNameLower.includes('layout')) {
			possibleType = 'layout';
			possibleLayer = 'layouts';
		} else if (pathLower.includes('/components/')) {
			possibleType = 'component';
			possibleLayer = 'components';
		} else if (pathLower.includes('/hooks/') || fileNameLower.startsWith('use')) {
			possibleType = 'hook';
			possibleLayer = 'hooks';
		} else if (pathLower.includes('/store') || pathLower.includes('/redux') || pathLower.includes('/zustand')) {
			possibleType = 'store';
			possibleLayer = 'state';
		} else if (pathLower.includes('/context') || fileNameLower.includes('context')) {
			possibleType = 'context';
			possibleLayer = 'state';
		} else if (pathLower.includes('/api/') || pathLower.includes('/services/') && pathLower.includes('client')) {
			possibleType = 'api-client';
			possibleLayer = 'api-client';
		}
		// Backend patterns
		else if (pathLower.includes('/routes/') || pathLower.includes('/router')) {
			possibleType = 'router';
			possibleLayer = 'routes';
		} else if (pathLower.includes('/controllers/') || fileNameLower.includes('controller')) {
			possibleType = 'controller';
			possibleLayer = 'controllers';
		} else if (pathLower.includes('/services/') || fileNameLower.includes('service')) {
			possibleType = 'service';
			possibleLayer = 'services';
		} else if (pathLower.includes('/repositories/') || fileNameLower.includes('repository')) {
			possibleType = 'repository';
			possibleLayer = 'repositories';
		} else if (pathLower.includes('/models/') || pathLower.includes('/entities/') || fileNameLower.includes('model') || fileNameLower.includes('entity')) {
			possibleType = 'model';
			possibleLayer = 'models';
		} else if (pathLower.includes('/middleware') || fileNameLower.includes('middleware')) {
			possibleType = 'middleware';
			possibleLayer = 'middleware';
		}
		// Shared patterns
		else if (pathLower.includes('/utils/') || pathLower.includes('/helpers/')) {
			possibleType = 'utility';
			possibleLayer = 'shared';
		} else if (pathLower.includes('/config/') || fileNameLower.includes('config')) {
			possibleType = 'config';
			possibleLayer = 'config';
		} else if (pathLower.includes('/types/') || fileNameLower.endsWith('.d.ts')) {
			possibleType = 'type';
			possibleLayer = 'types';
		}

		return {
			possibleType,
			possibleLayer,
			imports: [],
			exports: [],
		};
	}

	/**
	 * Get the current cached architecture analysis
	 */
	getArchitectureAnalysis(): ArchitectureAnalysis | undefined {
		return this.cachedAnalysis;
	}

	/**
	 * Check if analysis is in progress
	 */
	isAnalyzing(): boolean {
		return this._isAnalyzing;
	}

	/**
	 * Analyze the workspace architecture
	 */
	async analyzeWorkspace(mode: 'auto' | 'frontend' | 'backend' | 'fullstack' = 'auto'): Promise<ArchitectureAnalysis> {
		// Return cached analysis if valid
		const currentRootHash = this.merkleTreeService.rootHash;
		if (
			this.cachedAnalysis &&
			this.cachedAnalysis.merkleRootHash === currentRootHash
		) {
			this.logService.info("[ArchitectureService] Returning cached analysis");
			return this.cachedAnalysis;
		}

		// Return existing promise if analysis is in progress
		if (this._isAnalyzing && this.analysisPromise) {
			return this.analysisPromise;
		}

		this._isAnalyzing = true;
		this.analysisPromise = this.doAnalyzeWorkspace(mode);

		try {
			const result = await this.analysisPromise;
			return result;
		} finally {
			this._isAnalyzing = false;
			this.analysisPromise = undefined;
		}
	}

	/**
	 * Perform the actual analysis
	 */
	private async doAnalyzeWorkspace(mode: 'auto' | 'frontend' | 'backend' | 'fullstack'): Promise<ArchitectureAnalysis> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error("No workspace folder open");
		}

		const workspaceUri = folders[0].uri;
		const merkleRootHash = this.merkleTreeService.rootHash;

		this.emitProgress('Collecting files from workspace...', 10, 'collecting');

		// Collect files from Merkle tree
		const tree = await this.merkleTreeService.getTree();
		const files = new Map<string, FileAnalysisData>();
		await this.collectFilesFromTree(tree, files);

		this.logService.info(`[ArchitectureService] Collected ${files.size} files for analysis`);

		if (files.size === 0) {
			// Return empty analysis
			const emptyAnalysis: ArchitectureAnalysis = {
				workspaceUri,
				merkleRootHash,
				codebaseType: 'unknown',
				layers: [],
				nodes: [],
				edges: [],
				summary: ['No analyzable files found in workspace'],
				generatedAt: Date.now(),
				aiGenerated: false,
				analysisVersion: ANALYSIS_VERSION,
			};
			this.cachedAnalysis = emptyAnalysis;
			this._onDidUpdateAnalysis.fire(emptyAnalysis);
			return emptyAnalysis;
		}

		this.emitProgress('Sending to AI for analysis...', 30, 'analyzing');

		// Try AI analysis first
		let analysis: ArchitectureAnalysis;
		try {
			analysis = await this.performAIAnalysis(workspaceUri, merkleRootHash, files, mode);
		} catch (error) {
			this.logService.warn("[ArchitectureService] AI analysis failed, falling back to static analysis:", error);
			this.emitProgress('AI analysis failed, using static analysis...', 60, 'building');
			analysis = this.performStaticAnalysis(workspaceUri, merkleRootHash, files);
		}

		// Cache and emit
		this.cachedAnalysis = analysis;
		this.saveAnalysisToCache(analysis);
		this._onDidUpdateAnalysis.fire(analysis);

		this.emitProgress('Analysis complete!', 100, 'complete');

		return analysis;
	}

	/**
	 * Perform AI-powered analysis
	 */
	private async performAIAnalysis(
		workspaceUri: URI,
		merkleRootHash: string,
		files: Map<string, FileAnalysisData>,
		mode: string
	): Promise<ArchitectureAnalysis> {
		const accessToken = await this.secretStorageService.get(REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN);
		if (!accessToken) {
			throw new Error("No access token available");
		}

		const serverAddress = await this.getServerAddress();
		const endpoint = "/api/bg-agent/analyze-architecture";
		const url = this.normalizeEndpoint(serverAddress, endpoint);

		// Prepare request payload
		const payload = {
			projectHash: this.getProjectHash(),
			merkleRootHash,
			codebaseType: mode,
			files: Array.from(files.values()),
		};

		this.logService.info(`[ArchitectureService] Sending ${files.size} files to ${url}`);

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
				// No timeout - let batches complete as long as needed
			},
			CancellationToken.None
		);

		if (!isSuccess(response)) {
			const errorBuffer = await streamToBuffer(response.stream);
			const errorText = errorBuffer.toString();
			throw new Error(`API error: ${response.res.statusCode} - ${errorText}`);
		}

		const result = await asJson<ArchitectureAnalysisResponse>(response);
		if (!result) {
			throw new Error("Empty response from API");
		}

		this.emitProgress('Building graph from AI response...', 80, 'building');

		return this.buildAnalysisFromResponse(workspaceUri, merkleRootHash, result);
	}

	/**
	 * Build analysis from API response
	 */
	private buildAnalysisFromResponse(
		workspaceUri: URI,
		merkleRootHash: string,
		response: ArchitectureAnalysisResponse
	): ArchitectureAnalysis {
		const layers: ArchitectureLayer[] = [];
		const nodes: ArchitectureNode[] = [];
		const edges: ArchitectureEdge[] = [];

		// Build layers and nodes from response
		for (const layerData of response.layers) {
			const layer: ArchitectureLayer = {
				id: layerData.id,
				label: layerData.label,
				order: layerData.order,
				color: this.getLayerColor(layerData.id),
				borderColor: this.getLayerBorderColor(layerData.id),
				nodeCount: layerData.nodes.length,
			};
			layers.push(layer);

			for (const nodeData of layerData.nodes) {
				const node: ArchitectureNode = {
					id: nodeData.id,
					type: nodeData.type,
					label: nodeData.label,
					conciseLabel: nodeData.conciseLabel,
					layerId: layerData.id,
					filePath: nodeData.filePath,
					description: nodeData.description,
					metadata: {
						imports: nodeData.imports || [],
						exports: nodeData.exports || [],
						dependencies: [],
					},
				};
				nodes.push(node);
			}
		}

		// Build edges
		for (const edgeData of response.edges) {
			const edge: ArchitectureEdge = {
				id: `${edgeData.source}->${edgeData.target}`,
				source: edgeData.source,
				target: edgeData.target,
				type: edgeData.type as ArchitectureEdge['type'],
				label: edgeData.label,
			};
			edges.push(edge);
		}

		return {
			workspaceUri,
			merkleRootHash,
			codebaseType: response.codebaseType,
			primaryFramework: response.primaryFramework,
			layers,
			nodes,
			edges,
			summary: response.summary,
			recommendations: response.recommendations,
			generatedAt: Date.now(),
			aiGenerated: true,
			analysisVersion: ANALYSIS_VERSION,
		};
	}

	/**
	 * Perform static analysis (fallback)
	 */
	private performStaticAnalysis(
		workspaceUri: URI,
		merkleRootHash: string,
		files: Map<string, FileAnalysisData>
	): ArchitectureAnalysis {
		const layerMap = new Map<string, ArchitectureNode[]>();
		const nodes: ArchitectureNode[] = [];
		const edges: ArchitectureEdge[] = [];

		// Classify each file based on static hints
		for (const [filePath, fileData] of files) {
			const node: ArchitectureNode = {
				id: filePath.replace(/[/\\]/g, '-').replace(/\./g, '_'),
				type: fileData.staticHints.possibleType,
				label: filePath.split(/[/\\]/).pop() || filePath,
				conciseLabel: this.getConciseLabel(filePath),
				layerId: fileData.staticHints.possibleLayer,
				filePath,
				metadata: {
					imports: fileData.staticHints.imports,
					exports: fileData.staticHints.exports,
					dependencies: [],
				},
			};
			nodes.push(node);

			// Group by layer
			const layerNodes = layerMap.get(node.layerId) || [];
			layerNodes.push(node);
			layerMap.set(node.layerId, layerNodes);

			// Try to detect edges from imports in chunk content
			for (const chunk of fileData.chunks) {
				const importEdges = this.detectImportsFromContent(node.id, chunk.content, files);
				edges.push(...importEdges);
			}
		}

		// Detect codebase type
		const codebaseType = this.detectCodebaseType(files);

		// Build layers based on what we found
		const layers: ArchitectureLayer[] = [];
		const baseLayers = codebaseType === 'frontend' ? FRONTEND_LAYERS :
			codebaseType === 'backend' ? BACKEND_LAYERS :
				[...FRONTEND_LAYERS, ...BACKEND_LAYERS];

		for (const baseLayer of baseLayers) {
			const layerNodes = layerMap.get(baseLayer.id);
			if (layerNodes && layerNodes.length > 0) {
				layers.push({
					...baseLayer,
					nodeCount: layerNodes.length,
				});
			}
		}

		// Add shared layers if they have nodes
		for (const sharedLayer of SHARED_LAYERS) {
			const layerNodes = layerMap.get(sharedLayer.id);
			if (layerNodes && layerNodes.length > 0) {
				layers.push({
					...sharedLayer,
					nodeCount: layerNodes.length,
				});
			}
		}

		// Sort layers by order
		layers.sort((a, b) => a.order - b.order);

		return {
			workspaceUri,
			merkleRootHash,
			codebaseType,
			layers,
			nodes,
			edges,
			summary: this.generateSummary(nodes, layers, codebaseType),
			generatedAt: Date.now(),
			aiGenerated: false,
			analysisVersion: ANALYSIS_VERSION,
		};
	}

	/**
	 * Detect imports from chunk content
	 */
	private detectImportsFromContent(
		sourceNodeId: string,
		content: string,
		files: Map<string, FileAnalysisData>
	): ArchitectureEdge[] {
		const edges: ArchitectureEdge[] = [];
		const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
		let match;

		while ((match = importRegex.exec(content)) !== null) {
			const importPath = match[1];

			// Skip external packages
			if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
				continue;
			}

			// Try to find matching file
			for (const [filePath] of files) {
				if (filePath.includes(importPath.replace(/^\.\//, ''))) {
					const targetNodeId = filePath.replace(/[/\\]/g, '-').replace(/\./g, '_');
					if (targetNodeId !== sourceNodeId) {
						edges.push({
							id: `${sourceNodeId}->imports->${targetNodeId}`,
							source: sourceNodeId,
							target: targetNodeId,
							type: 'imports',
						});
						break;
					}
				}
			}
		}

		return edges;
	}

	/**
	 * Detect codebase type from files
	 */
	private detectCodebaseType(files: Map<string, FileAnalysisData>): 'frontend' | 'backend' | 'fullstack' | 'unknown' {
		let frontendScore = 0;
		let backendScore = 0;

		for (const [filePath, fileData] of files) {
			const pathLower = filePath.toLowerCase();

			// Frontend indicators
			if (pathLower.includes('/pages/') || pathLower.includes('/components/') ||
				pathLower.includes('/hooks/') || pathLower.includes('.tsx') ||
				pathLower.includes('.jsx') || pathLower.includes('/app/')) {
				frontendScore++;
			}

			// Backend indicators
			if (pathLower.includes('/controllers/') || pathLower.includes('/routes/') ||
				pathLower.includes('/services/') || pathLower.includes('/middleware/') ||
				pathLower.includes('/repositories/')) {
				backendScore++;
			}

			// Check chunk content for framework indicators
			for (const chunk of fileData.chunks) {
				if (chunk.content.includes('React') || chunk.content.includes('useState') ||
					chunk.content.includes('useEffect') || chunk.content.includes('Vue') ||
					chunk.content.includes('Svelte')) {
					frontendScore++;
				}
				if (chunk.content.includes('express') || chunk.content.includes('@Controller') ||
					chunk.content.includes('fastify') || chunk.content.includes('@Injectable')) {
					backendScore++;
				}
			}
		}

		if (frontendScore > 0 && backendScore > 0) {
			return 'fullstack';
		} else if (frontendScore > backendScore) {
			return 'frontend';
		} else if (backendScore > frontendScore) {
			return 'backend';
		}
		return 'unknown';
	}

	/**
	 * Get concise label from file path
	 */
	private getConciseLabel(filePath: string): string {
		const fileName = filePath.split(/[/\\]/).pop() || filePath;
		// Remove extension
		return fileName.replace(/\.[^.]+$/, '');
	}

	/**
	 * Get layer color
	 */
	private getLayerColor(layerId: string): string {
		const allLayers = [...FRONTEND_LAYERS, ...BACKEND_LAYERS, ...SHARED_LAYERS];
		const layer = allLayers.find(l => l.id === layerId);
		return layer?.color || '#6B7280';
	}

	/**
	 * Get layer border color
	 */
	private getLayerBorderColor(layerId: string): string {
		const allLayers = [...FRONTEND_LAYERS, ...BACKEND_LAYERS, ...SHARED_LAYERS];
		const layer = allLayers.find(l => l.id === layerId);
		return layer?.borderColor || '#374151';
	}

	/**
	 * Generate summary from analysis
	 */
	private generateSummary(
		nodes: ArchitectureNode[],
		layers: ArchitectureLayer[],
		codebaseType: string
	): string[] {
		const summary: string[] = [];

		summary.push(`Detected ${codebaseType} codebase with ${nodes.length} components`);

		for (const layer of layers) {
			summary.push(`${layer.label}: ${layer.nodeCount} components`);
		}

		return summary;
	}

	/**
	 * Emit progress update
	 */
	private emitProgress(message: string, progress: number, phase: ArchitectureProgress['phase']): void {
		this._onAnalysisProgress.fire({ message, progress, phase });
	}

	/**
	 * Invalidate the cached analysis
	 */
	async invalidateCache(): Promise<void> {
		this.cachedAnalysis = undefined;
		this.storageService.remove(STORAGE_KEY_ARCHITECTURE, StorageScope.WORKSPACE);
		this.logService.info("[ArchitectureService] Cache invalidated");
	}

	/**
	 * Get node for a specific file
	 */
	getNodeForFile(uri: URI): ArchitectureNode | undefined {
		if (!this.cachedAnalysis) {
			return undefined;
		}
		return this.cachedAnalysis.nodes.find(n => n.filePath === uri.fsPath);
	}

	/**
	 * Get all nodes in a specific layer
	 */
	getNodesInLayer(layerId: string): ArchitectureNode[] {
		if (!this.cachedAnalysis) {
			return [];
		}
		return this.cachedAnalysis.nodes.filter(n => n.layerId === layerId);
	}

	/**
	 * Get edges connected to a specific node
	 */
	getEdgesForNode(nodeId: string): { incoming: ArchitectureEdge[]; outgoing: ArchitectureEdge[] } {
		if (!this.cachedAnalysis) {
			return { incoming: [], outgoing: [] };
		}
		return {
			incoming: this.cachedAnalysis.edges.filter(e => e.target === nodeId),
			outgoing: this.cachedAnalysis.edges.filter(e => e.source === nodeId),
		};
	}
}

// Register the service
registerSingleton(IArchitectureService, ArchitectureService, InstantiationType.Delayed);

