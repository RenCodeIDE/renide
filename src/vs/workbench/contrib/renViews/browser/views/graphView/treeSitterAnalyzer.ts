/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ITreeSitterLibraryService } from '../../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import type { Parser, Language } from '@vscode/tree-sitter-wasm';

export interface HttpCallSummary {
	method: string;
	url: string;
	resource: string;
	file: string;
	snippet?: string;
	lineNumber?: number;
	columnNumber?: number;
}

export interface GraphQLOperationSummary {
	type: string;
	name?: string;
	file: string;
	snippet: string;
	lineNumber?: number;
	columnNumber?: number;
}

export class TreeSitterAnalyzer {
	private readonly parserClassPromise: Promise<typeof Parser>;
	private readonly languageCache = new Map<string, Promise<Language | undefined>>();

	constructor(
		private readonly treeSitterService: ITreeSitterLibraryService,
		private readonly fileService: IFileService,
		private readonly logService: ILogService
	) {
		this.parserClassPromise = treeSitterService.getParserClass();
	}

	/**
	 * Get the language for a file based on its extension
	 */
	private getLanguageIdForFile(uri: URI): string | undefined {
		const path = uri.path.toLowerCase();
		if (path.endsWith('.ts') || path.endsWith('.tsx')) {
			return 'typescript';
		}
		if (path.endsWith('.js') || path.endsWith('.jsx')) {
			return 'javascript';
		}
		return undefined;
	}

	/**
	 * Get or load the language for a given language ID
	 */
	private async getLanguage(languageId: string): Promise<Language | undefined> {
		if (!this.languageCache.has(languageId)) {
			this.languageCache.set(
				languageId,
				this.treeSitterService.getLanguagePromise(languageId)
			);
		}
		return this.languageCache.get(languageId)!;
	}

	/**
	 * Parse a file and return the AST
	 */
	private async parseFile(uri: URI, content: string): Promise<{ tree: any; parser: Parser } | undefined> {
		const languageId = this.getLanguageIdForFile(uri);
		if (!languageId) {
			return undefined;
		}

		try {
			const [ParserClass, language] = await Promise.all([
				this.parserClassPromise,
				this.getLanguage(languageId)
			]);

			if (!language) {
				this.logService.debug(`[TreeSitterAnalyzer] Language ${languageId} not available for ${uri.toString()}`);
				return undefined;
			}

			const parser = new ParserClass();
			parser.setLanguage(language);
			const tree = parser.parse(content);

			return { tree, parser };
		} catch (error) {
			this.logService.debug(`[TreeSitterAnalyzer] Failed to parse ${uri.toString()}`, error);
			return undefined;
		}
	}

