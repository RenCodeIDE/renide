/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ArchNode, ArchEdge, SmartArchPayload, getPayloadNodes, getPayloadEdges, isFrontendPayload, isBackendPayload } from './graphTypes.js';

/**
 * AI-generated description for a node
 */
export interface AINodeDescription {
	nodeId: string;
	description: string;
	purpose: string;
	category: string;
	patterns: string[];
	suggestions?: string[];
}

/**
 * AI-enhanced architecture analysis
 */
export interface AIArchitectureAnalysis {
	codebaseType: 'frontend' | 'backend' | 'fullstack' | 'library' | 'monorepo';
	confidence: number;
	summary: string;
	architecture: {
		pattern: string; // e.g., "MVC", "Clean Architecture", "Microservices"
		description: string;
	};
	layers: string[];
	nodeDescriptions: AINodeDescription[];
	insights: string[];
	suggestions: string[];
}

/**
 * Request payload for AI analysis
 */
interface AIAnalysisRequest {
	nodes: Array<{
		id: string;
		type: string;
		label: string;
		layer: string;
		filePath?: string;
		metadata: Record<string, unknown>;
	}>;
	edges: Array<{
		source: string;
		target: string;
		type: string;
	}>;
	codebaseInfo: {
		type: string;
		framework: string;
		features: string[];
	};
}

/**
 * Cache entry for AI descriptions
 */
interface CacheEntry {
	description: AINodeDescription;
	timestamp: number;
}

/**
 * AI Architecture Enhancer
 *
 * Uses DeepSeek AI to enhance architecture visualization with:
 * - Natural language descriptions for components
 * - Pattern detection (MVC, Clean Architecture, etc.)
 * - Smart categorization of ambiguous code
 * - Insights and suggestions
 */
export class AIArchitectureEnhancer {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly cacheTtlMs = 10 * 60 * 1000; // 10 minutes
	private readonly maxBatchSize = 20; // Max nodes to analyze in one request

	constructor(
		private readonly logService: ILogService,
		private readonly requestService: IRequestService,
		private readonly configurationService: IConfigurationService
	) { }

	/**
	 * Enhance an architecture payload with AI-generated descriptions
	 */
	async enhance(
		payload: SmartArchPayload,
		codebaseType: string,
		framework: string,
		token: CancellationToken
	): Promise<SmartArchPayload> {
		const serverAddress = this.getServerAddress();
		if (!serverAddress) {
			this.logService.warn('[AIArchitectureEnhancer] No server address configured');
			return payload;
		}

		try {
			// Get nodes that need descriptions
			const allNodes = getPayloadNodes(payload);
			const allEdges = getPayloadEdges(payload);
			const nodesToEnhance = allNodes.filter(
				node => !node.aiDescription && !this.getCachedDescription(node.id)
			);

			if (nodesToEnhance.length === 0) {
				// Apply cached descriptions
				return this.applyCachedDescriptions(payload);
			}

			// Process in batches
			const batches = this.createBatches(nodesToEnhance, this.maxBatchSize);

			for (const batch of batches) {
				if (token.isCancellationRequested) {
					break;
				}

				const descriptions = await this.fetchDescriptions(
					batch,
					allEdges,
					codebaseType,
					framework,
					serverAddress,
					token
				);

				// Cache the descriptions
				for (const desc of descriptions) {
					this.cache.set(desc.nodeId, {
						description: desc,
						timestamp: Date.now()
					});
				}
			}

			// Apply all descriptions (from cache and new)
			return this.applyCachedDescriptions(payload);
		} catch (error) {
			this.logService.warn('[AIArchitectureEnhancer] Error enhancing architecture:', error);
			return payload;
		}
	}

