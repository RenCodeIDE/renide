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

		#legend {
			position: absolute;
			top: 12px;
			left: 12px;
			max-width: 280px;
			padding: 10px 12px;
			border-radius: 8px;
			background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
			border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
			box-shadow: 0 2px 8px rgba(0,0,0,0.25);
			font-size: 12px;
			color: var(--vscode-editorWidget-foreground, #ffffff);
			display: none;
			z-index: 5;
		}

		#legend.visible {
			display: block;
		}

		#legend h3 {
			margin: 0 0 8px;
			font-size: 13px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}

		#legend h4 {
			margin: 12px 0 6px;
			font-size: 12px;
			font-weight: 600;
			letter-spacing: 0.02em;
			text-transform: uppercase;
		}

		#legend .legend-section {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		#legend .legend-category {
			display: flex;
			align-items: center;
			gap: 6px;
			cursor: pointer;
		}

		#legend .legend-category input[type="checkbox"] {
			margin: 0;
			accent-color: var(--vscode-charts-foreground, #4FC3F7);
		}

		#legend .legend-swatch {
			display: inline-flex;
			width: 12px;
			height: 12px;
			border-radius: 3px;
			border: 1px solid rgba(0,0,0,0.4);
		}

		#legend .legend-datasets {
			margin-top: 12px;
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		#legend .legend-dataset {
			padding: 6px 8px;
			border-radius: 6px;
			background: rgba(255,255,255,0.05);
			border-left: 3px solid #4DD0E1;
		}

		#legend .legend-dataset-title {
			font-weight: 600;
			font-size: 12px;
		}

		#legend .legend-dataset-meta {
			margin-top: 2px;
			font-size: 11px;
			color: rgba(255,255,255,0.75);
			line-height: 1.4;
		}

		#legend .legend-relationships {
			margin-top: 10px;
			padding: 8px;
			border-radius: 6px;
			background: rgba(255,255,255,0.04);
		}

		#legend .legend-relationships-item {
			font-size: 11px;
			margin-top: 2px;
			color: rgba(255,255,255,0.75);
		}

		#legend .legend-summary,
		#legend .legend-warnings {
			margin-top: 10px;
			padding: 8px;
			border-radius: 6px;
			background: rgba(255,255,255,0.05);
		}

		#legend .legend-summary ul,
		#legend .legend-warnings ul {
			margin: 6px 0 0;
			padding-left: 18px;
		}

		#legend .legend-warning {
			color: var(--vscode-charts-orange, #ffb74d);
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

			#toolbar button.active {
				background: var(--vscode-button-hoverBackground, #3c3c40);
				border-color: var(--vscode-focusBorder, #007ACC);
				box-shadow: 0 0 0 1px rgba(0, 122, 204, 0.35);
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
		<div id="legend" aria-live="polite" aria-label="Architecture legend"></div>
		<div id="toolbar" aria-label="Graph controls">
			<button id="selectFile" title="Select a target to visualize">Select Target...</button>
			<button id="toggleSelectMode" title="Highlight a node and its connections">Select Nodes</button>
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
			const legendEl = document.getElementById('legend');
		const selectModeButton = document.getElementById('toggleSelectMode');
		let selectionMode = false;
		let highlightedNodeId = null;
		const send = (type, payload) => {
			try {
				vscode.postMessage({ type, payload });
			} catch (error) {
				console.error('[graph-view] failed to post message', error);
			}
		};
		const categoryState = new Map();
		const CATEGORY_STYLES = {
				application: { color: '#FFB300' },
				frontend: { color: '#29B6F6' },
				backend: { color: '#81C784' },
				database: { color: '#FF8A65' },
				cache: { color: '#F06292' },
				queue: { color: '#CE93D8' },
				messageBus: { color: '#9575CD' },
				externalService: { color: '#B39DDB' },
				infrastructure: { color: '#90A4AE' },
				supportingService: { color: '#A5D6A7' },
				configuration: { color: '#C5E1A5' },
			dataset: { color: '#4DD0E1' },
				unknown: { color: '#B0BEC5' }
			};
			const DEFAULT_CATEGORY_STYLE = { color: '#4FC3F7' };

		const normalizeCategory = value => (value || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const titleCase = value => {
				if (!value) {
					return '';
				}
				const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2');
				return spaced.charAt(0).toUpperCase() + spaced.slice(1);
			};
		const basename = value => {
			if (!value) {
				return '';
			}
			const parts = value.split(/[\\/]/);
			return parts[parts.length - 1] || value;
		};
		const pluralize = (count, word) => count === 1 ? word : word + 's';
		const truncate = (value, max) => {
			if (!value || typeof value !== 'string') {
				return '';
			}
			return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + '…';
		};

			const applyCategoryVisibility = () => {
				if (!cy) {
					return;
				}
				cy.batch(() => {
					cy.nodes().forEach(node => {
						const category = node.data('category');
						const visible = !category || categoryState.get(category) !== false;
						node.style('display', visible ? 'element' : 'none');
					});
					cy.edges().forEach(edge => {
						const sourceVisible = edge.source().style('display') !== 'none';
						const targetVisible = edge.target().style('display') !== 'none';
						edge.style('display', sourceVisible && targetVisible ? 'element' : 'none');
					});
				});
			};

		const updateSelectModeButton = () => {
			if (!selectModeButton) {
				return;
			}
			selectModeButton.classList.toggle('active', selectionMode);
			selectModeButton.textContent = selectionMode ? 'Exit Select Mode' : 'Select Nodes';
			selectModeButton.title = selectionMode
				? 'Click to exit select mode and restore the full graph'
				: 'Highlight a node and its immediate connections';
		};

		const clearSelectionHighlight = (notify = false) => {
			const hadHighlight = highlightedNodeId !== null;
			if (cy) {
				cy.batch(() => {
					cy.elements().removeClass('selected connected highlighted dimmed');
				});
			}
			highlightedNodeId = null;
			if (notify && hadHighlight) {
				send('REN_GRAPH_EVT', { type: 'selection-cleared' });
			}
		};

		const applySelectionHighlight = node => {
			if (!node || !cy) {
				return;
			}
			cy.batch(() => {
				cy.elements().removeClass('selected connected highlighted dimmed');
				const neighborhood = node.closedNeighborhood();
				const connectedEdges = neighborhood.edges();
				const connectedNodes = neighborhood.nodes();
				const otherNodes = cy.nodes().not(connectedNodes);
				const otherEdges = cy.edges().not(connectedEdges);
				node.addClass('selected');
				connectedNodes.not(node).addClass('connected');
				connectedEdges.addClass('highlighted');
				otherNodes.addClass('dimmed');
				otherEdges.addClass('dimmed');
			});
			highlightedNodeId = node.id();
		};

		if (selectModeButton) {
			selectModeButton.addEventListener('click', () => {
				selectionMode = !selectionMode;
				clearSelectionHighlight(!selectionMode);
				updateSelectModeButton();
				send('REN_GRAPH_EVT', { type: 'selection-mode-changed', data: { enabled: selectionMode } });
			});
			updateSelectModeButton();
		}

	const renderLegend = payload => {
			if (!legendEl) {
				return;
			}
			legendEl.innerHTML = '';
			categoryState.clear();
			if (!payload || payload.mode !== 'architecture') {
				legendEl.classList.remove('visible');
				return;
			}
			legendEl.classList.add('visible');
			let hasContent = false;
		const metadata = payload && typeof payload.metadata === 'object' && payload.metadata !== null ? payload.metadata : {};
		const metadataCategoryCounts = metadata.categoryCounts && typeof metadata.categoryCounts === 'object' ? metadata.categoryCounts : {};
		const relationshipCounts = metadata.relationshipCounts && typeof metadata.relationshipCounts === 'object' ? metadata.relationshipCounts : {};
		const datasetEntries = Array.isArray(metadata.datasets) ? metadata.datasets : [];

			const heading = document.createElement('h3');
			heading.textContent = 'Architecture Layers';
			legendEl.appendChild(heading);

			const categories = new Map();
			(payload.nodes || []).forEach(node => {
				if (!node.category) {
					return;
				}
				categories.set(node.category, (categories.get(node.category) || 0) + 1);
			});

			if (categories.size) {
				const categorySection = document.createElement('div');
				categorySection.className = 'legend-section legend-categories';
				legendEl.appendChild(categorySection);

				for (const [category, count] of Array.from(categories.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
					const styleDef = CATEGORY_STYLES[category] || DEFAULT_CATEGORY_STYLE;
					const label = document.createElement('label');
					label.className = 'legend-category';
					const checkbox = document.createElement('input');
					checkbox.type = 'checkbox';
					checkbox.checked = categoryState.get(category) !== false;
					categoryState.set(category, checkbox.checked);
					checkbox.addEventListener('change', () => {
						categoryState.set(category, checkbox.checked);
						applyCategoryVisibility();
					});
					const swatch = document.createElement('span');
					swatch.className = 'legend-swatch';
					swatch.style.backgroundColor = styleDef.color;
					const text = document.createElement('span');
					text.textContent = titleCase(category) + ' (' + count + ')';
					label.appendChild(checkbox);
					label.appendChild(swatch);
					label.appendChild(text);
					categorySection.appendChild(label);
				}
				hasContent = true;
			}

		if (datasetEntries.length) {
			const datasetSection = document.createElement('div');
			datasetSection.className = 'legend-section legend-datasets';
			const datasetHeading = document.createElement('h4');
			datasetHeading.textContent = 'Datasets';
			datasetSection.appendChild(datasetHeading);
			datasetEntries.slice(0, 5).forEach(entry => {
				const container = document.createElement('div');
				container.className = 'legend-dataset';
				const title = document.createElement('div');
				title.className = 'legend-dataset-title';
				title.textContent = entry.label || entry.id;
				container.appendChild(title);
				const details = entry.metadata || {};
				const metaLines = [];
				const fields = Array.isArray(details.fields) ? details.fields.map(field => {
					if (!field) {
						return '';
					}
					if (typeof field === 'string') {
						return field.trim();
					}
					const name = field.name || field.column || '';
					const type = field.type || field.datatype || field.kind || '';
					if (name && type) {
						return name + ': ' + type;
					}
					return name || type;
				}).filter(Boolean).slice(0, 4) : [];
				if (fields.length) {
					metaLines.push('Fields: ' + fields.join(', '));
				}
				const columns = !fields.length && Array.isArray(details.columns)
					? details.columns.map(column => (typeof column === 'string' ? column.replace(/[,\s]+$/, '') : '')).filter(Boolean).slice(0, 4)
					: [];
				if (columns.length) {
					metaLines.push('Columns: ' + columns.join(', '));
				}
				const queryEntries = Array.isArray(details.queries) ? details.queries : [];
				const queries = queryEntries.length;
				if (queries > 0) {
					metaLines.push('Queries: ' + queries);
					const sampleQuery = queryEntries[0];
					const snippet = sampleQuery && typeof sampleQuery.snippet === 'string' ? sampleQuery.snippet.replace(/\s+/g, ' ').trim() : '';
					if (snippet) {
						metaLines.push('Sample: ' + truncate(snippet, 80));
					}
				}
				if (typeof details.schemaFile === 'string') {
					metaLines.push('Schema: ' + basename(details.schemaFile));
				}
				if (metaLines.length) {
					const meta = document.createElement('div');
					meta.className = 'legend-dataset-meta';
					meta.textContent = metaLines.join(' • ');
					container.appendChild(meta);
				}
				datasetSection.appendChild(container);
			});
			legendEl.appendChild(datasetSection);
			hasContent = true;
		}

		const relationshipEntries = Object.entries(relationshipCounts).filter(([, value]) => Number(value) > 0);
		if (relationshipEntries.length) {
			const relationshipSection = document.createElement('div');
			relationshipSection.className = 'legend-section legend-relationships';
			const relHeading = document.createElement('h4');
			relHeading.textContent = 'Data Flows';
			relationshipSection.appendChild(relHeading);
			relationshipEntries.slice(0, 6).forEach(([relationship, value]) => {
				const countValue = Number(value);
				const item = document.createElement('div');
				item.className = 'legend-relationships-item';
				item.textContent = titleCase(relationship) + ': ' + countValue;
				relationshipSection.appendChild(item);
			});
			legendEl.appendChild(relationshipSection);
			hasContent = true;
		}

			const renderList = (items, className, title) => {
				if (!Array.isArray(items) || !items.length) {
					return;
				}
				const container = document.createElement('div');
				container.className = 'legend-section ' + className;
				const headingEl = document.createElement('h4');
				headingEl.textContent = title;
				container.appendChild(headingEl);
				const list = document.createElement('ul');
				items.slice(0, 6).forEach(item => {
					const li = document.createElement('li');
					li.textContent = item;
					if (className === 'legend-warnings') {
						li.className = 'legend-warning';
					}
					list.appendChild(li);
				});
				container.appendChild(list);
				legendEl.appendChild(container);
				hasContent = true;
			};

		const summaryItems = Array.isArray(payload.summary) ? [...payload.summary] : [];
		const datasetCount = Number(metadataCategoryCounts.dataset ?? metadataCategoryCounts.Dataset ?? 0);
		if (datasetCount > 0) {
			summaryItems.unshift('Detected ' + datasetCount + ' ' + pluralize(datasetCount, 'dataset'));
		}
		const queryCount = Number(relationshipCounts.queries ?? 0);
		if (queryCount > 0) {
			summaryItems.unshift('Observed ' + queryCount + ' data ' + pluralize(queryCount, 'flow'));
		}
		renderList(summaryItems, 'legend-summary', 'Highlights');
			renderList(payload.warnings, 'legend-warnings', 'Warnings');

			if (!hasContent) {
				legendEl.classList.remove('visible');
				legendEl.innerHTML = '';
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
							'label': 'data(displayLabel)',
							'font-size': 12,
							'font-weight': 600,
							'color': '#0B1A2B',
							'text-wrap': 'wrap',
							'text-max-width': 200,
							'text-valign': 'center',
							'text-halign': 'center',
							'width': 'data(visualSize)',
							'height': 'data(visualSize)'
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
						{ selector: 'node.category-frontend', style: {
							'background-color': '#29B6F6',
							'border-color': '#01579B',
							'color': '#052136'
						}},
						{ selector: 'node.category-backend', style: {
							'background-color': '#81C784',
							'border-color': '#1B5E20',
							'color': '#0B1A2B'
						}},
						{ selector: 'node.category-database', style: {
							'background-color': '#FF8A65',
							'border-color': '#D84315',
							'color': '#3E2723'
						}},
						{ selector: 'node.category-cache', style: {
							'background-color': '#F06292',
							'border-color': '#AD1457',
							'color': '#460A2D'
						}},
				{ selector: 'node.category-dataset', style: {
					'background-color': '#4DD0E1',
					'border-color': '#00796B',
					'color': '#00332F',
					'shape': 'round-rectangle'
				}},
						{ selector: 'node.category-queue', style: {
							'background-color': '#CE93D8',
							'border-color': '#6A1B9A',
							'color': '#1E0F2B'
						}},
						{ selector: 'node.category-messagebus', style: {
							'background-color': '#9575CD',
							'border-color': '#4527A0',
							'color': '#1E0F2B'
						}},
						{ selector: 'node.category-externalservice', style: {
							'background-color': '#B39DDB',
							'border-color': '#5E35B1',
							'color': '#1E0F2B'
						}},
						{ selector: 'node.category-infrastructure', style: {
							'background-color': '#90A4AE',
							'border-color': '#455A64',
							'color': '#11181D'
						}},
						{ selector: 'node.category-supportingservice', style: {
							'background-color': '#A5D6A7',
							'border-color': '#2E7D32',
							'color': '#0B1A2B'
						}},
						{ selector: 'node.category-configuration', style: {
							'background-color': '#C5E1A5',
							'border-color': '#558B2F',
							'color': '#1B310C'
						}},
						{ selector: 'node.category-unknown', style: {
							'background-color': '#B0BEC5',
							'border-color': '#455A64',
							'color': '#102027'
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
				{ selector: 'edge.relationship-queries', style: {
					'line-style': 'dotted',
					'line-color': '#4DD0E1',
					'target-arrow-color': '#4DD0E1',
					'color': '#B2EBF2'
				}},
						{ selector: 'edge.sideEffect', style: {
							'line-style': 'dashed',
							'line-color': '#FFCC80',
							'target-arrow-color': '#FFCC80',
							'color': '#FFECB3'
						}}
				,
				{ selector: 'node.selected', style: {
					'border-color': '#FFEB3B',
					'border-width': 4,
					'background-color': '#FFD54F',
					'color': '#1B1300',
					'opacity': 1
				}},
				{ selector: 'node.connected', style: {
					'border-color': '#FFF176',
					'border-width': 3,
					'opacity': 1
				}},
				{ selector: 'edge.highlighted', style: {
					'line-color': '#FFEB3B',
					'target-arrow-color': '#FFEB3B',
					'width': 3,
					'opacity': 1,
					'text-opacity': 1,
					'text-background-opacity': 1
				}},
				{ selector: 'node.dimmed', style: {
					'opacity': 0.15,
					'color': 'rgba(255, 255, 255, 0.35)'
				}},
				{ selector: 'edge.dimmed', style: {
					'opacity': 0.1,
					'text-opacity': 0.1
				}}
					],
					wheelSensitivity: 0.2,
					minZoom: 0.1,
					maxZoom: 5
				});

				cy.on('tap', 'node', evt => {
					if (selectionMode) {
						const node = evt.target;
						if (highlightedNodeId === node.id()) {
							clearSelectionHighlight(true);
						} else {
							applySelectionHighlight(node);
							send('REN_GRAPH_EVT', { type: 'selection-node', data: node.data() });
						}
						return;
					}
					send('REN_GRAPH_EVT', { type: 'node-tap', data: evt.target.data() });
				});
				cy.on('tap', 'edge', evt => {
					if (selectionMode) {
						return;
					}
					send('REN_GRAPH_EVT', { type: 'edge-tap', data: evt.target.data() });
				});
				cy.on('tap', evt => {
					if (!selectionMode) {
						return;
					}
					if (evt.target === cy) {
						clearSelectionHighlight(true);
					}
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
				clearSelectionHighlight();
				cy.stop();
				cy.elements().remove();
				const selectButton = document.getElementById('selectFile');
				if (selectButton) {
					if (payload.mode === 'architecture') {
						selectButton.textContent = 'Refresh Analysis';
						selectButton.title = 'Re-run architecture detection';
					} else {
						selectButton.textContent = 'Select Target...';
						selectButton.title = 'Select a target to visualize';
					}
				}
				const buildDisplayLabel = (node, mode) => {
					const fanIn = node.fanIn !== undefined ? node.fanIn : 0;
					const fanOut = node.fanOut !== undefined ? node.fanOut : 0;
					let label = node.label;
					if (mode === 'architecture' && typeof node.confidence === 'number' && !Number.isNaN(node.confidence)) {
						label += ' · ' + Math.round(node.confidence * 100) + '%';
					}
					if (fanIn === 0 && fanOut === 0) {
						return label;
					}
					return label + ' (in ' + fanIn + ' · out ' + fanOut + ')';
				};

			const nodePayloads = payload.nodes || [];
			const weights = nodePayloads.map(node => Math.max(1, node.weight !== undefined ? node.weight : 1));
			const maxWeight = weights.length ? Math.max(...weights) : 1;
			const minWeight = weights.length ? Math.min(...weights) : 1;
			const computeSize = weightValue => {
				const weight = Math.max(1, weightValue || 1);
				if (maxWeight === minWeight) {
					return 90;
				}
				const normalized = (weight - minWeight) / (maxWeight - minWeight);
				return 70 + normalized * 120;
			};

			const nodes = nodePayloads.map(node => {
				const weightValue = node.weight !== undefined ? node.weight : 1;
				const weight = Math.max(1, weightValue);
				const displayLabel = buildDisplayLabel(node, payload.mode);
				const classNames = new Set();
				if (node.kind) {
					classNames.add(node.kind);
				}
				if (payload.mode === 'architecture') {
					classNames.add('architecture');
					if (node.category) {
						classNames.add('category-' + normalizeCategory(node.category));
					}
				}
				return {
					group: 'nodes',
					data: {
						id: node.id,
						label: node.label,
						displayLabel,
						path: node.path,
						kind: node.kind,
						weight,
						fanIn: node.fanIn !== undefined ? node.fanIn : 0,
						fanOut: node.fanOut !== undefined ? node.fanOut : 0,
						visualSize: computeSize(weight),
						openable: node.openable !== undefined ? node.openable : true,
						category: node.category ?? null,
						confidence: node.confidence ?? null,
						tags: node.tags ?? [],
						metadata: node.metadata ?? {},
						description: node.description ?? '',
						evidence: node.evidence ?? []
					},
					classes: Array.from(classNames).join(' ')
				};
			});

			const edges = (payload.edges || []).map(edge => {
				const classNames = new Set();
				if (edge.kind) {
					classNames.add(edge.kind);
				}
				if (payload.mode === 'architecture' && edge.category) {
					classNames.add('relationship-' + normalizeCategory(edge.category));
				}
				return {
					group: 'edges',
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						label: edge.label,
						specifier: edge.specifier,
						sourcePath: edge.sourcePath,
						targetPath: edge.targetPath,
						symbols: edge.symbols ?? [],
						category: edge.category ?? null,
						confidence: edge.confidence ?? null,
						metadata: edge.metadata ?? {},
						evidence: edge.evidence ?? []
					},
					classes: Array.from(classNames).join(' ')
				};
			});

				cy.add([...nodes, ...edges]);
				cy.resize();
				renderLegend(payload);
				applyCategoryVisibility();

				const rootIds = nodes.filter(n => n.classes === 'root').map(n => n.data.id);
				const layoutName = payload.mode === 'architecture' ? 'cose' : (nodes.length > 14 ? 'cose' : 'breadthfirst');
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

