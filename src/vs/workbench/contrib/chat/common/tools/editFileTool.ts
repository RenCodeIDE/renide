/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { MarkdownString } from "../../../../../base/common/htmlContent.js";
import { isWindows } from "../../../../../base/common/platform.js";
import { localize } from "../../../../../nls.js";
import { URI, UriComponents } from "../../../../../base/common/uri.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextEdit } from "../../../../../editor/common/languages.js";
import { CellUri } from "../../../notebook/common/notebookCommon.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { ISearchService, IFileQuery, QueryType, ISearchConfiguration, getExcludes } from "../../../../services/search/common/search.js";
import { INotebookService } from "../../../notebook/common/notebookService.js";
import { ICodeMapperService } from "../../common/chatCodeMapperService.js";
import { ChatModel } from "../../common/chatModel.js";
import { IChatService } from "../../common/chatService.js";
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolInvocationPresentation,
	ToolProgress,
} from "../../common/languageModelToolsService.js";

export const ExtensionEditToolId = "vscode_editFile";
export const InternalEditToolId = "vscode_editFile_internal";
export const EditToolData: IToolData = {
	id: InternalEditToolId,
	toolReferenceName: "vscode_editFile",
	displayName: "", // not used
	modelDescription:
		'REQUIRED: Always provide clear, descriptive changelog information. Subject: REQUIRED, 4-10 words, action-oriented (e.g., "Add user authentication module", "Fix memory leak in data processing", "Refactor database connection handling"). Description: REQUIRED, 2-5 sentences explaining what changed and why. UNACCEPTABLE subjects: "Update file", "Make changes", "Fix code", "Edit file" - these are too vague. GOOD examples: "Add error handling for network requests", "Fix race condition in async operations", "Refactor authentication to use JWT tokens". Use the explanation parameter for full context, and provide a clear subject and description for high-quality changelog entries.',
	source: ToolDataSource.Internal,
	category: 'file_operations',
	canBeReferencedInPrompt: true,
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Optional convenience: absolute file path (used if 'uri' is not provided).",
			},
			uri: {
				type: "object",
				description:
					"Target file URI components (from vscode URI.toJSON/UriComponents).",
			},
			explanation: {
				type: "string",
				description: "Full description of what and why you are changing.",
			},
			subject: {
				type: "string",
				description: "Short 5–8 word subject for changelog.",
			},
			description: {
				type: "string",
				description: "Concise 2–4 line description for changelog.",
			},
			code: {
				type: "string",
				description: "Complete file contents or code block to apply.",
			},
			contextFiles: {
				type: "array",
				description: "Related files for context.",
				items: {
					type: "object",
					properties: {
						uri: {
							type: "object",
							description: "URI components of context file.",
						},
						content: {
							type: "string",
							description: "Content of the context file.",
						},
						relevance: {
							type: "string",
							description: "Relevance: 'high' | 'medium' | 'low'.",
						},
					},
				},
			},
			editType: {
				type: "string",
				description:
					"Type of edit: 'replace' | 'insert' | 'delete' | 'modify'.",
			},
			anchorContext: {
				type: "object",
				description: "Anchor hints for precise placement.",
				properties: {
					lineNumber: { type: "number", description: "Target line number." },
					beforeText: { type: "string", description: "Text before the edit." },
					afterText: { type: "string", description: "Text after the edit." },
				},
			},
		},
		required: ["explanation", "code"],
	},
	// Smart default: use active file if user doesn't specify
	resolveDefaults: (ctx) => {
		const defaults: Partial<Record<string, unknown>> = {};
		if (ctx.activeFile) {
			defaults.path = ctx.activeFile.fsPath;
			defaults.uri = { scheme: ctx.activeFile.scheme, path: ctx.activeFile.path };
		}
		return defaults;
	},
	// IMPORTANT: This is the PREFERRED method for making file edits. Agents should:
	// - Use EditTool for all file modifications (rather than streaming textEdit progress)
	// - Always provide the 'explanation' parameter with a full description of the change
	// - Optionally provide a 'subject' parameter with a short 5-6 word one-liner for the changelog subject
	//   If subject is not provided, it will be extracted from the explanation
	// - This ensures reliable changelog tracking with proper subject/description
	//
	// The agent MUST provide the 'explanation' parameter. The 'subject' parameter is optional but recommended.
};

