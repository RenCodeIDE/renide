import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService, ITextQuery, QueryType, IPatternInfo, ISearchProgressItem, resultIsMatch, isFileMatch, ExcludeGlobPattern } from '../../../../services/search/common/search.js';
import { IExpression } from '../../../../../base/common/glob.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../common/languageModelToolsService.js';

export const SearchFilesToolData: IToolData = {
	id: 'search_files',
	toolReferenceName: 'searchFiles',
	displayName: localize('searchFilesTool.displayName', 'Search Files'),
	modelDescription: localize('searchFilesTool.modelDescription',
		`Searches for text patterns across files using ripgrep.

USE THIS WHEN:
- Looking for specific code patterns, function calls, or variable names
- Finding where something is defined or used
- Exploring unfamiliar codebase
- User asks about occurrences of text

PREFER OVER readFile WHEN: You need to find WHERE code exists, not just read a known file.
PREFER searchCodebase WHEN: You want conceptual/semantic search (e.g., "authentication logic").

EXAMPLES:
- "Find all uses of getUserData" → search for "getUserData"
- "Where is the API defined" → search for "api" or specific endpoint names
- "Find the login handler" → search for "login" with includePattern:"*.ts"`),
	source: ToolDataSource.Internal,
	category: 'search',
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: localize('searchFilesTool.pattern', 'The text pattern to search for. Can be a plain string or regular expression if useRegex is true.')
			},
			folder: {
				type: 'string',
				description: localize('searchFilesTool.folder', 'Optional: The workspace folder to search in. If not specified, searches all workspace folders.')
			},
			includePattern: {
				type: 'string',
				description: localize('searchFilesTool.includePattern', 'Optional: File glob patterns to include (e.g., "*.ts", "**/*.js"). Filenames without wildcards will use fuzzy matching (e.g., "config" matches "config.json", "config.yaml"). Multiple patterns can be separated by commas.')
			},
			excludePattern: {
				type: 'string',
				description: localize('searchFilesTool.excludePattern', 'Optional: File glob patterns to exclude (e.g., "node_modules/**", "*.min.js"). Multiple patterns can be separated by commas.')
			},
			caseSensitive: {
				type: 'boolean',
				description: localize('searchFilesTool.caseSensitive', 'Optional: Whether the search should be case-sensitive. Defaults to false.')
			},
			useRegex: {
				type: 'boolean',
				description: localize('searchFilesTool.useRegex', 'Optional: Whether to treat the pattern as a regular expression. Defaults to false.')
			},
			maxResults: {
				type: 'number',
				description: localize('searchFilesTool.maxResults', 'Optional: Maximum number of results to return. Defaults to 1000.')
			}
		},
		required: ['pattern']
	},
	// Smart default: use selection text as search pattern if available
	resolveDefaults: (ctx) => {
		const defaults: Partial<Record<string, unknown>> = {};
		// If user has text selected, search for that
		if (ctx.selectionText && ctx.selectionText.trim().length > 0 && ctx.selectionText.length < 100) {
			defaults.pattern = ctx.selectionText.trim();
		}
		// Default folder to workspace root
		if (ctx.workspaceRoot) {
			defaults.folder = ctx.workspaceRoot.fsPath;
		}
		return defaults;
	}
};

export interface ISearchFilesToolInput {
	pattern: string;
	folder?: string;
	includePattern?: string;
	excludePattern?: string;
	caseSensitive?: boolean;
	useRegex?: boolean;
	maxResults?: number;
}

export class SearchFilesTool implements IToolImpl {
	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as ISearchFilesToolInput;

