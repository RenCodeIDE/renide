/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { IRequestService } from '../../../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';

import { GraphWorkspaceContext } from './graphContext.js';
import { ArchitectureAnalyzer } from './architectureAnalyzer.js';
import { CodebaseTypeDetector, CodebaseProfile, CodebaseType } from './codebaseTypeDetector.js';
import { FrontendAnalyzer } from './frontendAnalyzer.js';
import { BackendAnalyzer } from './backendAnalyzer.js';
import { AIArchitectureEnhancer } from './aiArchitectureEnhancer.js';
import {
	ContextAwareArchPayload,
	SmartArchPayload,
	FrontendArchPayload,
	BackendArchPayload,
	FullstackArchPayload,
	GraphMode,
	getPayloadNodes,
	getPayloadEdges
} from './graphTypes.js';

/**
 * Options for context-aware architecture analysis
 */
export interface ContextAwareArchOptions {
	force?: boolean;
	enableAI?: boolean;
	mode?: 'auto' | 'frontend' | 'backend' | 'fullstack';
}

/**
 * Progress update for architecture analysis
 */
export interface ContextAwareArchProgress {
	stage: 'detecting' | 'analyzing-frontend' | 'analyzing-backend' | 'ai-enhancing' | 'complete';
	message: string;
	progress: number; // 0-100
}

/**
 * Context-Aware Architecture Builder
 *
 * Orchestrates the analysis of codebases to produce context-aware architecture visualizations.
 * This is the main entry point for the new architecture graph modes.
 *
 * Flow:
 * 1. Detect codebase type (frontend/backend/fullstack)
 * 2. Run appropriate analyzers
 * 3. Enhance with AI descriptions
 * 4. Build final payload for visualization
 */
export class ContextAwareArchBuilder {
	private readonly onProgressEmitter = new Emitter<ContextAwareArchProgress>();
	readonly onProgress = this.onProgressEmitter.event;

	private cachedPayload: ContextAwareArchPayload | undefined;
	private cacheTimestamp = 0;
	private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

