/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IReference } from '../../../../base/common/lifecycle.js';
import { IChatRequestVariableEntry, isChatRequestFileEntry, isImplicitVariableEntry, isPasteVariableEntry } from './chatVariableEntries.js';
import { IChatAgentRequest } from './chatAgents.js';
import { IChatProgress } from './chatService.js';
import { basename } from '../../../../base/common/resources.js';
import { isLocation, Location, LocationLink, TextEdit } from '../../../../editor/common/languages.js';
import { Range, IRange } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';

export interface IContextBlockMetadata {
	readonly label: string;
	readonly uri: URI;
	readonly range: Range | undefined;
	readonly language: string;
	readonly content: string;
}

export interface IContextPromptResult {
	readonly prompt: string;
	readonly entries: IContextBlockMetadata[];
}

export interface IParsedCodeBlock {
	readonly language: string;
	readonly content: string;
}

interface VariableDefinition {
	readonly uri: URI;
	readonly range: Range;
	readonly name: string;
	readonly snippet: string;
}

export class ContextBuilder {
	constructor(
		private readonly textModelService: ITextModelService,
		private readonly logService: ILogService,
		private readonly languageFeaturesService?: ILanguageFeaturesService,
	) { }

	async buildContextPrompt(
		request: IChatAgentRequest,
		token: CancellationToken,
	): Promise<IContextPromptResult | undefined> {
		const variables = request.variables?.variables ?? [];
		this.logService.debug(`[context-builder] preparing context: ${variables.length} entries`);
		if (!variables.length) {
			return undefined;
		}

		const blocks: string[] = [];
		const metadata: IContextBlockMetadata[] = [];
		const seen = new Set<string>();

		for (const entry of variables) {
			if (token.isCancellationRequested) {
				break;
			}
			if (seen.has(entry.id)) {
				continue;
			}
			seen.add(entry.id);

			if (isPasteVariableEntry(entry)) {
				const snippet = this.truncate(entry.code);
				if (snippet.trim().length) {
					const lang = entry.language?.toLowerCase() ?? '';
					// For pasted snippets, we don't have a URI, so use a dummy one
					const dummyUri = URI.parse('pasted://snippet');
					blocks.push(this.formatCodeBlock(entry.name || 'pasted-snippet', snippet, lang, dummyUri, []));
				}
				continue;
			}

			if (isImplicitVariableEntry(entry) && entry.enabled === false) {
				continue;
			}

			if (isImplicitVariableEntry(entry) || isChatRequestFileEntry(entry)) {
				const contextBlock = await this.loadEntryContent(entry, token);
				if (contextBlock) {
					blocks.push(contextBlock.block);
					if (contextBlock.metadata) {
						metadata.push(contextBlock.metadata);
					}
				}
			}
		}

		if (!blocks.length) {
			return undefined;
		}

		this.logService.debug(`[context-builder] including ${blocks.length} context blocks`);
		const prompt = [
			'You are an expert coding assistant embedded in the IDE. The code blocks below are the exact context the user means -- even if they refer to them with vague terms like \'this\', \'the file\', or \'the function\'.',
			'Ground every response in those blocks: explain behaviour, data structures, and error cases using only the provided code. Mention the relevant file or block when helpful, and if the answer cannot be derived from this context, say so explicitly before offering any speculation.',
			...blocks,
		].join('\n\n');
		return { prompt, entries: metadata };
	}