export interface EditToolParams {
	uri?: UriComponents | string;
	path?: string;
	explanation: string; // Required: Full description of the change
	subject?: string; // Optional: Short subject (5–8 words)
	description?: string; // Optional: Concise 2–4 line description; preferred for changelog
	code: string;
	// Enhanced parameters for better edit accuracy
	contextFiles?: Array<{
		uri: UriComponents;
		content: string;
		relevance?: "high" | "medium" | "low";
	}>; // Optional: Related files for context (imports, dependencies, etc.)
	editType?: "replace" | "insert" | "delete" | "modify"; // Optional: Type of edit operation
	anchorContext?: {
		lineNumber?: number; // Optional: Target line number for the edit
		beforeText?: string; // Optional: Text that should appear before the edit
		afterText?: string; // Optional: Text that should appear after the edit
	}; // Optional: Anchor context for precise edit placement
}

export class EditTool implements IToolImpl {
	constructor(
		@IChatService private readonly chatService: IChatService,
		@ICodeMapperService private readonly codeMapperService: ICodeMapperService,
		@INotebookService private readonly notebookService: INotebookService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) { }

	async invoke(
		invocation: IToolInvocation,
		countTokens: CountTokensCallback,
		_progress: ToolProgress,
		token: CancellationToken
	): Promise<IToolResult> {
		if (!invocation.context) {
			throw new Error("toolInvocationToken is required for this tool");
		}

		const parameters = invocation.parameters as EditToolParams;
		// Resolve target URI from multiple accepted forms: UriComponents, string uri, or path
		let fileUri: URI | undefined;
		if (parameters?.uri && typeof parameters.uri !== "string") {
			try {
				fileUri = URI.revive(parameters.uri as UriComponents);
			} catch {
				fileUri = undefined;
			}
		} else if (typeof parameters?.uri === "string") {
			try {
				// Check if it's a full path or just a filename
				if (this.isFullPath(parameters.uri)) {
					fileUri = this.resolveFileUri(parameters.uri);
				} else {
					// Filename - search workspace for matches
					const matches = await this.searchFilesByName(parameters.uri, token);
					if (matches.length === 0) {
						return {
							content: [{
								kind: 'text',
								value: localize('editFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', parameters.uri)
							}],
							toolResultMessage: localize('editFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', parameters.uri)
						};
					} else if (matches.length === 1) {
						// Single match - use it
						fileUri = matches[0];
					} else {
						// Multiple matches - try to pick the best one, or return list
						const preferredMatch = this.pickBestMatch(matches);
						if (preferredMatch) {
							// Use the preferred match
							fileUri = preferredMatch;
						} else {
							// Return list for model to choose
							const workspace = this.workspaceService.getWorkspace();
							const matchList = matches.map((uri, index) => {
								const relativePath = workspace.folders.length > 0
									? this.getRelativePath(uri, workspace.folders[0].uri)
									: uri.fsPath;
								return `${index + 1}. ${relativePath}`;
							}).join('\n');

							const fullMessage = localize('editFileTool.multipleMatches', 'Found {0} files matching "{1}":\n\n{2}\n\nPlease specify which file to edit by providing the full path or a more specific filename.', matches.length, parameters.uri, matchList);
							return {
								content: [{
									kind: 'text',
									value: fullMessage
								}],
								toolResultMessage: localize('editFileTool.multipleMatchesShort', 'Found {0} files matching "{1}". Please specify which file to edit.', matches.length, parameters.uri)
							};
						}
					}
				}
			} catch {
				fileUri = undefined;
			}
		} else if (
			typeof parameters?.path === "string" &&
			parameters.path.trim().length > 0
		) {
			try {
				// Check if it's a full path or just a filename
				if (this.isFullPath(parameters.path)) {
					fileUri = this.resolveFileUri(parameters.path);
				} else {
					// Filename - search workspace for matches
					const matches = await this.searchFilesByName(parameters.path, token);
					if (matches.length === 0) {
						return {
							content: [{
								kind: 'text',
								value: localize('editFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', parameters.path)
							}],
							toolResultMessage: localize('editFileTool.noMatches', 'No files found matching "{0}". Please provide a full path or a more specific filename.', parameters.path)
						};
					} else if (matches.length === 1) {
						// Single match - use it
						fileUri = matches[0];
					} else {
						// Multiple matches - try to pick the best one, or return list
						const preferredMatch = this.pickBestMatch(matches);
						if (preferredMatch) {
							// Use the preferred match
							fileUri = preferredMatch;
						} else {
							// Return list for model to choose
							const workspace = this.workspaceService.getWorkspace();
							const matchList = matches.map((uri, index) => {
								const relativePath = workspace.folders.length > 0
									? this.getRelativePath(uri, workspace.folders[0].uri)
									: uri.fsPath;
								return `${index + 1}. ${relativePath}`;
							}).join('\n');

							const fullMessage = localize('editFileTool.multipleMatches', 'Found {0} files matching "{1}":\n\n{2}\n\nPlease specify which file to edit by providing the full path or a more specific filename.', matches.length, parameters.path, matchList);
							return {
								content: [{
									kind: 'text',
									value: fullMessage
								}],
								toolResultMessage: localize('editFileTool.multipleMatchesShort', 'Found {0} files matching "{1}". Please specify which file to edit.', matches.length, parameters.path)
							};
						}
					}
				}
			} catch {
				fileUri = undefined;
			}
		}
		if (!fileUri) {
			return {
				content: [
					{
						kind: "text",
						value:
							"Edit failed: missing or invalid 'uri' or 'path'. Provide 'uri' (UriComponents or string) or 'path' (absolute or workspace-relative path).",
					},
				],
				toolResultMessage:
					"Edit failed: 'uri' (or 'path') is required to locate the target file.",
			};
		}
		const uri = CellUri.parse(fileUri)?.notebook || fileUri;

		const model = this.chatService.getSession(
			invocation.context?.sessionId
		) as ChatModel;
		const request = model.getRequests().at(-1)!;

		const editSession = model.editingSession;
		if (!editSession) {
			throw new Error(
				"This tool must be called from within an editing session"
			);
		}

		// CRITICAL: Store the explanation BEFORE sending any progress signals
		// The editing service checks for the explanation when processing textEdit parts
		// If the explanation is not stored yet, the edits will be rejected
		// responseModel.requestId is set to request.id when the response is created,
		// so we use request.id to store the explanation
		console.log(
			"[MonitorX] EditTool.invoke: PREFERRED PATH - Using EditTool for edits",
			{
				hasExplanation: !!parameters.explanation,
				hasSubject: !!parameters.subject,
				hasDescription: !!parameters.description,
				explanationType: typeof parameters.explanation,
				explanationLength:
					typeof parameters.explanation === "string"
						? parameters.explanation.length
						: 0,
				explanationPreview:
					typeof parameters.explanation === "string"
						? parameters.explanation.substring(0, 100)
						: undefined,
				subjectPreview:
					typeof parameters.subject === "string"
						? parameters.subject
						: undefined,
				descriptionPreview:
					typeof parameters.description === "string"
						? parameters.description.substring(0, 120)
						: undefined,
				uri: uri.toString(),
				requestId: request.id,
				chatRequestId: invocation.chatRequestId,
				allParams: Object.keys(parameters),
			}
		);

		// Explanation is required by the schema - without it, edits will be rejected
		if (!parameters.explanation) {
			console.error(
				"[MonitorX] EditTool.invoke: No explanation parameter provided - edits will be rejected",
				{
					uri: uri.toString(),
					parametersKeys: Object.keys(parameters),
					parameters: parameters,
				}
			);
			return {
				content: [
					{
						kind: "text",
						value:
							"Edit failed: 'explanation' parameter is required. Edits cannot be applied without an explanation.",
					},
				],
				toolResultMessage:
					"Edit failed: 'explanation' parameter is required for all file edits.",
			};
		}

		// Store explanation using request.id which matches responseModel.requestId
		// This MUST happen before sending any progress signals, otherwise the editing
		// service will reject the edits when it checks for the explanation
		editSession.storeEditExplanation(
			request.id,
			uri,
			parameters.explanation,
			parameters.subject,
			parameters.description
		);

		// Now send progress signals after storing the explanation
		model.acceptResponseProgress(request, {
			kind: "markdownContent",
			content: new MarkdownString("\n````\n"),
		});
		model.acceptResponseProgress(request, {
			kind: "codeblockUri",
			uri,
			isEdit: true,
		});
		model.acceptResponseProgress(request, {
			kind: "markdownContent",
			content: new MarkdownString("\n````\n"),
		});

		const codeMapper = this.codeMapperService.providers[0];
		if (!codeMapper) {
			// Signal start for non-code-mapper path
			if (
				this.notebookService.hasSupportedNotebooks(uri) &&
				this.notebookService.getNotebookTextModel(uri)
			) {
				model.acceptResponseProgress(request, {
					kind: "notebookEdit",
					edits: [],
					uri,
				});
			} else {
				model.acceptResponseProgress(request, {
					kind: "textEdit",
					edits: [],
					uri,
				});
			}
			// Fallback to direct insertion when no code mapper is available
			// Create a text edit that replaces the entire file content with the new code
			const textEdit: TextEdit = {
				range: new Range(
					1,
					1,
					Number.MAX_SAFE_INTEGER,
					Number.MAX_SAFE_INTEGER
				),
				text: parameters.code,
			};

			if (
				this.notebookService.hasSupportedNotebooks(uri) &&
				this.notebookService.getNotebookTextModel(uri)
			) {
				// For notebooks, we need to handle differently - but for now, just send as text edit
				// The notebook handling will be done by the editing session
				model.acceptResponseProgress(request, {
					kind: "notebookEdit",
					uri,
					edits: [],
					done: false,
				});
				model.acceptResponseProgress(request, {
					kind: "textEdit",
					uri: uri,
					edits: [textEdit],
					done: false,
				});
				model.acceptResponseProgress(request, {
					kind: "notebookEdit",
					uri,
					edits: [],
					done: true,
				});
			} else {
				model.acceptResponseProgress(request, {
					kind: "textEdit",
					uri,
					edits: [textEdit],
					done: false,
				});
				model.acceptResponseProgress(request, {
					kind: "textEdit",
					uri,
					edits: [],
					done: true,
				});
			}
		} else {
			// Use code mapper when available
			// The response model will automatically create/edit groups when we send edits
			// Note: contextFiles are available in parameters but not yet used by code mapper
			// They can be used for future enhancements like cross-file awareness

			let editKind: "textEdit" | "notebookEdit" | undefined;
			let editsWereSent = false;

			const result = await this.codeMapperService.mapCode(
				{
					codeBlocks: [
						{
							code: parameters.code,
							resource: uri,
							markdownBeforeBlock: parameters.explanation,
							editType: parameters.editType,
							anchorContext: parameters.anchorContext,
						},
					],
					location: "tool",
					chatRequestId: invocation.chatRequestId,
					chatRequestModel: invocation.modelId,
					chatSessionId: invocation.context.sessionId,
				},
				{
					textEdit: (target, edits) => {
						if (edits && edits.length > 0) {
							editKind = "textEdit";
							editsWereSent = true;
							// Response model will automatically create/edit group and merge edits
							model.acceptResponseProgress(request, {
								kind: "textEdit",
								uri: target,
								edits,
								done: false,
							});
						}
					},
					notebookEdit(target, edits) {
						if (edits && edits.length > 0) {
							editKind = "notebookEdit";
							editsWereSent = true;
							// Response model will automatically create/edit group and merge edits
							model.acceptResponseProgress(request, {
								kind: "notebookEdit",
								uri: target,
								edits,
								done: false,
							});
						}
					},
				},
				token
			);

			// Signal completion only if edits were actually sent
			// If no edits were sent, the file content is already correct, so we're done
			if (editsWereSent && editKind) {
				model.acceptResponseProgress(request, {
					kind: editKind,
					uri,
					edits: [],
					done: true,
				});
			}

			if (result?.errorMessage) {
				throw new Error(result.errorMessage);
			}
		}

		// Edits are sent synchronously via acceptResponseProgress and will be processed
		// asynchronously by the editing service. We don't wait for completion here to avoid
		// timeouts. The editing service will handle the edits and create the file entry
		// when it processes the textEdit progress signals.
		//
		// The explanation has already been stored, so the editing service will accept
		// the edits when it processes them. If there are any issues, they will be
		// visible in the UI, but the tool should not block waiting for async processing.

		return {
			content: [{ kind: "text", value: "The file edit was sent successfully" }],
		};
	}

