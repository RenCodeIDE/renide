/**
 * HTML template for the graph visualization webview panel.
 * @param libSrc - The URI to the Cytoscape.js library script
 * @param nonce - Content Security Policy nonce for inline scripts
 * @returns Complete HTML document string for the webview
 */
export function buildGraphWebviewHTML(libSrc: string, nonce: string): string {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Graph</title>
		<style>
			html, body {
				height: 100%;
				width: 100%;
				margin: 0;
				padding: 0;
				background: transparent;
				color: var(--vscode-editor-foreground);
				font-family: var(--vscode-font-family, sans-serif);
			}

			#cy {
				height: 100%;
				width: 100%;
				position: absolute;
				top: 0;
				left: 0;
			}

			#toolbar {
				position: absolute;
				top: 12px;
				right: 12px;
				display: flex;
				gap: 8px;
				padding: 8px 10px;
				border-radius: 8px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
				z-index: 5;
			}

			#toolbar button {
				background: var(--vscode-button-secondaryBackground, #2d2d30);
				color: var(--vscode-button-secondaryForeground, #ffffff);
				border: 1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.2));
				border-radius: 4px;
				padding: 4px 10px;
				font-size: 12px;
				cursor: pointer;
				line-height: 1.4;
			}

			#toolbar button:hover {
				background: var(--vscode-button-hoverBackground, #3c3c40);
			}

			#status {
				position: absolute;
				left: 16px;
				bottom: 16px;
				padding: 8px 12px;
				border-radius: 6px;
				font-size: 12px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
				color: var(--vscode-editorWidget-foreground, #ffffff);
				display: none;
				pointer-events: none;
				box-shadow: 0 2px 8px rgba(0,0,0,0.25);
				z-index: 6;
			}

			#status.show {
				display: inline-flex;
			}

			#status.info {
				background: var(--vscode-charts-blue, rgba(33, 150, 243, 0.75));
			}

			#status.success {
				background: var(--vscode-charts-green, rgba(102, 187, 106, 0.75));
			}

			#status.warning {
				background: var(--vscode-charts-orange, rgba(255, 183, 77, 0.85));
				color: #211b00;
			}

			#status.error {
				background: var(--vscode-charts-red, rgba(244, 67, 54, 0.85));
			}

			#status.loading {
				background: var(--vscode-editorHoverWidget-background, rgba(158, 158, 158, 0.8));
				color: var(--vscode-editorHoverWidget-foreground, #000000);
			}
		</style>
	</head>
	<body>
		<div id="cy" role="presentation" aria-hidden="true"></div>
		<div id="toolbar" aria-label="Graph controls">
			<button id="selectFile" title="Select a file to visualize">Select File...</button>
			<button id="zoomIn" title="Zoom in">+</button>
			<button id="zoomOut" title="Zoom out">-</button>
		</div>
		<div id="status" class="status" aria-live="polite"></div>
		<script src="${libSrc}"></script>
		<script nonce="${nonce}">
		(function(){
			const vscode = acquireVsCodeApi();
			let cy;
			let autoClearHandle = undefined;
			const statusEl = document.getElementById('status');

			const send = (type, payload) => {
				try {
					vscode.postMessage({ type, payload });
				} catch (error) {
					console.error('[graph-view] failed to post message', error);
				}
			};

			const clearStatus = () => {
				if (autoClearHandle) {
					clearTimeout(autoClearHandle);
					autoClearHandle = undefined;
				}
				statusEl.className = 'status';
				statusEl.textContent = '';
			};

			const updateStatus = (message, level, autoClearMs) => {
				if (!message) {
					clearStatus();
					return;
				}
				if (autoClearHandle) {
					clearTimeout(autoClearHandle);
					autoClearHandle = undefined;
				}
				statusEl.className = 'status show ' + level;
				statusEl.textContent = message;
				if (autoClearMs && autoClearMs > 0) {
					autoClearHandle = window.setTimeout(() => {
						clearStatus();
						send('REN_GRAPH_EVT', { type: 'status-auto-clear' });
					}, autoClearMs);
				}
			};

			const ensureCy = () => {
				if (cy) {
					return;
				}
				cy = window.cytoscape({
					container: document.getElementById('cy'),
					style: [
						{ selector: 'node', style: {
							'background-color': '#4FC3F7',
							'border-width': 2,
							'border-color': '#0B1A2B',
							'label': 'data(label)',
							'font-size': 12,
							'font-weight': 600,
							'color': '#0B1A2B',
							'text-wrap': 'wrap',
							'text-max-width': 160,
							'text-valign': 'center',
							'text-halign': 'center',
							'width': 80,
							'height': 80
						}},
						{ selector: 'node.root', style: {
							'background-color': '#FFB300',
							'border-color': '#8D6E63',
							'color': '#221600'
						}},
						{ selector: 'node.external', style: {
							'background-color': '#AB47BC',
							'border-color': '#6A1B9A',
							'color': '#1E0F2B'
						}},
						{ selector: 'edge', style: {
							'width': 2,
							'curve-style': 'bezier',
							'line-color': '#E0E0E0',
							'target-arrow-color': '#E0E0E0',
							'target-arrow-shape': 'triangle',
							'arrow-scale': 1.2,
							'label': 'data(label)',
							'font-size': 11,
							'color': '#ffffff',
							'text-wrap': 'wrap',
							'text-max-width': 140,
							'text-background-color': 'rgba(0, 0, 0, 0.65)',
							'text-background-opacity': 1,
							'text-background-padding': '2px',
							'text-background-shape': 'roundrectangle'
						}},
						{ selector: 'edge.external', style: {
							'line-color': '#B39DDB',
							'target-arrow-color': '#B39DDB'
						}},
						{ selector: 'edge.sideEffect', style: {
							'line-style': 'dashed',
							'line-color': '#FFCC80',
							'target-arrow-color': '#FFCC80',
							'color': '#FFECB3'
						}}
					],
					wheelSensitivity: 0.2,
					minZoom: 0.1,
					maxZoom: 5
				});

				cy.on('tap', 'node', evt => {
					send('REN_GRAPH_EVT', { type: 'node-tap', data: evt.target.data() });
				});
				cy.on('tap', 'edge', evt => {
					send('REN_GRAPH_EVT', { type: 'edge-tap', data: evt.target.data() });
				});
			};

			const applyZoom = factor => {
				if (!cy) {
					return;
				}
				const current = cy.zoom();
				const next = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), current * factor));
				cy.zoom({ level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
				cy.resize();
				send('REN_ZOOM', { zoom: cy.zoom(), pan: cy.pan() });
			};

			const applyGraph = payload => {
				if (!payload) {
					return;
				}
				ensureCy();
				cy.stop();
				cy.elements().remove();
				const nodes = (payload.nodes || []).map(node => ({
					group: 'nodes',
					data: {
						id: node.id,
						label: node.label,
						path: node.path,
						kind: node.kind
					},
					classes: node.kind
				}));
				const edges = (payload.edges || []).map(edge => ({
					group: 'edges',
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						label: edge.label,
						specifier: edge.specifier
					},
					classes: edge.kind
				}));

				cy.add([...nodes, ...edges]);
				cy.resize();

				const rootIds = nodes.filter(n => n.classes === 'root').map(n => n.data.id);
				const layoutName = nodes.length > 14 ? 'cose' : 'breadthfirst';
				const layoutOptions = layoutName === 'breadthfirst'
					? { name: 'breadthfirst', directed: true, padding: 80, spacingFactor: 1.2, roots: rootIds }
					: { name: 'cose', padding: 60, animate: false };

				const layout = cy.layout(layoutOptions);
				layout.one('layoutstop', () => {
					cy.fit(undefined, 80);
					send('REN_GRAPH_APPLIED', { nodes: nodes.length, edges: edges.length });
				});
				layout.run();
			};

			window.addEventListener('message', event => {
				const message = event.data || {};
				switch (message.type) {
					case 'REN_GRAPH_DATA':
						applyGraph(message.payload);
						break;
					case 'REN_GRAPH_STATUS':
						updateStatus(message.payload?.message || '', message.payload?.level || 'info', message.payload?.autoClearMs);
						break;
					case 'REN_GRAPH_ERROR':
						updateStatus('Graph rendering error inside webview.', 'error');
						break;
					default:
						break;
				}
			});

			document.getElementById('selectFile').addEventListener('click', () => send('REN_SELECT_FILE'));
			document.getElementById('zoomIn').addEventListener('click', () => applyZoom(1.2));
			document.getElementById('zoomOut').addEventListener('click', () => applyZoom(1 / 1.2));

			window.addEventListener('resize', () => {
				if (!cy) {
					return;
				}
				cy.resize();
			});

			const init = () => {
				if (typeof window.cytoscape !== 'function') {
					setTimeout(init, 50);
					return;
				}
				ensureCy();
				send('REN_GRAPH_READY');
			};

			init();
		})();
		</script>
	</body>
	</html>`;
}

