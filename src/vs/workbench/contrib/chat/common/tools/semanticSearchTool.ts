/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { localize } from "../../../../../nls.js";
import { env } from "../../../../../base/common/process.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../../platform/secrets/common/secrets.js";
import { IProductService } from "../../../../../platform/product/common/productService.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from "../../common/languageModelToolsService.js";
import {
	asJson,
	isSuccess,
} from "../../../../../platform/request/common/request.js";
import { computeWorkspaceHashSync } from "../../../../contrib/renViews/browser/services/workspaceHash.js";

export const SemanticSearchToolData: IToolData = {
	id: "search_codebase",
	toolReferenceName: "searchCodebase",
	displayName: localize("semanticSearchTool.displayName", "Search Codebase"),
	modelDescription: localize(
		"semanticSearchTool.modelDescription",
		"Searches the codebase using semantic similarity to find relevant code chunks. Use this when you need to find code related to a specific concept, function, or feature. The search uses vector embeddings to understand the semantic meaning of your query, not just keyword matching."
	),
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: localize(
					"semanticSearchTool.query",
					'Natural language query describing what code to find. For example: "authentication logic", "database connection handling", "error handling for API requests".'
				),
			},
			limit: {
				type: "number",
				description: localize(
					"semanticSearchTool.limit",
					"Maximum number of results to return. Defaults to 5, maximum is 25."
				),
			},
		},
		required: ["query"],
	},
};