	/**
	 * Check if a path string is a full path (URI, absolute path, or relative path with directories)
	 * vs just a filename.
	 */
	private isFullPath(uriString: string): boolean {
		// Check if it's a URI
		if (uriString.includes("://") || uriString.startsWith("file://")) {
			return true;
		}

		// Check if it's an absolute path
		if (uriString.startsWith("/") || (isWindows && /^[A-Za-z]:/.test(uriString))) {
			return true;
		}

		// Check if it contains path separators (likely a relative path, not just a filename)
		if (uriString.includes("/") || (isWindows && uriString.includes("\\"))) {
			return true;
		}

		// Otherwise, treat as a filename
		return false;
	}

	/**
	 * Resolve a file URI from a string path or URI string.
	 * Handles absolute paths, relative paths (resolved against workspace root),
	 * and URI strings (file://, etc.)
	 * Returns undefined if the path cannot be resolved (e.g., relative path without workspace).
	 */
	private resolveFileUri(uriString: string): URI | undefined {
		try {
			// Try parsing as URI first (file://, vscode-file://, etc.)
			if (uriString.includes("://") || uriString.startsWith("file://")) {
				return URI.parse(uriString);
			}

			// Get workspace root for resolving relative paths
			const workspace = this.workspaceService.getWorkspace();

			// Check if it's an absolute path
			// On Windows: C:\ or / (root)
			// On Unix: / (root)
			const isAbsolutePath =
				uriString.startsWith("/") ||
				(isWindows && /^[A-Za-z]:/.test(uriString));

			if (isAbsolutePath) {
				// Absolute path - use as-is
				return URI.file(uriString);
			}

			// Relative path - resolve against workspace root
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri;
				// Remove leading ./ or .\ if present
				const cleanPath = uriString.replace(/^\.[/\\]/, "");
				return URI.joinPath(workspaceRoot, cleanPath);
			}

			// No workspace - cannot resolve relative path
			// Return undefined to indicate failure
			return undefined;
		} catch (error) {
			// If parsing fails, return undefined
			return undefined;
		}
	}

	/**
	 * Create a fuzzy matching glob pattern from a filename.
	 * For example, "config" becomes "*c*o*n*f*i*g*", "config.json" becomes "*c*o*n*f*i*g*.*j*s*o*n*"
	 * This allows matching filenames that contain the pattern characters in order.
	 */
	private fuzzyMatchingGlobPattern(pattern: string): string {
		if (!pattern) {
			return "*";
		}
		// Insert * between each character for fuzzy matching
		return "*" + pattern.split("").join("*") + "*";
	}

	/**
	 * Create a case-insensitive glob pattern.
	 * For example, "Config" becomes "[Cc]onfig"
	 */
	private caseInsensitiveGlobPattern(pattern: string): string {
		let caseInsensitiveFilePattern = "";
		for (const char of pattern) {
			if (/[a-zA-Z]/.test(char)) {
				caseInsensitiveFilePattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
			} else {
				caseInsensitiveFilePattern += char;
			}
		}
		return caseInsensitiveFilePattern;
	}

	/**
	 * Search for files by name in the workspace using exact matching first, then fuzzy matching.
	 * Returns an array of matching file URIs, sorted by relevance (exact matches first).
	 */
	private async searchFilesByName(pattern: string, token: CancellationToken): Promise<URI[]> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}

		// First, try exact filename matching (case-insensitive)
		const exactPattern = this.caseInsensitiveGlobPattern(pattern);
		const exactMatches = await this.searchFilesWithPattern(`**/${exactPattern}`, token);

		// If we found exact matches, use them (they're already sorted by score)
		if (exactMatches.length > 0) {
			return exactMatches;
		}

		// Otherwise, fall back to fuzzy matching
		const fuzzyPattern = this.fuzzyMatchingGlobPattern(pattern);
		const caseInsensitivePattern = this.caseInsensitiveGlobPattern(fuzzyPattern);
		return await this.searchFilesWithPattern(`**/${caseInsensitivePattern}`, token);
	}

	/**
	 * Helper method to search for files with a specific glob pattern.
	 */
	private async searchFilesWithPattern(filePattern: string, token: CancellationToken): Promise<URI[]> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}

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
				filePattern
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

		// Remove duplicates while preserving order (search service already sorted by score)
		const seen = new Set<string>();
		const uniqueMatches: URI[] = [];
		for (const uri of allMatches) {
			const key = uri.toString();
			if (!seen.has(key)) {
				seen.add(key);
				uniqueMatches.push(uri);
				if (uniqueMatches.length >= maxResults) {
					break;
				}
			}
		}

		return uniqueMatches;
	}

	/**
	 * Get the relative path of a URI from the workspace root.
	 */
	private getRelativePath(uri: URI, workspaceRoot: URI): string {
		const relative = uri.toString().substring(workspaceRoot.toString().length);
		// Remove leading slash if present
		return relative.startsWith("/") ? relative.substring(1) : relative;
	}

	/**
	 * Pick the best match from multiple file matches.
	 * Prefers files in common source directories (src/, pages/, components/, etc.)
	 * over files at the workspace root.
	 */
	private pickBestMatch(matches: URI[]): URI | undefined {
		if (matches.length === 0) {
			return undefined;
		}
		if (matches.length === 1) {
			return matches[0];
		}

		// Common source directory patterns (ordered by preference)
		const sourceDirPatterns = [
			/src\//i,
			/pages\//i,
			/components\//i,
			/lib\//i,
			/app\//i,
			/client\//i,
			/server\//i,
		];

		// Score each match
		const scoredMatches = matches.map(uri => {
			const path = uri.fsPath;
			let score = 0;

			// Prefer files in source directories
			for (let i = 0; i < sourceDirPatterns.length; i++) {
				if (sourceDirPatterns[i].test(path)) {
					score = sourceDirPatterns.length - i; // Higher score for earlier patterns
					break;
				}
			}

			// Prefer deeper files (more specific paths) over root files
			const depth = (path.match(/[\/\\]/g) || []).length;
			score += depth * 0.1; // Small bonus for depth

			// Prefer files that are NOT at the workspace root
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length > 0) {
				const workspaceRoot = workspace.folders[0].uri.fsPath;
				const relativePath = path.replace(workspaceRoot, '');
				if (relativePath.split(/[\/\\]/).filter(p => p.length > 0).length > 1) {
					score += 1; // Bonus for being in a subdirectory
				}
			}

			return { uri, score };
		});

		// Sort by score (highest first)
		scoredMatches.sort((a, b) => b.score - a.score);

		// If the top match has a significantly higher score, use it
		// Otherwise, return undefined to let the user choose
		if (scoredMatches.length >= 2) {
			const topScore = scoredMatches[0].score;
			const secondScore = scoredMatches[1].score;
			// If the top match is clearly better (score difference > 0.5), use it
			if (topScore > secondScore + 0.5) {
				return scoredMatches[0].uri;
			}
		}

		// No clear winner - return undefined to ask user to choose
		return undefined;
	}

	async prepareToolInvocation(
		context: IToolInvocationPreparationContext,
		token: CancellationToken
	): Promise<IPreparedToolInvocation | undefined> {
		return {
			presentation: ToolInvocationPresentation.Hidden,
		};
	}
}
