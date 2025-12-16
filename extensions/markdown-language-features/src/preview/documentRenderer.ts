/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as uri from 'vscode-uri';
import { ILogger } from '../logging';
import { MarkdownItEngine } from '../markdownEngine';
import { MarkdownContributionProvider } from '../markdownExtensions';
import { escapeAttribute, getNonce } from '../util/dom';
import { WebviewResourceProvider } from '../util/resources';
import { MarkdownPreviewConfiguration, MarkdownPreviewConfigurationManager } from './previewConfig';
import { ContentSecurityPolicyArbiter, MarkdownPreviewSecurityLevel } from './security';


/**
 * Strings used inside the markdown preview.
 *
 * Stored here and then injected in the preview so that they
 * can be localized using our normal localization process.
 */
const previewStrings = {
	cspAlertMessageText: vscode.l10n.t("Some content has been disabled in this document"),

	cspAlertMessageTitle: vscode.l10n.t("Potentially unsafe or insecure content has been disabled in the Markdown preview. Change the Markdown preview security setting to allow insecure content or enable scripts"),

	cspAlertMessageLabel: vscode.l10n.t("Content Disabled Security Warning")
};

export interface MarkdownContentProviderOutput {
	html: string;
	containingImages: Set<string>;
}

export interface ImageInfo {
	readonly id: string;
	readonly width: number;
	readonly height: number;
}