export interface ISemanticSearchToolInput {
	query: string;
	limit?: number;
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
	private cachedProjectHash: string | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService
		private readonly secretStorageService: ISecretStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService
	) {}

	/**
	 * Detect programming language from file extension for better context
	 */
	private detectLanguage(filePath: string): string {
		const extension = filePath.split(".").pop()?.toLowerCase() || "";
		const languageMap: Record<string, string> = {
			ts: "TypeScript",
			tsx: "TypeScript",
			js: "JavaScript",
			jsx: "JavaScript",
			mjs: "JavaScript",
			py: "Python",
			pyw: "Python",
			java: "Java",
			kt: "Kotlin",
			go: "Go",
			rs: "Rust",
			c: "C",
			cpp: "C++",
			h: "C/C++",
			hpp: "C++",
			cs: "C#",
			rb: "Ruby",
			php: "PHP",
			swift: "Swift",
			sql: "SQL",
			html: "HTML",
			css: "CSS",
			scss: "SCSS",
			json: "JSON",
			yaml: "YAML",
			yml: "YAML",
			md: "Markdown",
			sh: "Shell",
			bash: "Shell",
		};
		return languageMap[extension] || "";
	}

	/**
	 * Get relevance tier based on similarity score for clearer result interpretation
	 */
	private getRelevanceTier(similarity: number): string {
		if (similarity >= 0.7) {
			return "HIGH";
		} else if (similarity >= 0.5) {
			return "MEDIUM";
		} else {
			return "LOW";
		}
	}

	async prepareToolInvocation(
		context: IToolInvocationPreparationContext,
		token: CancellationToken
	): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ISemanticSearchToolInput;
		return {
			invocationMessage: localize(
				"semanticSearchTool.invocationMessage",
				"Searching codebase for: {0}",
				args.query
			),
			pastTenseMessage: localize(
				"semanticSearchTool.pastTenseMessage",
				"Searched codebase for: {0}",
				args.query
			),
		};
	}

	private getServerUrl(): string {
		// Try to get server URL from environment variable first (same as chatgpt agent)
		let baseUrl = env["SERVER_ADDRESS"];

		if (!baseUrl) {
			// Fall back to product service (same pattern as RenApiClient)
			baseUrl = this.productService.renAccount?.apiBaseUrl;
		}

		if (!baseUrl) {
			// Default fallback
			baseUrl = "https://api.ren-ide.com";
			this.logService.warn(
				`[SemanticSearchTool] No server URL configured. SERVER_ADDRESS env var and renAccount.apiBaseUrl both missing. Using default: ${baseUrl}`
			);
		} else {
			this.logService.info(`[SemanticSearchTool] Using server URL: ${baseUrl}`);
		}

		// Normalize the URL
		let normalizedUrl = baseUrl.trim();
		if (
			!normalizedUrl.startsWith("http://") &&
			!normalizedUrl.startsWith("https://")
		) {
			this.logService.warn(
				`[SemanticSearchTool] Server URL missing protocol, assuming https://. Original: ${normalizedUrl}`
			);
			normalizedUrl = `https://${normalizedUrl}`;
		}
		// Remove trailing slashes
		normalizedUrl = normalizedUrl.replace(/\/+$/, "");

		return normalizedUrl;
	}

	private async getAccessToken(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get("ren.auth.accessToken");
		} catch (error) {
			this.logService.error(
				"[SemanticSearchTool] Failed to get access token:",
				error
			);
			return undefined;
		}
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
			this.logService.warn(
				"[SemanticSearchTool] No workspace folders available for project hash"
			);
			return undefined;
		}

		// Use the first workspace folder as the project identifier
		const workspaceRoot = folders[0].uri;
		this.cachedProjectHash = computeWorkspaceHashSync(workspaceRoot);
		this.logService.debug(
			`[SemanticSearchTool] Computed project hash: ${this.cachedProjectHash} for workspace: ${workspaceRoot.fsPath}`
		);

		return this.cachedProjectHash;
	}

	private formatCodeChunkResult(
		result: CodeChunkResult,
		index: number
	): string {
		const similarity = 1 - result.score; // Convert distance to similarity
		const similarityPercent = (similarity * 100).toFixed(0);
		const relevanceTier = this.getRelevanceTier(similarity);
		const language = this.detectLanguage(result.filePath);

		// Build header with relevance tier for quick scanning
		let formatted = `\n---\n### ${index + 1}. [${relevanceTier}] ${
			result.filePath
		}\n`;
		formatted += `   Lines ${result.startLine + 1}-${
			result.endLine + 1
		} | Similarity: ${similarityPercent}%`;
		if (language) {
			formatted += ` | Language: ${language}`;
		}
		formatted += "\n";

		// Add code snippet if available (increased limit for better context)
		if (result.code) {
			const maxCodeLength = 1000;
			const codeSnippet =
				result.code.length > maxCodeLength
					? result.code.substring(0, maxCodeLength) + "\n... (truncated)"
					: result.code;
			const langHint = language.toLowerCase().replace(/[^a-z]/g, "") || "";
			formatted += `\n\`\`\`${langHint}\n${codeSnippet}\n\`\`\`\n`;
		}

		// Add actionable hint for reading more
		formatted += `\n   To read full context: read file "${
			result.filePath
		}" lines ${result.startLine + 1}-${result.endLine + 1}\n`;

		// Add dependency information if available
		if (result.dependencyGraph) {
			const { files, symbols, functions } = result.dependencyGraph;
			const dependencies: string[] = [];

			if (files.length > 0) {
				dependencies.push(
					`Related files: ${files.slice(0, 3).join(", ")}${
						files.length > 3 ? ` (+${files.length - 3} more)` : ""
					}`
				);
			}
			if (symbols.length > 0) {
				const symbolNames = symbols
					.slice(0, 3)
					.map((s) => s.name)
					.join(", ");
				dependencies.push(
					`Symbols used: ${symbolNames}${
						symbols.length > 3 ? ` (+${symbols.length - 3} more)` : ""
					}`
				);
			}
			if (functions.length > 0) {
				const functionNames = functions
					.slice(0, 3)
					.map((f) => f.name)
					.join(", ");
				dependencies.push(
					`Functions: ${functionNames}${
						functions.length > 3 ? ` (+${functions.length - 3} more)` : ""
					}`
				);
			}

			if (dependencies.length > 0) {
				formatted += `   ${dependencies.join(" | ")}\n`;
			}
		}

		return formatted;
	}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		token: CancellationToken
	): Promise<IToolResult> {
		const args = invocation.parameters as ISemanticSearchToolInput;

		try {
			// Get access token
			const accessToken = await this.getAccessToken();
			if (!accessToken) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.noAuth",
								"Authentication required. Please log in to search the codebase."
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.noAuth",
						"Authentication required. Please log in to search the codebase."
					),
				};
			}

			// Get project hash for namespace isolation
			const projectHash = this.getProjectHash();
			if (!projectHash) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.noWorkspace",
								"No workspace folder available. Please open a workspace to search the codebase."
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.noWorkspace",
						"No workspace folder available. Please open a workspace to search the codebase."
					),
				};
			}

			// Get server URL
			const serverUrl = this.getServerUrl();
			// Handle case where serverUrl already ends with /api (same pattern as RenApiClient)
			let searchPath = "/api/code-chunks/search";
			if (serverUrl.endsWith("/api")) {
				searchPath = searchPath.substring(4); // Remove '/api' from the beginning
			}
			const searchUrl = `${serverUrl}${searchPath}`;

			this.logService.info(
				`[SemanticSearchTool] Making request to: ${searchUrl} with projectHash: ${projectHash}`
			);

			// Prepare request body - projectHash is required for project-scoped search
			const requestBody: any = {
				query: args.query,
				projectHash,
			};
			if (args.limit !== undefined) {
				requestBody.limit = Math.min(Math.max(1, args.limit), 25);
			}

			// Make request to server
			let response;
			try {
				response = await this.requestService.request(
					{
						type: "POST",
						url: searchUrl,
						data: JSON.stringify(requestBody),
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${accessToken}`,
						},
					},
					token
				);
			} catch (fetchError) {
				// Handle network errors (CORS, connection refused, etc.)
				const errorMessage =
					fetchError instanceof Error ? fetchError.message : String(fetchError);
				this.logService.error(
					`[SemanticSearchTool] Network error when calling ${searchUrl}:`,
					fetchError
				);
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.networkError",
								"Failed to connect to server at {0}. Please check your network connection and ensure the server is running. Error: {1}",
								serverUrl,
								errorMessage
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.networkErrorShort",
						"Network error: {0}",
						errorMessage
					),
				};
			}

			if (!isSuccess(response)) {
				const errorText = await this.getErrorText(response);
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.requestError",
								"Failed to search codebase: {0}",
								errorText
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.requestError",
						"Failed to search codebase: {0}",
						errorText
					),
				};
			}

			// Parse response
			const searchResponse = await asJson<SearchResponse>(response);
			if (!searchResponse) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.invalidResponse",
								"Invalid response from server"
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.invalidResponse",
						"Invalid response from server"
					),
				};
			}

			// Format results
			if (!searchResponse.results || searchResponse.results.length === 0) {
				return {
					content: [
						{
							kind: "text",
							value: localize(
								"semanticSearchTool.noResults",
								'No code chunks found matching query: "{0}"',
								args.query
							),
						},
					],
					toolResultMessage: localize(
						"semanticSearchTool.noResults",
						'No code chunks found matching query: "{0}"',
						args.query
					),
				};
			}

			// Format results for agent consumption
			let resultText = localize(
				"semanticSearchTool.resultsHeader",
				'## Semantic Search Results\n\nFound {0} code chunk(s) matching "{1}"',
				searchResponse.results.length,
				args.query
			);

			// Add relevance tier legend
			resultText +=
				"\n\n**Relevance Tiers:** HIGH (>=70%) = strong match | MEDIUM (50-69%) = related | LOW (<50%) = possibly relevant";

			for (let i = 0; i < searchResponse.results.length; i++) {
				resultText += this.formatCodeChunkResult(searchResponse.results[i], i);
			}

			// Add guidance for agent
			resultText += `\n---\n**Tips:** Focus on HIGH relevance results first. Use the file read tool to get full context if needed. If results seem off, try rephrasing your query as a question.`;

			return {
				content: [
					{
						kind: "text",
						value: resultText,
					},
				],
				toolResultMessage: localize(
					"semanticSearchTool.success",
					"Found {0} code chunk(s)",
					searchResponse.results.length
				),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logService.error(
				"[SemanticSearchTool] Error searching codebase:",
				error
			);
			return {
				content: [
					{
						kind: "text",
						value: localize(
							"semanticSearchTool.error",
							"Error searching codebase: {0}",
							errorMessage
						),
					},
				],
				toolResultMessage: localize(
					"semanticSearchTool.error",
					"Error searching codebase: {0}",
					errorMessage
				),
			};
		}
	}

	private async getErrorText(response: any): Promise<string> {
		try {
			const errorData = await asJson<{ error?: string; message?: string }>(
				response
			);
			return (
				errorData?.message ||
				errorData?.error ||
				`HTTP ${response.res.statusCode}`
			);
		} catch {
			return `HTTP ${response.res.statusCode}`;
		}
	}
}
