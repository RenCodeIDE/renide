/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IToolContextResolverService = createDecorator<IToolContextResolverService>('toolContextResolverService');

/**
 * Context available for smart tool defaults
 */
export interface IToolContext {
	// Active editor state
	activeFile?: URI;
	activeFileLanguage?: string;
	cursorPosition?: { line: number; column: number };
	selection?: { text: string; range: IRange };
	visibleRange?: IRange;

	// Recent activity
	recentFiles?: URI[];

	// Diagnostics
	linterErrors?: Array<{
		uri: URI;
		message: string;
		severity: 'error' | 'warning' | 'info';
		line: number;
		column: number;
	}>;

	// Workspace
	workspaceFolders?: URI[];
	workspaceRoot?: URI;
}

export interface IToolContextResolverService {
	readonly _serviceBrand: undefined;

	/**
	 * Get current IDE context for smart tool defaults
	 */
	getContext(): IToolContext;

	/**
	 * Get just the active file URI (convenience method)
	 */
	getActiveFileUri(): URI | undefined;

	/**
	 * Get the file with the most linter errors
	 */
	getFileWithMostErrors(): URI | undefined;

	/**
	 * Get current selection text
	 */
	getSelectionText(): string | undefined;
}

export class ToolContextResolverService extends Disposable implements IToolContextResolverService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getContext(): IToolContext {
		const activeEditor = this.codeEditorService.getActiveCodeEditor();
		const model = activeEditor?.getModel();
		const position = activeEditor?.getPosition();
		const selection = activeEditor?.getSelection();

		// Get selection text if there's a non-empty selection
		let selectionInfo: IToolContext['selection'];
		if (selection && model && !selection.isEmpty()) {
			selectionInfo = {
				text: model.getValueInRange(selection),
				range: selection,
			};
		}

		// Get visible range
		const visibleRanges = activeEditor?.getVisibleRanges();
		const visibleRange = visibleRanges && visibleRanges.length > 0 ? visibleRanges[0] : undefined;

		// Get recent files from editor history
		const recentFiles = this.getRecentFiles();

		// Get linter errors
		const linterErrors = this.getTopLinterErrors();

		// Get workspace info
		const workspace = this.workspaceContext.getWorkspace();
		const workspaceFolders = workspace.folders.map(f => f.uri);
		const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;

		return {
			activeFile: model?.uri,
			activeFileLanguage: model?.getLanguageId(),
			cursorPosition: position ? {
				line: position.lineNumber,
				column: position.column,
			} : undefined,
			selection: selectionInfo,
			visibleRange,
			recentFiles,
			linterErrors,
			workspaceFolders,
			workspaceRoot,
		};
	}

	getActiveFileUri(): URI | undefined {
		const activeEditor = this.codeEditorService.getActiveCodeEditor();
		return activeEditor?.getModel()?.uri;
	}

	getFileWithMostErrors(): URI | undefined {
		const markers = this.markerService.read({ severities: MarkerSeverity.Error });
		if (markers.length === 0) {
			return undefined;
		}

		// Count errors per file
		const errorCounts = new Map<string, { uri: URI; count: number }>();
		for (const marker of markers) {
			const key = marker.resource.toString();
			const existing = errorCounts.get(key);
			if (existing) {
				existing.count++;
			} else {
				errorCounts.set(key, { uri: marker.resource, count: 1 });
			}
		}

		// Find file with most errors
		let maxFile: { uri: URI; count: number } | undefined;
		for (const entry of errorCounts.values()) {
			if (!maxFile || entry.count > maxFile.count) {
				maxFile = entry;
			}
		}

		return maxFile?.uri;
	}

	getSelectionText(): string | undefined {
		const activeEditor = this.codeEditorService.getActiveCodeEditor();
		const model = activeEditor?.getModel();
		const selection = activeEditor?.getSelection();

		if (selection && model && !selection.isEmpty()) {
			return model.getValueInRange(selection);
		}

		return undefined;
	}

	private getRecentFiles(): URI[] {
		try {
			// Get recently opened editors (up to 10)
			const editors = this.editorService.getEditors(0); // 0 = MOST_RECENTLY_ACTIVE
			const uris: URI[] = [];

			for (const editor of editors.slice(0, 10)) {
				const resource = editor.editor.resource;
				if (resource && resource.scheme === 'file') {
					uris.push(resource);
				}
			}

			return uris;
		} catch (error) {
			this.logService.warn('[ToolContextResolverService] Error getting recent files:', error);
			return [];
		}
	}

	private getTopLinterErrors(): IToolContext['linterErrors'] {
		try {
			const markers = this.markerService.read({
				severities: MarkerSeverity.Error | MarkerSeverity.Warning
			});

			// Limit to top 20 for performance
			return markers.slice(0, 20).map(marker => ({
				uri: marker.resource,
				message: marker.message,
				severity: marker.severity === MarkerSeverity.Error ? 'error' as const :
					marker.severity === MarkerSeverity.Warning ? 'warning' as const : 'info' as const,
				line: marker.startLineNumber,
				column: marker.startColumn,
			}));
		} catch (error) {
			this.logService.warn('[ToolContextResolverService] Error getting linter errors:', error);
			return [];
		}
	}
}