	private codebaseDetector: CodebaseTypeDetector | undefined;
	private frontendAnalyzer: FrontendAnalyzer | undefined;
	private backendAnalyzer: BackendAnalyzer | undefined;
	private aiEnhancer: AIArchitectureEnhancer | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		_commandService: ICommandService, // Reserved for future use
		_languageFeaturesService: ILanguageFeaturesService, // Reserved for future use
		private readonly requestService: IRequestService,
		private readonly configurationService: IConfigurationService,
		private readonly context: GraphWorkspaceContext,
		private readonly architectureAnalyzer: ArchitectureAnalyzer
	) { }

	/**
	 * Build a context-aware architecture payload
	 */
	async build(
		options: ContextAwareArchOptions = {},
		token: CancellationToken
	): Promise<ContextAwareArchPayload> {
		// Check cache
		if (!options.force && this.cachedPayload && Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
			return this.cachedPayload;
		}

		this.logService.info('[ContextAwareArchBuilder] Starting context-aware architecture analysis...');

		try {
			// Step 1: Detect codebase type
			this.emitProgress('detecting', 'Detecting codebase type...', 10);
			const profile = await this.getCodebaseProfile(options.force);

			if (token.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			// Step 2: Determine which analyzers to run
			const targetType = this.determineTargetType(profile, options.mode);

			// Step 3: Run appropriate analysis
			let data: SmartArchPayload;

			switch (targetType) {
				case 'frontend':
					data = await this.buildFrontendPayload(profile, token);
					break;
				case 'backend':
					data = await this.buildBackendPayload(profile, token);
					break;
				case 'fullstack':
					data = await this.buildFullstackPayload(profile, token);
					break;
				default:
					// Fall back to frontend if unknown
					data = await this.buildFrontendPayload(profile, token);
			}

			// Step 4: Enhance with AI (if enabled)
			if (options.enableAI !== false) {
				this.emitProgress('ai-enhancing', 'Enhancing with AI insights...', 80);
				data = await this.enhanceWithAI(data, profile, token);
			}

			// Step 5: Build final payload
			this.emitProgress('complete', 'Analysis complete', 100);

			const payload: ContextAwareArchPayload = {
				codebaseType: profile.type === 'library' || profile.type === 'cli' ? 'unknown' : profile.type as ContextAwareArchPayload['codebaseType'],
				confidence: profile.confidence,
				primaryFramework: profile.primaryFramework?.name ?? null,
				data,
				aiEnhanced: options.enableAI !== false,
				generatedAt: Date.now()
			};

			// Cache the result
			this.cachedPayload = payload;
			this.cacheTimestamp = Date.now();

			const nodeCount = getPayloadNodes(payload.data).length;
			const edgeCount = getPayloadEdges(payload.data).length;

			this.logService.info(
				`[ContextAwareArchBuilder] Analysis complete: ${payload.codebaseType} ` +
				`(${nodeCount} nodes, ${edgeCount} edges)`
			);

			return payload;
		} catch (error) {
			this.logService.error('[ContextAwareArchBuilder] Error building architecture:', error);
			throw error;
		}
	}

	/**
	 * Get the codebase profile
	 */
	private async getCodebaseProfile(force?: boolean): Promise<CodebaseProfile> {
		if (!this.codebaseDetector) {
			this.codebaseDetector = new CodebaseTypeDetector(
				this.logService,
				this.fileService,
				this.context,
				this.architectureAnalyzer
			);
		}

		return this.codebaseDetector.analyze(force);
	}

	/**
	 * Determine the target type for analysis
	 */
	private determineTargetType(
		profile: CodebaseProfile,
		modeOverride?: 'auto' | 'frontend' | 'backend' | 'fullstack'
	): CodebaseType {
		if (modeOverride && modeOverride !== 'auto') {
			return modeOverride;
		}

		// Auto-detect based on profile
		switch (profile.type) {
			case 'frontend':
				return 'frontend';
			case 'backend':
				return 'backend';
			case 'fullstack':
			case 'monorepo':
				return 'fullstack';
			default:
				// Make a guess based on features
				if (profile.features.hasApiRoutes && !profile.features.hasUIComponents) {
					return 'backend';
				}
				if (profile.features.hasUIComponents && !profile.features.hasApiRoutes) {
					return 'frontend';
				}
				return 'fullstack';
		}
	}

	/**
	 * Build frontend architecture payload
	 */
	private async buildFrontendPayload(
		profile: CodebaseProfile,
		token: CancellationToken
	): Promise<FrontendArchPayload> {
		this.emitProgress('analyzing-frontend', 'Analyzing frontend architecture...', 30);

		this.logService.info(`[ContextAwareArchBuilder] buildFrontendPayload called with profile type: ${profile.type}`);
		this.logService.info(`[ContextAwareArchBuilder] Primary framework: ${profile.primaryFramework?.name ?? 'none'}`);

		if (!this.frontendAnalyzer) {
			this.frontendAnalyzer = new FrontendAnalyzer(
				this.logService,
				this.fileService,
				this.searchService,
				this.context
			);
		}

		const framework = profile.primaryFramework?.name ?? 'React';
		this.logService.info(`[ContextAwareArchBuilder] Using framework: ${framework}`);

		if (token.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const result = await this.frontendAnalyzer.analyze(framework);
		this.logService.info(`[ContextAwareArchBuilder] FrontendAnalyzer returned ${result.nodes.length} nodes, ${result.edges.length} edges`);

		return result;
	}

	/**
	 * Build backend architecture payload
	 */
	private async buildBackendPayload(
		profile: CodebaseProfile,
		token: CancellationToken
	): Promise<BackendArchPayload> {
		this.emitProgress('analyzing-backend', 'Analyzing backend architecture...', 30);

		if (!this.backendAnalyzer) {
			this.backendAnalyzer = new BackendAnalyzer(
				this.logService,
				this.fileService,
				this.searchService,
				this.context
			);
		}

		const framework = profile.primaryFramework?.name ?? 'Express.js';
		return this.backendAnalyzer.analyze(framework);
	}

	/**
	 * Build fullstack architecture payload
	 */
	private async buildFullstackPayload(
		profile: CodebaseProfile,
		token: CancellationToken
	): Promise<FullstackArchPayload> {
		this.emitProgress('analyzing-frontend', 'Analyzing frontend architecture...', 30);

		// Run both analyzers
		const frontendPromise = this.buildFrontendPayload(profile, token);

		this.emitProgress('analyzing-backend', 'Analyzing backend architecture...', 50);
		const backendPromise = this.buildBackendPayload(profile, token);

		const [frontend, backend] = await Promise.all([frontendPromise, backendPromise]);

		// Find API connections between frontend and backend
		const apiConnections = this.findApiConnections(frontend, backend);

		// Find shared packages
		const sharedPackages = this.findSharedPackages(frontend, backend);

		const summary = [
			...frontend.summary,
			...backend.summary,
			`${apiConnections.length} API connections detected`
		];

		return {
			type: 'fullstack',
			frontend,
			backend,
			apiConnections,
			sharedPackages,
			summary
		};
	}

	/**
	 * Find API connections between frontend and backend
	 */
	private findApiConnections(
		frontend: FrontendArchPayload,
		backend: BackendArchPayload
	): FullstackArchPayload['apiConnections'] {
		const connections: FullstackArchPayload['apiConnections'] = [];

		// Look for fetch/axios calls in frontend nodes and match to backend endpoints
		for (const frontendNode of frontend.nodes) {
			// Check if this node makes API calls
			const hasApiConnection = frontendNode.metadata.hooks?.some(
				(h: string) => h.includes('Query') || h.includes('Mutation') || h.includes('fetch')
			);

			if (hasApiConnection) {
				// Try to find matching backend endpoint
				for (const endpoint of backend.endpoints) {
					// This is a simplified matching - could be enhanced with actual path matching
					connections.push({
						frontendNode: frontendNode.id,
						backendEndpoint: `${endpoint.method} ${endpoint.path}`,
						method: endpoint.method,
						path: endpoint.path
					});
				}
			}
		}

		return connections;
	}

	/**
	 * Find shared packages between frontend and backend
	 */
	private findSharedPackages(
		frontend: FrontendArchPayload,
		backend: BackendArchPayload
	): FullstackArchPayload['sharedPackages'] {
		// Look for nodes that appear in both (shared utilities, types, etc.)
		const frontendLabels = new Set(frontend.nodes.map(n => n.label));
		const sharedLabels = backend.nodes
			.filter(n => frontendLabels.has(n.label))
			.map(n => n.label);

		// TODO: Implement shared package detection - for now just return the count
		void sharedLabels; // Consume to avoid unused variable warning
		return [];
	}

	/**
	 * Enhance payload with AI descriptions
	 */
	private async enhanceWithAI(
		payload: SmartArchPayload,
		profile: CodebaseProfile,
		token: CancellationToken
	): Promise<SmartArchPayload> {
		if (!this.aiEnhancer) {
			this.aiEnhancer = new AIArchitectureEnhancer(
				this.logService,
				this.requestService,
				this.configurationService
			);
		}

		return this.aiEnhancer.enhance(
			payload,
			profile.type,
			profile.primaryFramework?.name ?? 'unknown',
			token
		);
	}

	/**
	 * Get the recommended graph mode for the current codebase
	 */
	async getRecommendedMode(): Promise<GraphMode> {
		const profile = await this.getCodebaseProfile();

		switch (profile.type) {
			case 'frontend':
				return 'frontendArch';
			case 'backend':
				return 'backendArch';
			case 'fullstack':
			case 'monorepo':
				return 'fullstackArch';
			default:
				return 'smartArch'; // Let smartArch auto-detect
		}
	}

	/**
	 * Emit a progress update
	 */
	private emitProgress(
		stage: ContextAwareArchProgress['stage'],
		message: string,
		progress: number
	): void {
		this.onProgressEmitter.fire({ stage, message, progress });
	}

	/**
	 * Clear all caches
	 */
	clearCache(): void {
		this.cachedPayload = undefined;
		this.cacheTimestamp = 0;

		if (this.codebaseDetector) {
			this.codebaseDetector.clearCache();
		}

		if (this.aiEnhancer) {
			this.aiEnhancer.clearCache();
		}
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): {
		hasCache: boolean;
		cacheAge: number | null;
		aiCacheStats: { size: number; oldestEntry: number | null } | null;
	} {
		return {
			hasCache: !!this.cachedPayload,
			cacheAge: this.cachedPayload ? Date.now() - this.cacheTimestamp : null,
			aiCacheStats: this.aiEnhancer ? this.aiEnhancer.getCacheStats() : null
		};
	}
}