	/**
	 * Get a full AI analysis of the architecture
	 */
	async analyzeArchitecture(
		payload: SmartArchPayload,
		codebaseType: string,
		framework: string,
		features: string[],
		token: CancellationToken
	): Promise<AIArchitectureAnalysis | null> {
		const serverAddress = this.getServerAddress();
		if (!serverAddress) {
			this.logService.warn('[AIArchitectureEnhancer] No server address configured');
			return null;
		}

		try {
			const allNodes = getPayloadNodes(payload);
			const allEdges = getPayloadEdges(payload);
			const request: AIAnalysisRequest = {
				nodes: allNodes.map(n => ({
					id: n.id,
					type: n.type,
					label: n.label,
					layer: n.layer,
					filePath: n.filePath,
					metadata: n.metadata
				})),
				edges: allEdges.map(e => ({
					source: e.source,
					target: e.target,
					type: e.type
				})),
				codebaseInfo: {
					type: codebaseType,
					framework,
					features
				}
			};

			const response = await this.requestService.request(
				{
					type: 'POST',
					url: `${serverAddress}/api/architecture/analyze`,
					headers: {
						'Content-Type': 'application/json'
					},
					data: JSON.stringify(request)
				},
				token
			);

			const responseText = await asText(response);
			if (!responseText) {
				return null;
			}

			return JSON.parse(responseText) as AIArchitectureAnalysis;
		} catch (error) {
			this.logService.warn('[AIArchitectureEnhancer] Error analyzing architecture:', error);
			return null;
		}
	}

	/**
	 * Get AI-generated description for a single node
	 */
	async getNodeDescription(
		node: ArchNode,
		context: { codebaseType: string; framework: string },
		token: CancellationToken
	): Promise<AINodeDescription | null> {
		// Check cache first
		const cached = this.getCachedDescription(node.id);
		if (cached) {
			return cached;
		}

		const serverAddress = this.getServerAddress();
		if (!serverAddress) {
			return null;
		}

		try {
			const descriptions = await this.fetchDescriptions(
				[node],
				[],
				context.codebaseType,
				context.framework,
				serverAddress,
				token
			);

			if (descriptions.length > 0) {
				const desc = descriptions[0];
				this.cache.set(node.id, {
					description: desc,
					timestamp: Date.now()
				});
				return desc;
			}

			return null;
		} catch (error) {
			this.logService.debug(`[AIArchitectureEnhancer] Error getting description for ${node.id}:`, error);
			return null;
		}
	}

	/**
	 * Fetch descriptions from the AI server
	 */
	private async fetchDescriptions(
		nodes: ArchNode[],
		edges: ArchEdge[],
		codebaseType: string,
		framework: string,
		serverAddress: string,
		token: CancellationToken
	): Promise<AINodeDescription[]> {
		// Build the prompt for DeepSeek
		const prompt = this.buildPrompt(nodes, edges, codebaseType, framework);

		try {
			const response = await this.requestService.request(
				{
					type: 'POST',
					url: `${serverAddress}/api/architecture/describe`,
					headers: {
						'Content-Type': 'application/json'
					},
					data: JSON.stringify({
						model: 'deepseek-chat',
						prompt,
						nodes: nodes.map(n => ({
							id: n.id,
							type: n.type,
							label: n.label,
							layer: n.layer,
							filePath: n.filePath
						}))
					})
				},
				token
			);

			const responseText = await asText(response);
			if (!responseText) {
				return [];
			}

			const result = JSON.parse(responseText);
			return result.descriptions ?? [];
		} catch (error) {
			this.logService.debug('[AIArchitectureEnhancer] Error fetching descriptions:', error);

			// Return fallback descriptions
			return nodes.map(node => this.generateFallbackDescription(node));
		}
	}

	/**
	 * Build a prompt for the AI
	 */
	private buildPrompt(
		nodes: ArchNode[],
		edges: ArchEdge[],
		codebaseType: string,
		framework: string
	): string {
		const nodeDescriptions = nodes.map(node => {
			const connections = edges.filter(
				e => e.source === node.id || e.target === node.id
			);

			return `
- ${node.label} (${node.type})
  Layer: ${node.layer}
  File: ${node.filePath ?? 'unknown'}
  Connections: ${connections.length} (${connections.map(c => c.type).join(', ')})
  Metadata: ${JSON.stringify(node.metadata)}`;
		}).join('\n');

		return `You are analyzing a ${codebaseType} codebase built with ${framework}.

Given these architecture components:
${nodeDescriptions}

For each component, provide:
1. A brief 1-sentence description of what it does
2. Its purpose in the overall architecture
3. The category it belongs to (e.g., "data-access", "business-logic", "presentation")
4. Any design patterns detected

Respond in JSON format with an array of objects containing:
- nodeId: the component ID
- description: brief description
- purpose: architectural purpose
- category: component category
- patterns: array of detected patterns`;
	}

