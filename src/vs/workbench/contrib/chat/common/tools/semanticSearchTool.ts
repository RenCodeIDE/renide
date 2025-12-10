/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { env } from '../../../../../base/common/process.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';
import { asJson, isSuccess } from '../../../../../platform/request/common/request.js';

export const SemanticSearchToolData: IToolData = {
	id: 'search_codebase',
	toolReferenceName: 'searchCodebase',
	displayName: localize('semanticSearchTool.displayName', 'Search Codebase'),
	modelDescription: localize('semanticSearchTool.modelDescription', 'Searches the codebase using semantic similarity to find relevant code chunks. Use this when you need to find code related to a specific concept, function, or feature. The search uses vector embeddings to understand the semantic meaning of your query, not just keyword matching.'),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: localize('semanticSearchTool.query', 'Natural language query describing what code to find. For example: "authentication logic", "database connection handling", "error handling for API requests".')
			},
			limit: {
				type: 'number',
				description: localize('semanticSearchTool.limit', 'Maximum number of results to return. Defaults to 5, maximum is 25.')
			},
			filePath: {
				type: 'string',
				description: localize('semanticSearchTool.filePath', 'Optional: Filter results to specific file path pattern. For example: "src/utils" or "auth.ts".')
			}
		},
		required: ['query']
	}
};

export interface ISemanticSearchToolInput {
	query: string;
	limit?: number;
	filePath?: string;
}

interface CodeChunkResult {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	code?: string;
	merkleHash?: string;
	dependencyGraph: {
		files: string[];
		symbols: Array<{
			name: string;
			kind: string;
			uri: string;
			range?: {
				startLineNumber?: number;
				startColumn?: number;
				endLineNumber?: number;
				endColumn?: number;
			};
		}>;
		functions: Array<{
			name: string;
			uri: string;
			signature?: string;
			range?: {
				startLineNumber?: number;
				startColumn?: number;
				endLineNumber?: number;
				endColumn?: number;
			};
		}>;
	};
	ordinal?: number | null;
	parentHash?: string | null;
	userName: string;
}

interface SearchResponse {
	query: string;
	limit: number;
	results: CodeChunkResult[];
}