export class MdDocumentRenderer {
	constructor(
		private readonly _engine: MarkdownItEngine,
		private readonly _context: vscode.ExtensionContext,
		private readonly _cspArbiter: ContentSecurityPolicyArbiter,
		private readonly _contributionProvider: MarkdownContributionProvider,
		private readonly _logger: ILogger
	) {
		this.iconPath = {
			dark: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'preview-dark.svg'),
			light: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'preview-light.svg'),
		};
	}

	public readonly iconPath: { light: vscode.Uri; dark: vscode.Uri };

	public async renderDocument(
		markdownDocument: vscode.TextDocument,
		resourceProvider: WebviewResourceProvider,
		previewConfigurations: MarkdownPreviewConfigurationManager,
		initialLine: number | undefined,
		selectedLine: number | undefined,
		state: any | undefined,
		imageInfo: readonly ImageInfo[],
		token: vscode.CancellationToken
	): Promise<MarkdownContentProviderOutput> {
		const sourceUri = markdownDocument.uri;
		const config = previewConfigurations.loadAndCacheConfiguration(sourceUri);
		const initialData = {
			source: sourceUri.toString(),
			fragment: state?.fragment || markdownDocument.uri.fragment || undefined,
			line: initialLine,
			selectedLine,
			scrollPreviewWithEditor: config.scrollPreviewWithEditor,
			scrollEditorWithPreview: config.scrollEditorWithPreview,
			doubleClickToSwitchToEditor: config.doubleClickToSwitchToEditor,
			disableSecurityWarnings: this._cspArbiter.shouldDisableSecurityWarnings(),
			webviewResourceRoot: resourceProvider.asWebviewUri(markdownDocument.uri).toString(),
		};

		this._logger.trace('DocumentRenderer', `provideTextDocumentContent - ${markdownDocument.uri}`, initialData);

		// Content Security Policy
		const nonce = getNonce();
		const csp = this._getCsp(resourceProvider, sourceUri, nonce);

		const body = await this.renderBody(markdownDocument, resourceProvider, nonce);
		if (token.isCancellationRequested) {
			return { html: '', containingImages: new Set() };
		}

		const html = `<!DOCTYPE html>
			<html style="${escapeAttribute(this._getSettingsOverrideStyles(config))}">
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
				<meta id="vscode-markdown-preview-data"
					data-settings="${escapeAttribute(JSON.stringify(initialData))}"
					data-strings="${escapeAttribute(JSON.stringify(previewStrings))}"
					data-state="${escapeAttribute(JSON.stringify(state || {}))}"
					data-initial-md-content="${escapeAttribute(body.html)}">
				<script src="${this._extensionResourcePath(resourceProvider, 'pre.js')}" nonce="${nonce}"></script>
				${this._getStyles(resourceProvider, sourceUri, config, imageInfo)}
				<base href="${resourceProvider.asWebviewUri(markdownDocument.uri)}">
			</head>
			<body class="vscode-body ${config.scrollBeyondLastLine ? 'scrollBeyondLastLine' : ''} ${config.wordWrap ? 'wordWrap' : ''} ${config.markEditorSelection ? 'showEditorSelection' : ''}">
				${this._getScripts(resourceProvider, nonce)}
			</body>
			</html>`;
		return {
			html,
			containingImages: body.containingImages,
		};
	}

	public async renderBody(
		markdownDocument: vscode.TextDocument,
		resourceProvider: WebviewResourceProvider,
		nonce?: string,
	): Promise<MarkdownContentProviderOutput> {
		const rendered = await this._engine.render(markdownDocument, resourceProvider);

		// Inject enhanced plan preview for .plan.md files
		let planFileHeader = '';
		let planProgressScript = '';
		if (markdownDocument.uri.fsPath.endsWith('.plan.md')) {
			const sourceUri = markdownDocument.uri.toString();
			const scriptNonce = nonce || getNonce();
			const planContent = markdownDocument.getText();
			const planStats = this.parsePlanStats(planContent);

			// Extract todos for display
			const todos = this.extractTodosForDisplay(planContent);
			const incompleteTodos = todos.filter(t => !t.completed);

			const commandHref = `command:workbench.action.chat.startPlanExecution?${encodeURIComponent(sourceUri)}`;

			planFileHeader = `
				<div class="plan-execution-header" style="background: var(--vscode-editor-background); padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 16px; border-radius: 6px; border: 1px solid var(--vscode-panel-border);">
					<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px;">
						<a id="start-execution-btn" href="${commandHref}" style="display: inline-block; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; text-decoration: none;">
							▶ Start Execution
						</a>
						<div id="execution-status-badge" style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); display: none;">
							<span id="execution-status-text">Not Started</span>
						</div>
						<div style="flex: 1; min-width: 200px;">
							<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
								<span style="font-size: 12px; color: var(--vscode-descriptionForeground);">Progress:</span>
								<span id="plan-progress-text" style="font-size: 12px; font-weight: 500;">${planStats.progress}%</span>
							</div>
							<div style="width: 100%; height: 6px; background: var(--vscode-progressBar-background); border-radius: 3px; overflow: hidden;">
								<div id="plan-progress-bar" style="height: 100%; width: ${planStats.progress}%; background: var(--vscode-progressBar-foreground); transition: width 0.3s ease;"></div>
							</div>
						</div>
						<div style="font-size: 12px; color: var(--vscode-descriptionForeground);">
							<span id="plan-todo-stats">${planStats.completedTodos}/${planStats.totalTodos} todos</span>
						</div>
					</div>
					<div id="plan-todos-container" style="border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; margin-top: 8px; ${incompleteTodos.length === 0 ? 'display: none;' : ''}">
						<div style="font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground);">
							<span id="plan-todos-title">Todos (${incompleteTodos.length} remaining):</span>
						</div>
						<div id="plan-todos-list" style="max-height: 200px; overflow-y: auto; font-size: 12px;">
							${incompleteTodos.map((todo, index) => {
								const todoId = `todo-${index}-${todo.text.substring(0, 20).replace(/\s+/g, '-')}`;
								return `
								<div class="plan-todo-item" data-todo-id="${escapeAttribute(todoId)}" style="padding: 6px 0; display: flex; align-items: start; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
									<span class="plan-todo-icon" style="color: var(--vscode-descriptionForeground); min-width: 16px;">☐</span>
									<span class="plan-todo-text" style="flex: 1; color: var(--vscode-foreground);">${this.escapeHtml(todo.text)}</span>
									<span class="plan-todo-status" style="font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase;">pending</span>
								</div>
							`;
							}).join('')}
						</div>
					</div>
				</div>
			`;

			planProgressScript = `
				<script nonce="${scriptNonce}">
					(function() {
						function attachExecutionHandler() {
							const button = document.getElementById('start-execution-btn');
							if (button) {
								button.addEventListener('click', () => {
									console.log('[Plan Execution] Button clicked for:', '${sourceUri}');
									// Use existing API if available (exposed from preview-src/index.ts)
									const vscode = window.vscodeApi;
									if (!vscode) {
										console.error('[Plan Execution] VS Code API not available');
										alert('VS Code API not available. Please refresh the preview.');
										return;
									}

									try {
										const message = {
											type: 'startExecution',
											source: '${sourceUri}'
										};
										console.log('[Plan Execution] Sending message:', message);
										vscode.postMessage(message);
										console.log('[Plan Execution] Message sent successfully');
									} catch (error) {
										console.error('[Plan Execution] Failed to send message:', error);
										alert('Failed to send execution request: ' + (error instanceof Error ? error.message : String(error)));
									}
								});
								return true;
							}
							return false;
						}

						// Try to attach handler immediately
						if (!attachExecutionHandler()) {
							// If button not found, wait a bit and retry (handles timing issues)
							setTimeout(() => {
								if (!attachExecutionHandler()) {
									console.warn('[Plan Execution] Button not found after retry. The execute plan button may not be available.');
								}
							}, 100);
						}

						// Enhance todos with interactive checkboxes
						const todoRegex = /<li[^>]*>\\s*<input[^>]*type=["']checkbox["'][^>]*>/gi;
						const listItems = document.querySelectorAll('li');
						listItems.forEach(li => {
							const text = li.textContent || '';
							if (/^\\s*\\[\\s*\\]/.test(text) || /^\\s*\\[x\\]/i.test(text)) {
								li.classList.add('plan-todo-item');
								const isChecked = /^\\s*\\[x\\]/i.test(text);
								if (isChecked) {
									li.style.opacity = '0.6';
									li.style.textDecoration = 'line-through';
								}
							}
						});

						// Add section progress indicators
						const sections = document.querySelectorAll('h2');
						sections.forEach(section => {
							const sectionId = section.id || section.textContent?.toLowerCase().replace(/\\s+/g, '-') || '';
							const sectionContent = section.nextElementSibling;
							if (sectionContent) {
								const todos = sectionContent.querySelectorAll('.plan-todo-item');
								if (todos.length > 0) {
									const completed = Array.from(todos).filter(t => t.style.textDecoration === 'line-through').length;
									const total = todos.length;
									const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

									const progressBadge = document.createElement('span');
									progressBadge.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--vscode-descriptionForeground);';
									progressBadge.textContent = \`[\${completed}/\${total}]\`;
									section.appendChild(progressBadge);
								}
							}
						});

						// Listen for progress updates
						window.addEventListener('message', (event) => {
							const data = event.data;
							if (data && data.type === 'updatePlanProgress' && data.source === '${sourceUri}') {
								const progressText = document.getElementById('plan-progress-text');
								const progressBar = document.getElementById('plan-progress-bar');
								const todoStats = document.getElementById('plan-todo-stats');
								const statusBadge = document.getElementById('execution-status-badge');
								const statusText = document.getElementById('execution-status-text');
								const button = document.getElementById('start-execution-btn');

								if (progressText) progressText.textContent = data.progress + '%';
								if (progressBar) progressBar.style.width = data.progress + '%';
								if (todoStats) todoStats.textContent = data.completedTodos + '/' + data.totalTodos + ' todos';

								if (data.status && statusBadge && statusText) {
									const statusLabels = {
										'not-started': 'Not Started',
										'starting': 'Starting...',
										'in-progress': 'Executing',
										'completed': 'Completed',
										'failed': 'Failed'
									};
									statusText.textContent = statusLabels[data.status] || 'Unknown';
									statusBadge.style.display = 'block';

									if (button) {
										const buttonLabels = {
											'not-started': '▶ Start Execution',
											'starting': '⏳ Starting...',
											'in-progress': '⏸ Pause Execution',
											'completed': '✓ Completed',
											'failed': '✗ Failed'
										};
										button.textContent = buttonLabels[data.status] || '▶ Start Execution';
										if (data.status === 'completed' || data.status === 'failed') {
											button.disabled = true;
										}
									}
								}
							}
						});
					})();
				</script>
			`;
		}

		const html = `${planFileHeader}<div class="markdown-body" dir="auto">${rendered.html}<div class="code-line" data-line="${markdownDocument.lineCount}"></div></div>${planProgressScript}`;
		return {
			html,
			containingImages: rendered.containingImages
		};
	}

	/**
	 * Parse plan statistics from markdown content
	 */
	private parsePlanStats(content: string): { totalTodos: number; completedTodos: number; progress: number } {
		const todos = this.extractTodosForDisplay(content);
		const totalTodos = todos.length;
		const completedTodos = todos.filter(t => t.completed).length;
		const progress = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

		return { totalTodos, completedTodos, progress };
	}

	/**
	 * Extract todos from plan content for display
	 */
	private extractTodosForDisplay(content: string): Array<{ text: string; completed: boolean }> {
		const todos: Array<{ text: string; completed: boolean }> = [];
		const todoPatterns = [
			/^\s*[-*]\s*\[([\sx])\]\s*(.+)$/gim,  // Standard: - [ ] or - [x]
			/^\s*\d+\.\s*\[([\sx])\]\s*(.+)$/gim, // Numbered: 1. [ ] or 1. [x]
		];

		for (const pattern of todoPatterns) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(content)) !== null) {
				todos.push({
					text: match[2].trim(),
					completed: match[1].toLowerCase() === 'x'
				});
			}
		}

		return todos;
	}

	/**
	 * Escape HTML to prevent XSS
	 * Note: Uses manual string replacement since this runs in Node.js context,
	 * not browser context where document.createElement would be available.
	 */
	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	public renderFileNotFoundDocument(resource: vscode.Uri): string {
		const resourcePath = uri.Utils.basename(resource);
		const body = vscode.l10n.t('{0} cannot be found', resourcePath);
		return `<!DOCTYPE html>
			<html>
			<body class="vscode-body">
				${body}
			</body>
			</html>`;
	}

	private _extensionResourcePath(resourceProvider: WebviewResourceProvider, mediaFile: string): string {
		const webviewResource = resourceProvider.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, 'media', mediaFile));
		return webviewResource.toString();
	}

	private _fixHref(resourceProvider: WebviewResourceProvider, resource: vscode.Uri, href: string): string {
		if (!href) {
			return href;
		}

		if (href.startsWith('http:') || href.startsWith('https:') || href.startsWith('file:')) {
			return href;
		}

		// Assume it must be a local file
		if (href.startsWith('/') || /^[a-z]:\\/i.test(href)) {
			return resourceProvider.asWebviewUri(vscode.Uri.file(href)).toString();
		}

		// Use a workspace relative path if there is a workspace
		const root = vscode.workspace.getWorkspaceFolder(resource);
		if (root) {
			return resourceProvider.asWebviewUri(vscode.Uri.joinPath(root.uri, href)).toString();
		}

		// Otherwise look relative to the markdown file
		return resourceProvider.asWebviewUri(vscode.Uri.joinPath(uri.Utils.dirname(resource), href)).toString();
	}

	private _computeCustomStyleSheetIncludes(resourceProvider: WebviewResourceProvider, resource: vscode.Uri, config: MarkdownPreviewConfiguration): string {
		if (!Array.isArray(config.styles)) {
			return '';
		}
		const out: string[] = [];
		for (const style of config.styles) {
			out.push(`<link rel="stylesheet" class="code-user-style" data-source="${escapeAttribute(style)}" href="${escapeAttribute(this._fixHref(resourceProvider, resource, style))}" type="text/css" media="screen">`);
		}
		return out.join('\n');
	}

	private _getSettingsOverrideStyles(config: MarkdownPreviewConfiguration): string {
		return [
			config.fontFamily ? `--markdown-font-family: ${config.fontFamily};` : '',
			isNaN(config.fontSize) ? '' : `--markdown-font-size: ${config.fontSize}px;`,
			isNaN(config.lineHeight) ? '' : `--markdown-line-height: ${config.lineHeight};`,
		].join(' ');
	}

	private _getImageStabilizerStyles(imageInfo: readonly ImageInfo[]): string {
		if (!imageInfo.length) {
			return '';
		}

		let ret = '<style>\n';
		for (const imgInfo of imageInfo) {
			ret += `#${imgInfo.id}.loading {
					height: ${imgInfo.height}px;
					width: ${imgInfo.width}px;
				}\n`;
		}
		ret += '</style>\n';

		return ret;
	}

	private _getStyles(resourceProvider: WebviewResourceProvider, resource: vscode.Uri, config: MarkdownPreviewConfiguration, imageInfo: readonly ImageInfo[]): string {
		const baseStyles: string[] = [];
		for (const resource of this._contributionProvider.contributions.previewStyles) {
			baseStyles.push(`<link rel="stylesheet" type="text/css" href="${escapeAttribute(resourceProvider.asWebviewUri(resource))}">`);
		}

		return `${baseStyles.join('\n')}
			${this._computeCustomStyleSheetIncludes(resourceProvider, resource, config)}
			${this._getImageStabilizerStyles(imageInfo)}`;
	}

	private _getScripts(resourceProvider: WebviewResourceProvider, nonce: string): string {
		const out: string[] = [];
		for (const resource of this._contributionProvider.contributions.previewScripts) {
			out.push(`<script async
				src="${escapeAttribute(resourceProvider.asWebviewUri(resource))}"
				nonce="${nonce}"
				charset="UTF-8"></script>`);
		}
		return out.join('\n');
	}

	private _getCsp(
		provider: WebviewResourceProvider,
		resource: vscode.Uri,
		nonce: string
	): string {
		const rule = provider.cspSource.split(';')[0];
		switch (this._cspArbiter.getSecurityLevelForResource(resource)) {
			case MarkdownPreviewSecurityLevel.AllowInsecureContent:
				return `default-src 'none'; img-src 'self' ${rule} http: https: data:; media-src 'self' ${rule} http: https: data:; script-src 'nonce-${nonce}'; style-src 'self' ${rule} 'unsafe-inline' http: https: data:; font-src 'self' ${rule} http: https: data:;`;

			case MarkdownPreviewSecurityLevel.AllowInsecureLocalContent:
				return `default-src 'none'; img-src 'self' ${rule} https: data: http://localhost:* http://127.0.0.1:*; media-src 'self' ${rule} https: data: http://localhost:* http://127.0.0.1:*; script-src 'nonce-${nonce}'; style-src 'self' ${rule} 'unsafe-inline' https: data: http://localhost:* http://127.0.0.1:*; font-src 'self' ${rule} https: data: http://localhost:* http://127.0.0.1:*;`;

			case MarkdownPreviewSecurityLevel.AllowScriptsAndAllContent:
				return ``;

			case MarkdownPreviewSecurityLevel.Strict:
			default:
				return `default-src 'none'; img-src 'self' ${rule} https: data:; media-src 'self' ${rule} https: data:; script-src 'nonce-${nonce}'; style-src 'self' ${rule} 'unsafe-inline' https: data:; font-src 'self' ${rule} https: data:;`;
		}
	}
}
