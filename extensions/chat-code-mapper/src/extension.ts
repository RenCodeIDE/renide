/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Computes minimal text edits between original and new code using a line-by-line diff.
 * Uses a simple prefix/suffix optimization to minimize the diff size.
 */
function computeTextEdits(original: string, newCode: string): vscode.TextEdit[] {
	// Handle empty cases
	if (original === newCode) {
		return [];
	}

	const oldLines = original.split(/\r?\n/);
	const newLines = newCode.split(/\r?\n/);

	// Find common prefix
	let prefixEnd = 0;
	while (
		prefixEnd < oldLines.length &&
		prefixEnd < newLines.length &&
		oldLines[prefixEnd] === newLines[prefixEnd]
	) {
		prefixEnd++;
	}

	// Find common suffix (only in the remaining sections)
	let suffixStart = oldLines.length;
	let suffixStartNew = newLines.length;
	while (
		suffixStart > prefixEnd &&
		suffixStartNew > prefixEnd &&
		oldLines[suffixStart - 1] === newLines[suffixStartNew - 1]
	) {
		suffixStart--;
		suffixStartNew--;
	}

	// Calculate ranges (0-based line numbers for VS Code API)
	// prefixEnd: first line that differs (0-based)
	// suffixStart: first line after differences from end (0-based, exclusive)
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

	// Determine the end position for the range
	// VS Code Range end is exclusive, so Range(startLine, 0, endLine, 0) means:
	// "from start of line startLine to start of line endLine" (replacing lines startLine to endLine-1)

	let endLineNumber: number;
	let endCharacter: number;

	if (startLine === endLine) {
		// Insertion case: inserting at a specific line position
		if (startLine >= oldLines.length) {
			// Appending to end of file - clamp to valid position
			endLineNumber = oldLines.length;
			endCharacter = 0;
			// For insertion at end, both start and end should be at the end
		} else {
			// Inserting at existing line - use same line for start and end
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

	// Clamp startLine to document bounds only if it's beyond the document
	// (for insertion at end case)
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
const provider: vscode.MappedEditsProvider2 = {
	async provideMappedEdits(
		request: vscode.MappedEditsRequest,
		result: vscode.MappedEditsResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.MappedEditsResult | undefined> {
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

				// Compute edits
				const edits = computeTextEdits(originalContent, codeBlock.code);

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
	const disposable = vscode.chat.registerMappedEditsProvider2(provider);
	context.subscriptions.push(disposable);
}

export function deactivate(): void {
	// Cleanup handled by context subscriptions
}