export class SemanticSearchTool implements IToolImpl {
	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ISemanticSearchToolInput;
		return {
			invocationMessage: localize('semanticSearchTool.invocationMessage', 'Searching codebase for: {0}', args.query),
			pastTenseMessage: localize('semanticSearchTool.pastTenseMessage', 'Searched codebase for: {0}', args.query),
		};
	}

	private getServerUrl(): string {
		// Try to get server URL from environment variable first (same as chatgpt agent)
		let baseUrl = env['SERVER_ADDRESS'];

		if (!baseUrl) {
			// Fall back to product service (same pattern as RenApiClient)
			baseUrl = this.productService.renAccount?.apiBaseUrl;
		}

		if (!baseUrl) {
			// Default fallback
			baseUrl = 'https://api.ren-ide.com';
			this.logService.warn(`[SemanticSearchTool] No server URL configured. SERVER_ADDRESS env var and renAccount.apiBaseUrl both missing. Using default: ${baseUrl}`);
		} else {
			this.logService.info(`[SemanticSearchTool] Using server URL: ${baseUrl}`);
		}

		// Normalize the URL
		let normalizedUrl = baseUrl.trim();
		if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
			this.logService.warn(`[SemanticSearchTool] Server URL missing protocol, assuming https://. Original: ${normalizedUrl}`);
			normalizedUrl = `https://${normalizedUrl}`;
		}
		// Remove trailing slashes
		normalizedUrl = normalizedUrl.replace(/\/+$/, '');

		return normalizedUrl;
	}

	private async getAccessToken(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get('ren.auth.accessToken');
		} catch (error) {
			this.logService.error('[SemanticSearchTool] Failed to get access token:', error);
			return undefined;
		}
	}

	private formatCodeChunkResult(result: CodeChunkResult, index: number): string {
		const similarity = (1 - result.score).toFixed(2); // Convert distance to similarity
		let formatted = `\n${index + 1}. ${result.filePath}:${result.startLine}-${result.endLine} (similarity: ${similarity})\n`;

		// Add code snippet if available (truncate if too long)
		if (result.code) {
			const maxCodeLength = 500;
			const codeSnippet = result.code.length > maxCodeLength
				? result.code.substring(0, maxCodeLength) + '...'
				: result.code;
			formatted += `\n\`\`\`\n${codeSnippet}\n\`\`\`\n`;
		}

		// Add dependency information if available
		if (result.dependencyGraph) {
			const { files, symbols, functions } = result.dependencyGraph;
			const dependencies: string[] = [];

			if (files.length > 0) {
				dependencies.push(`Files: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}`);
			}
			if (symbols.length > 0) {
				const symbolNames = symbols.slice(0, 3).map(s => s.name).join(', ');
				dependencies.push(`Symbols: ${symbolNames}${symbols.length > 3 ? ` (+${symbols.length - 3} more)` : ''}`);
			}
			if (functions.length > 0) {
				const functionNames = functions.slice(0, 3).map(f => f.name).join(', ');
				dependencies.push(`Functions: ${functionNames}${functions.length > 3 ? ` (+${functions.length - 3} more)` : ''}`);
			}

			if (dependencies.length > 0) {
				formatted += `\n   Dependencies: ${dependencies.join('; ')}\n`;
			}
		}

		return formatted;
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ISemanticSearchToolInput;

		try {
			// Get access token
			const accessToken = await this.getAccessToken();
			if (!accessToken) {
				return {
					content: [{
						kind: 'text',
						value: localize('semanticSearchTool.noAuth', 'Authentication required. Please log in to search the codebase.')
					}],
					toolResultMessage: localize('semanticSearchTool.noAuth', 'Authentication required. Please log in to search the codebase.')
				};
			}

			// Get server URL
			const serverUrl = this.getServerUrl();
			// Handle case where serverUrl already ends with /api (same pattern as RenApiClient)
			let searchPath = '/api/code-chunks/search';
			if (serverUrl.endsWith('/api')) {
				searchPath = searchPath.substring(4); // Remove '/api' from the beginning
			}
			const searchUrl = `${serverUrl}${searchPath}`;

			this.logService.info(`[SemanticSearchTool] Making request to: ${searchUrl}`);

			// Prepare request body
			const requestBody: any = {
				query: args.query,
			};
			if (args.limit !== undefined) {
				requestBody.limit = Math.min(Math.max(1, args.limit), 25);
			}
			if (args.filePath) {
				requestBody.filePath = args.filePath;
			}

			// Make request to server
			let response;
			try {
				response = await this.requestService.request({
					type: 'POST',
					url: searchUrl,
					data: JSON.stringify(requestBody),
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${accessToken}`,
					},
				}, token);
			} catch (fetchError) {
				// Handle network errors (CORS, connection refused, etc.)
				const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
				this.logService.error(`[SemanticSearchTool] Network error when calling ${searchUrl}:`, fetchError);
				return {
					content: [{
						kind: 'text',
						value: localize('semanticSearchTool.networkError', 'Failed to connect to server at {0}. Please check your network connection and ensure the server is running. Error: {1}', serverUrl, errorMessage)
					}],
					toolResultMessage: localize('semanticSearchTool.networkErrorShort', 'Network error: {0}', errorMessage)
				};
			}

			if (!isSuccess(response)) {
				const errorText = await this.getErrorText(response);
				return {
					content: [{
						kind: 'text',
						value: localize('semanticSearchTool.requestError', 'Failed to search codebase: {0}', errorText)
					}],
					toolResultMessage: localize('semanticSearchTool.requestError', 'Failed to search codebase: {0}', errorText)
				};
			}

			// Parse response
			const searchResponse = await asJson<SearchResponse>(response);
			if (!searchResponse) {
				return {
					content: [{
						kind: 'text',
						value: localize('semanticSearchTool.invalidResponse', 'Invalid response from server')
					}],
					toolResultMessage: localize('semanticSearchTool.invalidResponse', 'Invalid response from server')
				};
			}

			// Format results
			if (!searchResponse.results || searchResponse.results.length === 0) {
				return {
					content: [{
						kind: 'text',
						value: localize('semanticSearchTool.noResults', 'No code chunks found matching query: "{0}"', args.query)
					}],
					toolResultMessage: localize('semanticSearchTool.noResults', 'No code chunks found matching query: "{0}"', args.query)
				};
			}

			// Format results for agent consumption
			let resultText = localize('semanticSearchTool.resultsHeader', 'Found {0} code chunk(s) matching "{1}":', searchResponse.results.length, args.query);

			for (let i = 0; i < searchResponse.results.length; i++) {
				resultText += this.formatCodeChunkResult(searchResponse.results[i], i);
			}

			// Add note about similarity scores
			resultText += `\n\n${localize('semanticSearchTool.similarityNote', 'Note: Similarity scores range from 0.0 to 1.0, where higher values indicate better semantic matches.')}`;

			return {
				content: [{
					kind: 'text',
					value: resultText
				}],
				toolResultMessage: localize('semanticSearchTool.success', 'Found {0} code chunk(s)', searchResponse.results.length)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logService.error('[SemanticSearchTool] Error searching codebase:', error);
			return {
				content: [{
					kind: 'text',
					value: localize('semanticSearchTool.error', 'Error searching codebase: {0}', errorMessage)
				}],
				toolResultMessage: localize('semanticSearchTool.error', 'Error searching codebase: {0}', errorMessage)
			};
		}
	}

	private async getErrorText(response: any): Promise<string> {
		try {
			const errorData = await asJson<{ error?: string; message?: string }>(response);
			return errorData?.message || errorData?.error || `HTTP ${response.res.statusCode}`;
		} catch {
			return `HTTP ${response.res.statusCode}`;
		}
	}
}