	/**
	 * Extract HTTP calls (fetch, axios) from a file using AST queries
	 */
	async extractHttpCalls(uri: URI): Promise<HttpCallSummary[]> {
		const results: HttpCallSummary[] = [];

		try {
			const buffer = await this.fileService.readFile(uri);
			const content = buffer.value.toString();
			const parseResult = await this.parseFile(uri, content);
			if (!parseResult) {
				return results;
			}

			const { tree, parser } = parseResult;
			const languageId = this.getLanguageIdForFile(uri);
			if (!languageId) {
				return results;
			}

			const language = await this.getLanguage(languageId);
			if (!language) {
				return results;
			}

			// Query for fetch() calls
			const fetchQuerySource = `
				(call_expression
					function: (identifier) @func (#eq? @func "fetch")
					arguments: (arguments
						(string) @url
					)
				)
			`;

			// Query for axios.method() calls
			const axiosQuerySource = `
				(call_expression
					function: (member_expression
						object: (identifier) @obj (#eq? @obj "axios")
						property: (property_identifier) @method
					)
					arguments: (arguments
						(string) @url
					)
				)
			`;

			const lines = content.split(/\r?\n/);

			// Process fetch calls
			try {
				const fetchQuery = await this.treeSitterService.createQuery(language, fetchQuerySource);
				const fetchCaptures = fetchQuery.captures(tree.rootNode);

				// Process each url capture (each capture represents one match)
				for (const capture of fetchCaptures) {
					if (capture.name === 'url' && capture.node.text) {
						const url = capture.node.text.replace(/^["'`]|["'`]$/g, '');
						const lineNumber = capture.node.startPosition.row + 1;
						const columnNumber = capture.node.startPosition.column + 1;
						const line = lines[lineNumber - 1] || '';
						const snippet = line.trim().slice(0, 200);

						results.push({
							method: 'GET', // fetch defaults to GET
							url,
							resource: this.extractHost(url) || 'unknown',
							file: uri.toString(true),
							snippet,
							lineNumber,
							columnNumber
						});
					}
				}
			} catch (error) {
				this.logService.debug(`[TreeSitterAnalyzer] Failed to execute fetch query`, error);
			}

			// Process axios calls
			try {
				const axiosQuery = await this.treeSitterService.createQuery(language, axiosQuerySource);
				const axiosCaptures = axiosQuery.captures(tree.rootNode);

				// Group captures by their parent call_expression node
				// We need to find method and url captures that belong to the same call
				const capturesByCall = new Map<string, typeof axiosCaptures>();
				for (const capture of axiosCaptures) {
					// Use the start position of the parent call as a key
					// For simplicity, use the node's start position as grouping key
					// In practice, we'd need to walk up to find the call_expression parent
					// For now, group by proximity (same line and nearby columns)
					const key = `${capture.node.startPosition.row}:${Math.floor(capture.node.startPosition.column / 100)}`;
					if (!capturesByCall.has(key)) {
						capturesByCall.set(key, []);
					}
					capturesByCall.get(key)!.push(capture);
				}

				// Process each call
				for (const captures of capturesByCall.values()) {
					const methodCapture = captures.find(c => c.name === 'method');
					const urlCapture = captures.find(c => c.name === 'url');
					if (urlCapture && urlCapture.node.text && methodCapture) {
						const method = methodCapture.node.text.toUpperCase();
						const url = urlCapture.node.text.replace(/^["'`]|["'`]$/g, '');
						const lineNumber = urlCapture.node.startPosition.row + 1;
						const columnNumber = urlCapture.node.startPosition.column + 1;
						const line = lines[lineNumber - 1] || '';
						const snippet = line.trim().slice(0, 200);

						results.push({
							method,
							url,
							resource: this.extractHost(url) || 'unknown',
							file: uri.toString(true),
							snippet,
							lineNumber,
							columnNumber
						});
					}
				}
			} catch (error) {
				this.logService.debug(`[TreeSitterAnalyzer] Failed to execute axios query`, error);
			}

			parser.delete();
		} catch (error) {
			this.logService.debug(`[TreeSitterAnalyzer] Failed to extract HTTP calls from ${uri.toString()}`, error);
		}

		return results;
	}

	/**
	 * Extract GraphQL operations from a file using AST queries
	 */
	async extractGraphQLOperations(uri: URI): Promise<GraphQLOperationSummary[]> {
		const results: GraphQLOperationSummary[] = [];

		try {
			const buffer = await this.fileService.readFile(uri);
			const content = buffer.value.toString();
			const parseResult = await this.parseFile(uri, content);
			if (!parseResult) {
				return results;
			}

			const { tree, parser } = parseResult;
			const languageId = this.getLanguageIdForFile(uri);
			if (!languageId) {
				return results;
			}

			const language = await this.getLanguage(languageId);
			if (!language) {
				return results;
			}

			// Query for gql`...` tagged template literals
			const gqlQuerySource = `
				(tagged_template_expression
					tag: (identifier) @tag (#eq? @tag "gql")
					template: (template_string) @template
				)
			`;

			try {
				const gqlQuery = await this.treeSitterService.createQuery(language, gqlQuerySource);
				const gqlCaptures = gqlQuery.captures(tree.rootNode);

				// Process each template capture (each capture represents one match)
				for (const capture of gqlCaptures) {
					if (capture.name === 'template' && capture.node.text) {
						const templateText = capture.node.text;
						const lineNumber = capture.node.startPosition.row + 1;
						const columnNumber = capture.node.startPosition.column + 1;

						// Extract operation type and name from GraphQL query
						const headerMatch = /(query|mutation|subscription)\s*(\w+)?/i.exec(templateText);
						const operationType = headerMatch ? headerMatch[1] : 'query';
						const operationName = headerMatch && headerMatch[2] ? headerMatch[2] : undefined;

						const snippet = templateText.slice(0, 200);

						results.push({
							type: operationType,
							name: operationName,
							file: uri.toString(true),
							snippet,
							lineNumber,
							columnNumber
						});
					}
				}
			} catch (error) {
				this.logService.debug(`[TreeSitterAnalyzer] Failed to execute GraphQL query`, error);
			}

			parser.delete();
		} catch (error) {
			this.logService.debug(`[TreeSitterAnalyzer] Failed to extract GraphQL operations from ${uri.toString()}`, error);
		}

		return results;
	}

	/**
	 * Extract host from URL
	 */
	private extractHost(url: string): string | undefined {
		try {
			const match = /https?:\/\/([^/]+)/.exec(url);
			return match?.[1];
		} catch (error) {
			return undefined;
		}
	}
}

