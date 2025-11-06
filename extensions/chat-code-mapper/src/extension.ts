/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Computes similarity score between two strings using Levenshtein distance.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function computeSimilarity(str1: string, str2: string): number {
	if (str1 === str2) {
		return 1;
	}
	if (str1.length === 0 || str2.length === 0) {
		return 0;
	}

	const maxLen = Math.max(str1.length, str2.length);
	const distance = levenshteinDistance(str1, str2);
	return 1 - distance / maxLen;
}

/**
 * Computes Levenshtein distance between two strings.
 */
function levenshteinDistance(str1: string, str2: string): number {
	const len1 = str1.length;
	const len2 = str2.length;
	const matrix: number[][] = [];

	for (let i = 0; i <= len1; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= len2; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			if (str1[i - 1] === str2[j - 1]) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j] + 1,     // deletion
					matrix[i][j - 1] + 1,     // insertion
					matrix[i - 1][j - 1] + 1  // substitution
				);
			}
		}
	}

	return matrix[len1][len2];
}

/**
 * Finds the best matching line in oldLines for a given newLine using fuzzy matching.
 * Returns the index and confidence score.
 */
function findBestMatch(newLine: string, oldLines: string[], startIndex: number, endIndex: number): { index: number; confidence: number } | null {
	let bestIndex = -1;
	let bestConfidence = 0;
	const threshold = 0.7; // Minimum similarity threshold

	for (let i = startIndex; i < endIndex && i < oldLines.length; i++) {
		const similarity = computeSimilarity(newLine.trim(), oldLines[i].trim());
		if (similarity > bestConfidence && similarity >= threshold) {
			bestConfidence = similarity;
			bestIndex = i;
		}
	}

	if (bestIndex >= 0) {
		return { index: bestIndex, confidence: bestConfidence };
	}
	return null;
}

/**
 * Finds anchor position using beforeText and afterText context.
 */
function findAnchorPosition(
	oldLines: string[],
	beforeText: string | undefined,
	afterText: string | undefined,
	targetLine: number | undefined
): { startLine: number; endLine: number } | null {
	if (targetLine !== undefined && targetLine >= 0 && targetLine < oldLines.length) {
		// Use explicit line number if provided
		return { startLine: targetLine, endLine: targetLine };
	}

	let startLine = -1;
	let endLine = -1;

	// Find beforeText anchor
	if (beforeText) {
		const beforeLines = beforeText.split(/\r?\n/);
		const beforePattern = beforeLines[beforeLines.length - 1]?.trim();
		if (beforePattern) {
			for (let i = 0; i < oldLines.length; i++) {
				if (oldLines[i].trim().includes(beforePattern) || computeSimilarity(oldLines[i].trim(), beforePattern) > 0.8) {
					startLine = i + 1; // Position after the anchor
					break;
				}
			}
		}
	}

	// Find afterText anchor
	if (afterText) {
		const afterLines = afterText.split(/\r?\n/);
		const afterPattern = afterLines[0]?.trim();
		if (afterPattern) {
			for (let i = (startLine >= 0 ? startLine : 0); i < oldLines.length; i++) {
				if (oldLines[i].trim().includes(afterPattern) || computeSimilarity(oldLines[i].trim(), afterPattern) > 0.8) {
					endLine = i; // Position before the anchor
					break;
				}
			}
		}
	}

	if (startLine >= 0 || endLine >= 0) {
		return {
			startLine: startLine >= 0 ? startLine : 0,
			endLine: endLine >= 0 ? endLine : oldLines.length
		};
	}

	return null;
}

/**
 * Computes minimal text edits between original and new code using an enhanced diff algorithm.
 * Supports anchor-based positioning, fuzzy matching, and edit type hints.
 */
