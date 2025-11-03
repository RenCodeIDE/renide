/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { IReference } from '../../../../../base/common/lifecycle.js';
import { IChatRequestVariableEntry, isChatRequestFileEntry, isImplicitVariableEntry, isPasteVariableEntry } from '../../common/chatVariableEntries.js';
import { IChatAgentRequest } from '../../common/chatAgents.js';
import { IChatProgress } from '../../common/chatService.js';
import { basename } from '../../../../../base/common/resources.js';
import { isLocation, Location, TextEdit } from '../../../../../editor/common/languages.js';
import { Range, IRange } from '../../../../../editor/common/core/range.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import type { IContextPromptResult, IContextBlockMetadata, IParsedCodeBlock } from './types.js';

export class ContextBuilder {
	constructor(
		private readonly textModelService: ITextModelService,
		private readonly logService: ILogService,
	) { }

	async buildContextPrompt(
		request: IChatAgentRequest,
		token: CancellationToken,
	): Promise<IContextPromptResult | undefined> {
		const variables = request.variables?.variables ?? [];
		this.logService.debug(`[chatgpt] preparing context: ${variables.length} entries`);
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
					blocks.push(this.formatCodeBlock(entry.name || 'pasted-snippet', snippet, lang));
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

		this.logService.debug(`[chatgpt] including ${blocks.length} context blocks`);
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
			return {
				block: this.formatCodeBlock(label, text, language),
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
				`[chatgpt] Failed to load context for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		} finally {
			reference?.dispose();
		}
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
				`[chatgpt] Unable to resolve URI for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
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
		const locationText = range
			? `${range.startLineNumber}-${range.endLineNumber}`
			: undefined;
		const qualifier =
			entry.name && entry.name !== fileName ? entry.name : undefined;
		return [fileName, locationText, qualifier].filter(Boolean).join(' ');
	}

	private formatCodeBlock(label: string, content: string, language: string): string {
		const lang = language || '';
		return `${label}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
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
					`[chatgpt] Failed to auto-apply edit for ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