	private async loadEntryContent(
		entry: IChatRequestVariableEntry,
		token: CancellationToken,
	): Promise<{ block: string; metadata?: IContextBlockMetadata } | undefined> {
		const location = this.getLocation(entry);
		const uri = location?.uri ?? this.getUri(entry);
		if (!uri) {
			return undefined;
		}

		let reference: IReference<IResolvedTextEditorModel> | undefined;
		try {
			reference = await this.textModelService.createModelReference(uri);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const model = reference.object.textEditorModel;
			const range = location?.range ? Range.lift(location.range) : undefined;
			let text = range ? model.getValueInRange(range) : model.getValue();
			text = this.truncate(text);
			if (!text.trim().length) {
				return undefined;
			}
			const language = model.getLanguageId() ?? '';
			const label = this.getContextLabel(uri, range, entry);
			
			// Resolve variable definitions if language features service is available
			let relatedDefinitions: VariableDefinition[] = [];
			if (this.languageFeaturesService && range) {
				try {
					relatedDefinitions = await this.resolveUsedVariables(model, range, token);
				} catch (error) {
					this.logService.debug(
						`[context-builder] Failed to resolve variables for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			const block = this.formatCodeBlock(label, text, language, uri, relatedDefinitions);
			return {
				block,
				metadata: {
					label,
					uri,
					range,
					language,
					content: text,
				},
			};
		} catch (error) {
			if (error instanceof CancellationError) {
				throw error;
			}
			this.logService.warn(
				`[context-builder] Failed to load context for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		} finally {
			reference?.dispose();
		}
	}

	private async resolveUsedVariables(
		model: ITextModel,
		range: Range,
		token: CancellationToken,
	): Promise<VariableDefinition[]> {
		if (!this.languageFeaturesService) {
			return [];
		}

		const definitions: VariableDefinition[] = [];
		const seenDefinitions = new Set<string>(); // Track "uri:line:name" to avoid duplicates
		const sourceUri = model.uri;

		// Extract identifiers from the selected code
		const text = model.getValueInRange(range);
		const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
		const identifiers = new Set<string>();
		let match: RegExpExecArray | null;
		while ((match = identifierRegex.exec(text)) !== null) {
			const identifier = match[0];
			// Filter out common keywords and short identifiers that are likely not variables
			if (identifier.length >= 2 && !this.isKeyword(identifier)) {
				identifiers.add(identifier);
			}
		}

		// Limit to first 50 unique identifiers to prevent performance issues
		const identifierArray = Array.from(identifiers).slice(0, 50);

		// Resolve definitions in parallel batches
		const batchSize = 10;
		for (let i = 0; i < identifierArray.length; i += batchSize) {
			if (token.isCancellationRequested) {
				break;
			}

			const batch = identifierArray.slice(i, i + batchSize);
			const batchPromises = batch.map(async (identifier) => {
				try {
					// Find all occurrences of the identifier in the range
					const positions: Position[] = [];
					const lines = text.split('\n');
					let currentLine = range.startLineNumber;
					for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
						const line = lines[lineIdx];
						const lineNumber = currentLine + lineIdx;
						const regex = new RegExp(`\\b${this.escapeRegex(identifier)}\\b`, 'g');
						let match: RegExpExecArray | null;
						while ((match = regex.exec(line)) !== null) {
							positions.push(new Position(lineNumber, match.index + 1));
						}
					}

					// Try to get definition for the first occurrence
					if (positions.length === 0) {
						return null;
					}

					const position = positions[0];
					if (!this.languageFeaturesService) {
						return null;
					}
					const definitionProviders = this.languageFeaturesService.definitionProvider.all(model);
					
					for (const provider of definitionProviders) {
						if (token.isCancellationRequested) {
							return null;
						}
						try {
							const result = await provider.provideDefinition(model, position, token);
							if (!result) {
								continue;
							}

							const locations: (Location | LocationLink)[] = Array.isArray(result)
								? result
								: [result as Location];

							for (const location of locations) {
								if (!location || !location.uri) {
									continue;
								}

								const definitionUri = URI.from(location.uri);
								const definitionRange = location.range ? Range.lift(location.range) : undefined;

								// Only include definitions from different files
								if (definitionUri.toString() !== sourceUri.toString() && definitionRange) {
									// Create a unique key to avoid duplicates: "uri:line:name"
									const defKey = `${definitionUri.toString()}:${definitionRange.startLineNumber}:${identifier}`;
									if (!seenDefinitions.has(defKey)) {
										seenDefinitions.add(defKey);
										
										// Get the definition line snippet
										let snippet = '';
										try {
											const defReference = await this.textModelService.createModelReference(definitionUri);
											try {
												const defModel = defReference.object.textEditorModel;
												const defLine = definitionRange.startLineNumber;
												const defLineText = defModel.getLineContent(defLine).trim();
												snippet = defLineText.length > 100 ? defLineText.substring(0, 100) + '...' : defLineText;
											} finally {
												defReference.dispose();
											}
										} catch (error) {
											// Ignore errors reading definition file
										}

										definitions.push({
											uri: definitionUri,
											range: definitionRange,
											name: identifier,
											snippet,
										});
									}
								}
							}
						} catch (error) {
							// Continue to next provider
							continue;
						}
					}
				} catch (error) {
					// Ignore errors for this identifier
					return null;
				}
				return null;
			});

			await Promise.all(batchPromises);
		}

		return definitions;
	}

	private isKeyword(identifier: string): boolean {
		// Common JavaScript/TypeScript keywords and built-ins
		const keywords = new Set([
			'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
			'function', 'class', 'const', 'let', 'var', 'import', 'export', 'from', 'default',
			'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super',
			'typeof', 'instanceof', 'in', 'of', 'true', 'false', 'null', 'undefined', 'void',
			'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'console',
			'window', 'document', 'global', 'process', 'module', 'require', 'exports',
		]);
		return keywords.has(identifier);
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private getUri(entry: IChatRequestVariableEntry): URI | undefined {
		try {
			const direct = IChatRequestVariableEntry.toUri(entry);
			if (direct) {
				return URI.isUri(direct) ? direct : URI.revive(direct as UriComponents);
			}
			const rawValue = (entry as { value?: unknown }).value;
			if (rawValue && typeof rawValue === 'object') {
				const valueRecord = rawValue as Record<string, unknown>;
				const schemeValue = valueRecord['scheme'];
				if (typeof schemeValue === 'string') {
					return URI.revive(valueRecord as unknown as UriComponents);
				}
				const candidate = valueRecord['uri'];
				if (candidate) {
					return URI.isUri(candidate as unknown)
						? (candidate as URI)
						: URI.revive(candidate as UriComponents);
				}
			}
		} catch (error) {
			this.logService.warn(
				`[context-builder] Unable to resolve URI for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	}

	private getLocation(entry: IChatRequestVariableEntry): Location | undefined {
		const value = (entry as { value?: unknown }).value;
		if (value && isLocation(value)) {
			const loc = value as Location;
			const revivedUri = URI.isUri(loc.uri) ? loc.uri : URI.revive(loc.uri as UriComponents);
			return {
				uri: revivedUri,
				range: Range.lift(loc.range),
			};
		}
		if (value && typeof value === 'object') {
			const recordValue = value as Record<string, unknown>;
			const candidateUri = recordValue['uri'];
			const candidateRange = recordValue['range'];
			if (candidateUri && candidateRange) {
				const revivedUri = URI.isUri(candidateUri as unknown)
					? (candidateUri as URI)
					: URI.revive(candidateUri as UriComponents);
				return {
					uri: revivedUri,
					range: Range.lift(candidateRange as IRange),
				};
			}
		}
		return undefined;
	}

	private getContextLabel(
		uri: URI,
		range: Range | undefined,
		entry: IChatRequestVariableEntry,
	): string {
		const fileName = basename(uri);
		const filePath = uri.fsPath;
		const locationText = range
			? `${range.startLineNumber}-${range.endLineNumber}`
			: undefined;
		const qualifier =
			entry.name && entry.name !== fileName ? entry.name : undefined;
		return [fileName, filePath, locationText, qualifier].filter(Boolean).join(' ');
	}

	private formatCodeBlock(
		label: string,
		content: string,
		language: string,
		uri: URI,
		relatedDefinitions: VariableDefinition[] = [],
	): string {
		const lang = language || '';
		let header = label;
		
		// Add related definitions if any
		if (relatedDefinitions.length > 0) {
			const defLines = relatedDefinitions.map(def => {
				const path = def.uri.fsPath;
				const line = def.range.startLineNumber;
				return `// - ${path}:${line} ${def.name}: ${def.snippet}`;
			});
			header += '\n// Related definitions:\n' + defLines.join('\n');
		}
		
		return `${header}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
	}

	private truncate(text: string, maxLength = 4000): string {
		if (text.length <= maxLength) {
			return text.trimEnd();
		}
		return `${text.slice(0, maxLength)}\n...[truncated]`;
	}

	parseCodeBlocks(markdown: string): IParsedCodeBlock[] {
		const blocks: IParsedCodeBlock[] = [];
		const regex = /```([^\n]*)\n([\s\S]*?)```/g;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(markdown)) !== null) {
			const language = match[1]?.trim() ?? '';
			const content = match[2] ?? '';
			blocks.push({ language, content });
		}
		return blocks;
	}

	findMatchingCodeBlock(
		entry: IContextBlockMetadata,
		blocks: IParsedCodeBlock[],
		used: Set<number>,
	): { block: IParsedCodeBlock; index: number } | undefined {
		let bestScore = 0;
		let bestIndex = -1;

		const anchor =
			entry.content
				.split('\n')
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? '';

		for (let i = 0; i < blocks.length; i++) {
			if (used.has(i)) {
				continue;
			}
			const candidate = blocks[i];
			const candidateContent = candidate.content.trim();
			if (!candidateContent.length) {
				continue;
			}
			let score = 0;
			if (
				!entry.language ||
				!candidate.language ||
				entry.language === candidate.language
			) {
				score += 2;
			}
			if (anchor && candidateContent.includes(anchor)) {
				score += 5;
			}
			const entryFirstLine = entry.content.split('\n')[0]?.trim() ?? '';
			if (entryFirstLine && candidateContent.startsWith(entryFirstLine)) {
				score += 3;
			}
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}

		if (bestIndex === -1 && blocks.length === 1 && !used.has(0)) {
			bestIndex = 0;
		}

		if (bestIndex === -1) {
			return undefined;
		}

		used.add(bestIndex);
		return { block: blocks[bestIndex], index: bestIndex };
	}

	async tryAutoApplyEdits(
		responseText: string,
		contextEntries: IContextBlockMetadata[],
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		if (!contextEntries.length || token.isCancellationRequested) {
			return;
		}

		const codeBlocks = this.parseCodeBlocks(responseText);
		if (!codeBlocks.length) {
			return;
		}

		const usedBlocks = new Set<number>();

		for (const entry of contextEntries) {
			if (token.isCancellationRequested) {
				return;
			}

			try {
				const match = this.findMatchingCodeBlock(entry, codeBlocks, usedBlocks);
				if (!match) {
					continue;
				}

				const newTextRaw = match.block.content;
				if (!newTextRaw.trim().length) {
					continue;
				}

				const originalTrimmed = entry.content.trim();
				const newTrimmed = newTextRaw.trim();
				if (originalTrimmed === newTrimmed) {
					continue;
				}

				const reference = await this.textModelService.createModelReference(entry.uri);
				try {
					const model = reference.object.textEditorModel;
					const editRange = entry.range ?? model.getFullModelRange();
					const edit: TextEdit = { range: editRange, text: newTextRaw };
					progress([{ kind: 'textEdit', uri: entry.uri, edits: [edit], done: false }]);
					progress([{ kind: 'textEdit', uri: entry.uri, edits: [], done: true }]);
				} finally {
					reference.dispose();
				}
			} catch (error) {
				this.logService.warn(
					`[context-builder] Failed to auto-apply edit for ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