function computeTextEdits(
	original: string,
	newCode: string,
	editType?: 'replace' | 'insert' | 'delete' | 'modify',
	anchorContext?: { lineNumber?: number; beforeText?: string; afterText?: string }
): vscode.TextEdit[] {
	// Handle empty cases
	if (original === newCode) {
		return [];
	}

	const oldLines = original.split(/\r?\n/);
	const newLines = newCode.split(/\r?\n/);

	// Try to use anchor context if provided
	let anchorRange: { startLine: number; endLine: number } | null = null;
	if (anchorContext) {
		anchorRange = findAnchorPosition(
			oldLines,
			anchorContext.beforeText,
			anchorContext.afterText,
			anchorContext.lineNumber !== undefined ? anchorContext.lineNumber - 1 : undefined // Convert to 0-based
		);
	}

	let prefixEnd = 0;
	let suffixStart = oldLines.length;
	let suffixStartNew = newLines.length;

	// If we have anchor context, use it to narrow the search range
	if (anchorRange) {
		// Still find common prefix/suffix but within the anchor range
		const anchorStart = Math.max(0, anchorRange.startLine);
		const anchorEnd = Math.min(oldLines.length, anchorRange.endLine);

		// Find prefix up to anchor start
		prefixEnd = Math.min(anchorStart, oldLines.length);
		for (let i = 0; i < prefixEnd && i < newLines.length; i++) {
			if (oldLines[i] === newLines[i]) {
				prefixEnd = i + 1;
			} else {
				break;
			}
		}

		// Find suffix from anchor end
		suffixStart = anchorEnd;
		suffixStartNew = newLines.length;
		for (let i = 0; i < Math.min(oldLines.length - anchorEnd, newLines.length); i++) {
			const oldIdx = oldLines.length - 1 - i;
			const newIdx = newLines.length - 1 - i;
			if (oldIdx >= anchorEnd && newIdx >= 0 && oldLines[oldIdx] === newLines[newIdx]) {
				suffixStart = oldIdx;
				suffixStartNew = newIdx;
			} else {
				break;
			}
		}
	} else {
		// Standard prefix/suffix matching with fuzzy fallback
		// Find common prefix
		while (
			prefixEnd < oldLines.length &&
			prefixEnd < newLines.length &&
			oldLines[prefixEnd] === newLines[prefixEnd]
		) {
			prefixEnd++;
		}

		// Try fuzzy matching for the first differing line
		if (prefixEnd < newLines.length && prefixEnd < oldLines.length) {
			const fuzzyMatch = findBestMatch(newLines[prefixEnd], oldLines, prefixEnd, Math.min(prefixEnd + 5, oldLines.length));
			if (fuzzyMatch && fuzzyMatch.confidence > 0.85) {
				// Skip similar lines
				prefixEnd = fuzzyMatch.index + 1;
			}
		}

		// Find common suffix (only in the remaining sections)
		while (
			suffixStart > prefixEnd &&
			suffixStartNew > prefixEnd &&
			oldLines[suffixStart - 1] === newLines[suffixStartNew - 1]
		) {
			suffixStart--;
			suffixStartNew--;
		}

		// Try fuzzy matching for the last differing line
		if (suffixStartNew > prefixEnd && suffixStart > prefixEnd) {
			const fuzzyMatch = findBestMatch(
				newLines[suffixStartNew - 1],
				oldLines,
				Math.max(prefixEnd, suffixStart - 5),
				suffixStart
			);
			if (fuzzyMatch && fuzzyMatch.confidence > 0.85) {
				suffixStart = fuzzyMatch.index;
				suffixStartNew = suffixStartNew - 1;
			}
		}
	}

	// Calculate ranges (0-based line numbers for VS Code API)
	const startLine = prefixEnd;
	const endLine = suffixStart;

	// Get the changed content (middle section)
	let newText = newLines.slice(prefixEnd, suffixStartNew).join('\n');

	// Handle trailing newline: preserve if newCode ends with newline
	if (newCode.endsWith('\n') && suffixStartNew === newLines.length && newText.length > 0 && !newText.endsWith('\n')) {
		newText += '\n';
	}

	// Handle empty file case
	if (oldLines.length === 0) {
		if (newText.length > 0) {
			return [
				{
					range: new vscode.Range(0, 0, 0, 0),
					newText: newText
				}
			];
		}
		return [];
	}

	// Determine edit range based on edit type
	let endLineNumber: number;
	let endCharacter: number;

	if (editType === 'insert') {
		// Insert mode: don't replace existing lines
		const insertLine = anchorContext?.lineNumber !== undefined
			? Math.max(0, Math.min(anchorContext.lineNumber - 1, oldLines.length))
			: startLine;
		endLineNumber = insertLine;
		endCharacter = 0;
	} else if (editType === 'delete') {
		// Delete mode: remove lines without adding new ones
		if (startLine === endLine) {
			// Nothing to delete
			return [];
		}
		endLineNumber = endLine;
		endCharacter = 0;
		newText = '';
	} else if (startLine === endLine) {
		// Insertion case: inserting at a specific line position
		if (startLine >= oldLines.length) {
			endLineNumber = oldLines.length;
			endCharacter = 0;
		} else {
			endLineNumber = startLine;
			endCharacter = 0;
		}
	} else if (endLine >= oldLines.length) {
		// Replacing from startLine to the end of the file
		endLineNumber = oldLines.length;
		endCharacter = Number.MAX_SAFE_INTEGER;
	} else {
		// Replacing lines from startLine to endLine (exclusive)
		endLineNumber = endLine;
		endCharacter = 0;
	}

	// Clamp startLine to document bounds
	const rangeStartLine = startLine > oldLines.length ? oldLines.length : startLine;

	// Create the edit
	return [
		{
			range: new vscode.Range(rangeStartLine, 0, endLineNumber, endCharacter),
			newText: newText
		}
	];
}

/**
 * Reads the content of a file, handling the case where it doesn't exist.
 */
async function readFileContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
	if (token.isCancellationRequested) {
		throw new Error('Operation cancelled');
	}

	try {
		const document = await vscode.workspace.openTextDocument(uri);
		return document.getText();
	} catch (error) {
		// File doesn't exist or can't be read - treat as empty
		return '';
	}
}

/**
 * MappedEditsProvider2 implementation that computes precise diffs.
 */
const provider: any = {
	async provideMappedEdits(
		request: any,
		result: any,
		token: vscode.CancellationToken
	): Promise<any> {
		try {
			for (const codeBlock of request.codeBlocks) {
				if (token.isCancellationRequested) {
					return { errorMessage: 'Operation was cancelled' };
				}

				// Read original file content
				const originalContent = await readFileContent(codeBlock.resource, token);

				if (token.isCancellationRequested) {
					return { errorMessage: 'Operation was cancelled' };
				}

				// Compute edits with enhanced parameters
				// Access custom properties that may be present on the codeBlock
				const editType = (codeBlock as any).editType;
				const anchorContext = (codeBlock as any).anchorContext;
				const edits = computeTextEdits(
					originalContent,
					codeBlock.code,
					editType,
					anchorContext
				);

				// Stream edits to the result
				if (edits.length > 0) {
					result.textEdit(codeBlock.resource, edits);
				}
			}

			return undefined; // Success
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { errorMessage: `Failed to compute diffs: ${message}` };
		}
	}
};

export function activate(context: vscode.ExtensionContext): void {
	const disposable = (vscode.chat as any).registerMappedEditsProvider2(provider);
	context.subscriptions.push(disposable);
}

export function deactivate(): void {
	// Cleanup handled by context subscriptions
}

