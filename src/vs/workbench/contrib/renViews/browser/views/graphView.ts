/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../../base/browser/dom.js';
// import { sanitizeHtml } from '../../../../../base/browser/domSanitize.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
// import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { ensureCodeWindow, CodeWindow } from '../../../../../base/browser/window.js';
import { FileAccess } from '../../../../../base/common/network.js';
// import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { asWebviewUri } from '../../../webview/common/webview.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IRenView } from './renView.interface.js';

export class GraphView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _toolbar: HTMLElement | null = null;
	private _window: Window | null = null;
	private _webview: IWebviewElement | null = null;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
	) {
		super();
	}

	show(contentArea: HTMLElement): void {
		this.logService.info('[GraphView] show()');
		// Clear existing content safely
		contentArea.textContent = '';

		// Store window reference
		this._window = getWindow(contentArea);

		// Create main container
		this._mainContainer = document.createElement('div');
		this._mainContainer.className = 'ren-graph-container';
		// Ensure container participates in layout and fills available space
		this._mainContainer.style.display = 'flex';
		this._mainContainer.style.flexDirection = 'column';
		this._mainContainer.style.height = '100%';

		// Create title
		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.className = 'ren-graph-title';

		// Create viewport container
		const viewport = document.createElement('div');
		viewport.className = 'ren-graph-viewport';
		viewport.style.position = 'relative';
		viewport.style.flex = '1 1 auto';
		viewport.style.minHeight = '240px';

		this._mainContainer.appendChild(title);
		this._mainContainer.appendChild(viewport);

		// Create toolbar for view switching
		this.createToolbar();
		this._mainContainer.appendChild(this._toolbar!);

		contentArea.appendChild(this._mainContainer);

		// Load Cytoscape into a real Webview element
		this.loadWebview(viewport);
	}


	private async loadWebview(container: HTMLElement): Promise<void> {
		if (!this._window) {
			return;
		}

		// Create workbench webview element (matches Getting Started and other views)
		this._webview = this.webviewService.createWebviewElement({
			title: 'Graph',
			options: {
				disableServiceWorker: false,
				enableFindWidget: false
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [FileAccess.asFileUri('vs/workbench/contrib/renViews/browser/media/')]
			},
			extension: undefined,
		});

		// Claim and mount the webview properly
		const win = this._window!;
		ensureCodeWindow(win, 1);
		this._webview.mountTo(container, win as unknown as CodeWindow);
		this._register(this._webview);
		container.style.position = container.style.position || 'relative';
		container.style.height = '100%';

		// Build HTML with proper CSP using webview's built-in system
		const mediaRoot = FileAccess.asFileUri('vs/workbench/contrib/renViews/browser/media/');
		const libUri = asWebviewUri(joinPath(mediaRoot, 'cytoscape.min.js')).toString(true);
		const nonce = generateUuid();
		const html = this.buildWebviewHTMLForPanel(libUri, nonce);
		this._webview.setHtml(html);

		// Set up proper webview event handling (following VS Code patterns)
		this._register(this._webview.onMessage(e => {
			const data = e.message;
			if (data?.type === 'REN_GRAPH_READY') {
				this.logService.info('[GraphView] graph ready', data?.payload ?? '');
				return;
			}
			if (data?.type === 'REN_GRAPH_EVT') {
				this.logService.info('[GraphView] graph evt', data?.payload ?? '');
				return;
			}
			if (data?.type === 'REN_ZOOM') {
				this.logService.info('[GraphView] zoom button', data?.payload ?? '');
				return;
			}
			if (data?.type === 'REN_WHEEL') {
				this.logService.info('[GraphView] wheel', data?.payload ?? '');
				return;
			}
			if (data?.type === 'REN_GRAPH_ERROR') {
				this.logService.error('[GraphView] webview error', data?.payload ?? '');
				return;
			}
		}));

		// Basic failure indicator
		const failTimer = this._window.setTimeout(() => {
			this.logService.error('[GraphView] graph failed to load (timeout)');
			this.showGraphFailed(container);
		}, 5000);

		// Clear timer when webview is ready
		this._register(this._webview.onMessage(e => {
			if (e.message?.type === 'REN_GRAPH_READY') {
				clearTimeout(failTimer);
			}
		}));
	}

	// old iframe builder removed

	private createToolbar(): void {
		if (!this._mainContainer) {
			return;
		}

		this._toolbar = document.createElement('div');
		this._toolbar.className = 'ren-graph-toolbar';

		const codeButton = document.createElement('button');
		codeButton.className = 'ren-graph-toolbar-btn';
		codeButton.textContent = 'Code';
		codeButton.title = 'Switch to Code View';
		codeButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'code' }));
		});
		this._toolbar.appendChild(codeButton);

		const previewButton = document.createElement('button');
		previewButton.className = 'ren-graph-toolbar-btn';
		previewButton.textContent = 'Preview';
		previewButton.title = 'Switch to Preview View';
		previewButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'preview' }));
		});
		this._toolbar.appendChild(previewButton);

		const graphButton = document.createElement('button');
		graphButton.className = 'ren-graph-toolbar-btn active';
		graphButton.textContent = 'Graph';
		graphButton.title = 'Already in Graph View';
		graphButton.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('ren-switch-view', { detail: 'graph' }));
		});
		this._toolbar.appendChild(graphButton);
	}

	hide(): void {
		if (this._mainContainer) {
			this._mainContainer.remove();
			this._mainContainer = null;
			this._toolbar = null;
		}
		// Properly dispose of webview
		if (this._webview) {
			this._webview.dispose();
			this._webview = null;
		}
	}

	private showGraphFailed(container: HTMLElement): void {
		// Replace viewport content with a minimal failure notice
		if (!container) {
			return;
		}
		container.textContent = '';
		const msg = document.createElement('div');
		msg.style.padding = '12px';
		msg.style.color = 'var(--vscode-errorForeground)';
		msg.textContent = 'Graph failed to load.';
		container.appendChild(msg);
	}

	private buildWebviewHTMLForPanel(libSrc: string, nonce: string): string {
		return `<!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            html, body, #cy { height: 100%; width: 100%; margin: 0; padding: 0; background: transparent; }
            #toolbar {
              position: absolute;
              top: 12px;
              right: 12px;
              display: flex;
              gap: 8px;
              z-index: 99999;
              background: rgba(0,0,0,0.6);
              padding: 6px 8px;
              border-radius: 6px;
              border: 1px solid rgba(255,255,255,0.3);
              pointer-events: auto;
            }
            #toolbar button {
              padding: 6px 10px;
              font-size: 14px;
              border: 1px solid #ffffffaa;
              background: #1e1e1e;
              color: #ffffff;
              border-radius: 4px;
              cursor: pointer;
            }
            #toolbar button:hover { background: #2a2a2a; }
          </style>
          <title>Graph</title>
        </head>
        <body>
          <div id="cy"></div>
          <div id="toolbar" aria-label="graph zoom controls">
            <button id="zoomIn" title="Zoom In">+</button>
            <button id="zoomOut" title="Zoom Out">-</button>
          </div>
          <script src="${libSrc}"></script>
          <script>
            (function(){
              const vscode = acquireVsCodeApi();
              const send=(type,payload)=>{ try{ vscode.postMessage({type,payload}); }catch{} };
              const start=()=>{
                if(!window.cytoscape){ return void setTimeout(start, 50); }
                const cy = window.cytoscape({
                  container: document.getElementById('cy'),
                  elements: [ { data:{id:'a',label:'Node A'} }, { data:{id:'b',label:'Node B'} }, { data:{id:'ab',source:'a',target:'b'} } ],
                  style: [
                    { selector:'node', style:{ 'label':'data(label)', 'background-color':'#4FC3F7', 'color':'#0B1A2B', 'text-valign':'center', 'text-halign':'center', 'width': 70, 'height': 70, 'font-size': 16, 'font-weight': 'bold', 'border-width': 2, 'border-color': '#0B1A2B' } },
                    { selector:'edge', style:{ 'width':3, 'line-color':'#F5F5F5', 'target-arrow-color':'#F5F5F5', 'target-arrow-shape':'triangle', 'curve-style':'bezier', 'opacity': 0.9 } }
                  ],
                  layout:{ name:'grid', rows:1 },
                  userPanningEnabled:true, userZoomingEnabled:true, wheelSensitivity:0.2, minZoom:0.1, maxZoom:5
                });
                cy.zoom(1); cy.center(); cy.resize(); requestAnimationFrame(()=>{ cy.fit(); send('REN_GRAPH_READY',{ zoom: cy.zoom(), pan: cy.pan(), nodes: cy.nodes().length }); });

                const applyZoom = (factor)=>{
                  const z = cy.zoom() * factor;
                  cy.zoom(z);
                  send('REN_ZOOM', { action: factor>1 ? 'in' : 'out', zoom: cy.zoom(), pan: cy.pan() });
                };
                document.getElementById('zoomIn').addEventListener('click', ()=> applyZoom(1.2));
                document.getElementById('zoomOut').addEventListener('click', ()=> applyZoom(1/1.2));
              };
              start();
            })();
          </script>
        </body>
        </html>`;
	}
}