	/**
	 * Generate a fallback description when AI is unavailable
	 */
	private generateFallbackDescription(node: ArchNode): AINodeDescription {
		const typeDescriptions: Record<string, string> = {
			page: 'A page component that renders a full view',
			layout: 'A layout component that wraps page content',
			component: 'A reusable UI component',
			hook: 'A custom React hook for shared logic',
			context: 'A React context provider for state sharing',
			store: 'A state management store',
			route: 'A route definition',
			endpoint: 'An API endpoint handler',
			controller: 'A controller that handles HTTP requests',
			service: 'A service containing business logic',
			repository: 'A repository for data access',
			middleware: 'Middleware for request processing',
			model: 'A data model definition',
			database: 'Database connection',
			utility: 'A utility module',
			config: 'Configuration settings',
			external: 'An external dependency',
			package: 'A package or library'
		};

		const categoryMap: Record<string, string> = {
			page: 'presentation',
			layout: 'presentation',
			component: 'presentation',
			hook: 'logic',
			context: 'state-management',
			store: 'state-management',
			route: 'routing',
			endpoint: 'api',
			controller: 'api',
			service: 'business-logic',
			repository: 'data-access',
			middleware: 'infrastructure',
			model: 'data-model',
			database: 'data-access',
			utility: 'utility',
			config: 'configuration',
			external: 'external',
			package: 'external'
		};

		return {
			nodeId: node.id,
			description: typeDescriptions[node.type] ?? `A ${node.type} component`,
			purpose: `Serves as a ${node.layer} layer component`,
			category: categoryMap[node.type] ?? 'unknown',
			patterns: []
		};
	}

	/**
	 * Apply cached descriptions to a payload
	 */
	private applyCachedDescriptions(payload: SmartArchPayload): SmartArchPayload {
		const enhanceNodes = (nodes: ArchNode[]): ArchNode[] => {
			return nodes.map(node => {
				const cached = this.getCachedDescription(node.id);
				if (cached && !node.aiDescription) {
					return {
						...node,
						aiDescription: cached.description,
						description: node.description ?? cached.purpose
					};
				}
				return node;
			});
		};

		if (isFrontendPayload(payload)) {
			return {
				...payload,
				nodes: enhanceNodes(payload.nodes)
			};
		}

		if (isBackendPayload(payload)) {
			return {
				...payload,
				nodes: enhanceNodes(payload.nodes)
			};
		}

		// Fullstack payload
		return {
			...payload,
			frontend: {
				...payload.frontend,
				nodes: enhanceNodes(payload.frontend.nodes)
			},
			backend: {
				...payload.backend,
				nodes: enhanceNodes(payload.backend.nodes)
			}
		};
	}

	/**
	 * Get a cached description if it exists and is not expired
	 */
	private getCachedDescription(nodeId: string): AINodeDescription | null {
		const entry = this.cache.get(nodeId);
		if (!entry) {
			return null;
		}

		if (Date.now() - entry.timestamp > this.cacheTtlMs) {
			this.cache.delete(nodeId);
			return null;
		}

		return entry.description;
	}

	/**
	 * Create batches from an array
	 */
	private createBatches<T>(items: T[], batchSize: number): T[][] {
		const batches: T[][] = [];
		for (let i = 0; i < items.length; i += batchSize) {
			batches.push(items.slice(i, i + batchSize));
		}
		return batches;
	}

	/**
	 * Get the server address from configuration
	 */
	private getServerAddress(): string | undefined {
		// Try to get from configuration (same as metricsService)
		const configuredAddress = this.configurationService.getValue<string>('renide.server.address');
		if (configuredAddress) {
			return configuredAddress;
		}

		// Try env variable
		const envAddress = (globalThis as Record<string, unknown>)['SERVER_ADDRESS'] as string | undefined;
		if (envAddress) {
			return envAddress;
		}

		// Default to localhost:8787 in dev mode (same as metricsService)
		return 'http://localhost:8787';
	}

	/**
	 * Clear the cache
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): { size: number; oldestEntry: number | null } {
		let oldest: number | null = null;

		const entries = Array.from(this.cache.values());
		for (const entry of entries) {
			if (oldest === null || entry.timestamp < oldest) {
				oldest = entry.timestamp;
			}
		}

		return {
			size: this.cache.size,
			oldestEntry: oldest
		};
	}
}