		return {
			invocationMessage: localize('searchFilesTool.invocationMessage', 'Searching for: {0}', args.pattern),
			pastTenseMessage: localize('searchFilesTool.pastTenseMessage', 'Searched for: {0}', args.pattern),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const args = invocation.parameters as ISearchFilesToolInput;
		console.log('[SearchFilesTool] invoke called with args:', JSON.stringify(args));

		if (!args) {
			return {
				content: [{ innerText: localize('searchFilesTool.noArgs', 'No arguments provided') }],
				toolResultMessage: localize('searchFilesTool.noArgs', 'No arguments provided')
			} as any;
		}

		if (!args.pattern || typeof args.pattern !== 'string') {
			return {
				content: [{
					kind: 'text',
					value: localize('searchFilesTool.invalidPattern',
						`Invalid or missing "pattern" argument. The pattern parameter is REQUIRED and must be a non-empty string.

RECOVERY: You must provide a pattern to search for. Examples:
- searchFiles({ pattern: "function name" })
- searchFiles({ pattern: "*.tsx", includePattern: "*.tsx" })
- If looking for a FILE, use the filename as the pattern

ALTERNATIVE: If you cannot determine what to search for, ask the user what text or code they want to find.`)
				}],
				toolResultMessage: localize('searchFilesTool.invalidPatternShort', 'Missing required "pattern" argument. Please provide a search pattern.')
			};
		}

		try {
			// Determine workspace folders to search
			const workspace = this.workspaceService.getWorkspace();
			let folders = workspace.folders.map(f => f.uri);

			if (args.folder) {
				const folderUri = this.parseUri(args.folder);
				// Check if the specified folder is in the workspace
				const folderInWorkspace = folders.find(f =>
					folderUri.toString().startsWith(f.toString()) || folderUri.toString() === f.toString()
				);
				if (folderInWorkspace) {
					folders = [folderUri];
				} else {
					// If folder is not in workspace, try to use it anyway
					folders = [folderUri];
				}
			}

			if (folders.length === 0) {
				return {
					content: [{
						kind: 'text',
						value: localize('searchFilesTool.noWorkspace', 'No workspace folder found to search in.')
					}],
					toolResultMessage: localize('searchFilesTool.noWorkspace', 'No workspace folder found to search in.')
				};
			}

			// Build search query
			const patternInfo: IPatternInfo = {
				pattern: args.pattern,
				isRegExp: args.useRegex ?? false,
				isCaseSensitive: args.caseSensitive ?? false,
			};

			// Parse include/exclude patterns
			let includePattern: IExpression | undefined;
			if (args.includePattern && typeof args.includePattern === 'string') {
				includePattern = this.parseGlobPattern(args.includePattern);
			}

			let excludePattern: ExcludeGlobPattern<URI>[] | undefined;
			if (args.excludePattern && typeof args.excludePattern === 'string') {
				excludePattern = folders.map(folder => ({
					folder,
					pattern: this.parseGlobPattern(args.excludePattern!)
				}));
			}

			const query: ITextQuery = {
				type: QueryType.Text,
				contentPattern: patternInfo,
				folderQueries: folders.map(folder => ({
					folder,
					includePattern,
					excludePattern,
				})),
				maxResults: args.maxResults ?? 1000,
			};

			// Collect search results
			const results: string[] = [];
			let resultCount = 0;
			const maxResults = args.maxResults ?? 1000;

			await this.searchService.textSearch(query, token, (progress: ISearchProgressItem) => {
				if (isFileMatch(progress)) {
					const fileMatch = progress;
					if (fileMatch.results && fileMatch.results.length > 0) {
						const relativePath = this.getRelativePath(fileMatch.resource);
						results.push(`\n${relativePath}:`);

						for (const result of fileMatch.results) {
							if (resultIsMatch(result)) {
								resultCount++;
								if (resultCount > maxResults) {
									return; // Stop collecting if we hit the limit
								}

								// Format match result
								const match = result;
								if (match.rangeLocations && match.rangeLocations.length > 0) {
									for (const rangeLocation of match.rangeLocations) {
										const lineNumber = rangeLocation.source.startLineNumber;
										const column = rangeLocation.source.startColumn;
										const preview = match.previewText || '';
										results.push(`  ${lineNumber}:${column} ${preview.trim()}`);
									}
								}
							}
						}
					}
				}
			});

			if (results.length === 0) {
				return {
					content: [{
						kind: 'text',
						value: localize('searchFilesTool.noResults', 'No results found for pattern: {0}', args.pattern)
					}],
					toolResultMessage: localize('searchFilesTool.noResults', 'No results found for pattern: {0}', args.pattern)
				};
			}

			const resultText = results.join('\n');
			const summary = localize('searchFilesTool.summary', 'Found {0} result(s) for pattern "{1}"', resultCount, args.pattern);

			return {
				content: [{
					kind: 'text',
					value: `${summary}\n${resultText}`
				}],
				toolResultMessage: summary
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: localize('searchFilesTool.error', 'Error searching files: {0}', errorMessage)
				}],
				toolResultMessage: localize('searchFilesTool.error', 'Error searching files: {0}', errorMessage)
			};
		}
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
				if (uriString.startsWith('/') || (uriString.match(/^[A-Za-z]:/) && uriString.length > 2 && uriString[2] === '/')) {
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

	private parseGlobPattern(pattern: string): IExpression {
		// Convert comma-separated patterns to glob expression
		const patterns = pattern.split(',').map(p => p.trim()).filter(p => p.length > 0);
		const result: Record<string, boolean> = {};
		for (const p of patterns) {
			// Check if it's a simple filename (no wildcards, no path separators) - apply fuzzy matching
			if (!p.includes('*') && !p.includes('?') && !p.includes('/') && !(isWindows && p.includes('\\'))) {
				// Simple filename - apply fuzzy matching
				const fuzzyPattern = '*' + p.split('').join('*') + '*';
				// Make case-insensitive
				let caseInsensitivePattern = '';
				for (let i = 0; i < fuzzyPattern.length; i++) {
					const char = fuzzyPattern[i];
					if (/[a-zA-Z]/.test(char)) {
						caseInsensitivePattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
					} else {
						caseInsensitivePattern += char;
					}
				}
				result[`**/${caseInsensitivePattern}`] = true;
			} else {
				result[p] = true;
			}
		}
		return result;
	}

	private getRelativePath(uri: URI): string {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return uri.fsPath;
		}

		const rootPath = workspace.folders[0].uri.fsPath;
		const absolutePath = uri.fsPath;

		if (absolutePath.startsWith(rootPath)) {
			return absolutePath.slice(rootPath.length).replace(/^[\\/]+/, '');
		}

		return uri.fsPath;
	}
}

