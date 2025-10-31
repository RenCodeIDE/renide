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

			#heatmapToolbar {
				position: absolute;
				top: 12px;
				right: 12px;
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 8px 10px;
				border-radius: 8px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
				z-index: 5;
				font-size: 12px;
			}

			#heatmapToolbar .toolbar-field {
				display: flex;
				align-items: center;
				gap: 4px;
				color: var(--vscode-editorWidget-foreground, #ffffff);
			}

			#heatmapToolbar .toolbar-select {
				background: var(--vscode-dropdown-background, #2d2d30);
				color: var(--vscode-dropdown-foreground, #ffffff);
				border: 1px solid var(--vscode-dropdown-border, rgba(255,255,255,0.2));
				border-radius: 4px;
				padding: 2px 6px;
				font-size: 12px;
				cursor: pointer;
			}

			#heatmapToolbar .toolbar-select:hover {
				background: var(--vscode-dropdown-listBackground, #3c3c40);
			}

			#heatmapToolbar button {
				background: var(--vscode-button-background, #0e639c);
				color: var(--vscode-button-foreground, #ffffff);
				border: 1px solid var(--vscode-button-border, transparent);
				border-radius: 4px;
				padding: 4px 10px;
				font-size: 12px;
				cursor: pointer;
				line-height: 1.4;
			}

			#heatmapToolbar button:hover {
				background: var(--vscode-button-hoverBackground, #1177bb);
			}

			#heatmapToolbar .toolbar-icon-button {
				width: 24px;
				height: 24px;
				min-width: 24px;
				padding: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				font-weight: 600;
				border-radius: 4px;
				background: transparent;
				border: 1px solid transparent;
			}

			#heatmapToolbar .toolbar-icon-button:hover {
				background: var(--vscode-button-hoverBackground, rgba(60, 60, 64, 0.5));
				border-color: var(--vscode-button-border, rgba(255, 255, 255, 0.2));
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

			#heatmapInfoModal {
				position: fixed;
				top: 50%;
				left: 50%;
				transform: translate(-50%, -50%);
				max-width: 500px;
				max-height: 80vh;
				padding: 16px 20px;
				border-radius: 8px;
				background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.95));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.08));
				color: var(--vscode-editorWidget-foreground, #ffffff);
				font-size: 12px;
				line-height: 1.5;
				z-index: 100;
				box-shadow: 0 4px 16px rgba(0,0,0,0.4);
				display: none;
				overflow-y: auto;
			}

			#heatmapInfoModal.visible {
				display: block;
			}

			#heatmapInfoModal h4 {
				margin: 0 0 12px;
				font-size: 14px;
				font-weight: 600;
			}

			#heatmapInfoModal .modal-close {
				position: absolute;
				top: 8px;
				right: 8px;
				width: 20px;
				height: 20px;
				border: none;
				background: transparent;
				color: var(--vscode-editorWidget-foreground, #ffffff);
				cursor: pointer;
				font-size: 16px;
				display: flex;
				align-items: center;
				justify-content: center;
				border-radius: 4px;
			}

			#heatmapInfoModal .modal-close:hover {
				background: var(--vscode-button-hoverBackground, #3c3c40);
			}

			#heatmapInfoModal .modal-content {
				padding-right: 24px;
			}

			#heatmapModalOverlay {
				position: fixed;
				top: 0;
				left: 0;
				right: 0;
				bottom: 0;
				background: rgba(0, 0, 0, 0.4);
				z-index: 99;
				display: none;
			}

			#heatmapModalOverlay.visible {
				display: block;
			}

		#sizingControl {
			position: absolute;
			top: 60px;
			right: 12px;
			max-width: 200px;
			padding: 10px 12px;
			border-radius: 8px;
			background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.8));
			border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
			box-shadow: 0 2px 8px rgba(0,0,0,0.25);
			font-size: 12px;
			color: var(--vscode-editorWidget-foreground, #ffffff);
			z-index: 5;
		}

		#sizingControl h3 {
			margin: 0 0 8px;
			font-size: 11px;
			font-weight: normal;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}

		#sizingControl .sizing-options {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		#sizingControl .sizing-option {
			display: flex;
			align-items: center;
			gap: 6px;
			cursor: pointer;
			padding: 4px 0;
		}

		#sizingControl .sizing-option input[type="radio"] {
			margin: 0;
			accent-color: var(--vscode-charts-foreground, #4FC3F7);
			cursor: pointer;
		}

		#sizingControl .sizing-option span {
			cursor: pointer;
			user-select: none;
		}
		</style>
	</head>
	<body>
		<div id="cy" role="presentation" aria-hidden="true"></div>
		<div id="legend" aria-live="polite" aria-label="Architecture legend"></div>
		<div id="heatmapModalOverlay"></div>
		<div id="heatmapInfoModal" aria-label="Heatmap information">
			<button class="modal-close" aria-label="Close">×</button>
			<div class="modal-content" id="heatmapInfoContent"></div>
		</div>
		<div id="sizingControl" aria-label="Node sizing control">
			<h3>Node Size</h3>
			<div class="sizing-options">
				<label class="sizing-option">
					<input type="radio" name="sizingMode" value="exports" checked>
					<span>By Exports</span>
				</label>
				<label class="sizing-option">
					<input type="radio" name="sizingMode" value="imports">
					<span>By Imports</span>
				</label>
			</div>
		</div>
		<div id="toolbar" aria-label="Graph controls">
			<button id="selectFile" title="Select a target to visualize">Select Target...</button>
			<button id="toggleSelectMode" title="Highlight a node and its connections">Select Nodes</button>
			<button id="zoomIn" title="Zoom in">+</button>
			<button id="zoomOut" title="Zoom out">-</button>
		</div>
		<div id="heatmapToolbar" aria-label="Heatmap controls" style="display: none;">
			<label class="toolbar-field">
				View:
				<select id="heatmapModeSelect" class="toolbar-select">
					<option value="file">File</option>
					<option value="folder">Folder</option>
					<option value="workspace">Workspace</option>
					<option value="architecture">Architecture</option>
					<option value="gitHeatmap" selected>Git Heatmap</option>
				</select>
			</label>
			<button id="heatmapRefresh" class="toolbar-icon-button" title="Rebuild module co-change heatmap from Git history" aria-label="Refresh heatmap">${String.fromCharCode(8635)}</button>
			<label class="toolbar-field">
				Granularity:
				<select id="heatmapGranularity" class="toolbar-select">
					<option value="topLevel">Top folders</option>
					<option value="twoLevel">Folder · Subfolder</option>
					<option value="file">Individual files</option>
				</select>
			</label>
			<label class="toolbar-field">
				Window:
				<select id="heatmapWindow" class="toolbar-select">
					<option value="60">60 days</option>
					<option value="90">90 days</option>
					<option value="120" selected>120 days</option>
					<option value="180">180 days</option>
				</select>
			</label>
			<button id="heatmapToolbarInfo" class="toolbar-icon-button" title="Show heatmap information" aria-label="Heatmap information" style="display: none;">i</button>
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
	const heatmapInfoModal = document.getElementById('heatmapInfoModal');
	const heatmapInfoContent = document.getElementById('heatmapInfoContent');
	const heatmapModalOverlay = document.getElementById('heatmapModalOverlay');
	const selectModeButton = document.getElementById('toggleSelectMode');
	const toolbar = document.getElementById('toolbar');
	const sizingControl = document.getElementById('sizingControl');
	const heatmapToolbar = document.getElementById('heatmapToolbar');
	const heatmapModeSelect = document.getElementById('heatmapModeSelect');
	const heatmapRefresh = document.getElementById('heatmapRefresh');
	const heatmapGranularity = document.getElementById('heatmapGranularity');
	const heatmapWindow = document.getElementById('heatmapWindow');
	const heatmapToolbarInfo = document.getElementById('heatmapToolbarInfo');
	let heatmapSummaryContent = '';
	let selectionMode = false;
	let highlightedNodeId = null;
	let heatmapMode = false;
	let heatmapSelection = null;
	let sizingMode = 'exports';
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
					cy.elements().removeClass('selected connected highlighted dimmed incoming outgoing');
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
			const nodeId = node.id();
			cy.batch(() => {
				cy.elements().removeClass('selected connected highlighted dimmed incoming outgoing');
				const neighborhood = node.closedNeighborhood();
				const connectedEdges = neighborhood.edges();
				const connectedNodes = neighborhood.nodes();
				const otherNodes = cy.nodes().not(connectedNodes);
				const otherEdges = cy.edges().not(connectedEdges);
				node.addClass('selected');
				connectedNodes.not(node).addClass('connected');
				// Distinguish incoming vs outgoing edges
				connectedEdges.forEach(edge => {
					edge.addClass('highlighted');
					if (edge.source().id() === nodeId) {
						edge.addClass('outgoing');
					} else if (edge.target().id() === nodeId) {
						edge.addClass('incoming');
					}
				});
				otherNodes.addClass('dimmed');
				otherEdges.addClass('dimmed');
			});
			highlightedNodeId = nodeId;
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

			const setHeatmapSummary = heatmap => {
				if (!heatmap) {
					if (heatmapToolbarInfo) {
						heatmapToolbarInfo.style.display = 'none';
					}
					heatmapSummaryContent = '';
					return;
				}
				const parts = [];
				if (typeof heatmap.description === 'string' && heatmap.description.trim()) {
					parts.push(heatmap.description.trim());
				}
				if (Array.isArray(heatmap.summary) && heatmap.summary.length) {
					parts.push(...heatmap.summary);
				}
				if (typeof heatmap.normalization === 'string' && heatmap.normalization.trim()) {
					parts.push(heatmap.normalization.trim());
				}
				heatmapSummaryContent = parts.join(' • ');
				if (heatmapToolbarInfo && heatmapSummaryContent) {
					heatmapToolbarInfo.style.display = 'flex';
				}
			};

			const showHeatmapInfoModal = () => {
				if (heatmapInfoModal && heatmapInfoContent && heatmapModalOverlay) {
					heatmapInfoContent.textContent = heatmapSummaryContent;
					heatmapInfoModal.classList.add('visible');
					heatmapModalOverlay.classList.add('visible');
				}
			};

			const hideHeatmapInfoModal = () => {
				if (heatmapInfoModal && heatmapModalOverlay) {
					heatmapInfoModal.classList.remove('visible');
					heatmapModalOverlay.classList.remove('visible');
				}
			};

			if (heatmapModalOverlay) {
				heatmapModalOverlay.addEventListener('click', () => {
					hideHeatmapInfoModal();
				});
			}

			const modalClose = document.querySelector('#heatmapInfoModal .modal-close');
			if (modalClose) {
				modalClose.addEventListener('click', () => {
					hideHeatmapInfoModal();
				});
			}

			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && heatmapInfoModal && heatmapInfoModal.classList.contains('visible')) {
					hideHeatmapInfoModal();
				}
			});

			if (heatmapModeSelect) {
				heatmapModeSelect.addEventListener('change', () => {
					const mode = heatmapModeSelect.value;
					send('REN_GRAPH_EVT', { type: 'heatmap-mode-change', data: { mode } });
				});
			}

			if (heatmapRefresh) {
				heatmapRefresh.addEventListener('click', () => {
					send('REN_GRAPH_EVT', { type: 'heatmap-refresh' });
				});
			}

			if (heatmapGranularity) {
				heatmapGranularity.addEventListener('change', () => {
					const granularity = heatmapGranularity.value;
					send('REN_GRAPH_EVT', { type: 'heatmap-granularity-change', data: { granularity } });
				});
			}

			if (heatmapWindow) {
				heatmapWindow.addEventListener('change', () => {
					const windowDays = parseInt(heatmapWindow.value, 10);
					if (!Number.isNaN(windowDays) && windowDays > 0) {
						send('REN_GRAPH_EVT', { type: 'heatmap-window-change', data: { windowDays } });
					}
				});
			}

			if (heatmapToolbarInfo) {
				heatmapToolbarInfo.addEventListener('click', () => {
					showHeatmapInfoModal();
				});
			}

			const computeHeatmapColor = (value, scale) => {
				const min = scale && typeof scale.min === 'number' ? scale.min : 0;
				const max = scale && typeof scale.max === 'number' ? scale.max : 0;
				if (!Number.isFinite(value) || value <= 0 || max <= 0 || min === max) {
					return 'rgba(52, 52, 58, 0.35)';
				}
				const clamped = Math.max(0, Math.min(1, (value - min) / Math.max(max - min, 1e-6)));
				const base = [40, 42, 52];
				const mid = [239, 108, 0];
				const peak = [255, 214, 102];
				const mix = (a, b, t) => Math.round(a + (b - a) * t);
				const pivot = 0.65;
				let rgb;
				if (clamped <= pivot) {
					const t = clamped / pivot;
					rgb = [mix(base[0], mid[0], t), mix(base[1], mid[1], t), mix(base[2], mid[2], t)];
				} else {
					const t = (clamped - pivot) / (1 - pivot);
					rgb = [mix(mid[0], peak[0], t), mix(mid[1], peak[1], t), mix(mid[2], peak[2], t)];
				}
				return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
			};

			const clearHeatmapState = notify => {
				heatmapSelection = null;
				if (cy) {
					cy.batch(() => {
						cy.nodes('.heatmap-cell').removeClass('highlight dimmed');
						cy.nodes('.heatmap-label').removeClass('highlight');
					});
				}
				if (notify) {
					send('REN_GRAPH_EVT', { type: 'heatmap-selection-cleared' });
				}
			};

			const applyHeatmapSelection = node => {
				if (!node || !cy) {
					return;
				}
				const row = node.data('row');
				const column = node.data('column');
				heatmapSelection = node;
				cy.batch(() => {
					cy.nodes('.heatmap-cell').forEach(cell => {
						if (cell.id() === node.id()) {
							cell.removeClass('dimmed');
							cell.addClass('highlight');
							return;
						}
						const sameLine = cell.data('row') === row || cell.data('column') === column;
						cell.toggleClass('dimmed', !sameLine);
						cell.removeClass('highlight');
					});
					cy.nodes('.heatmap-label').forEach(label => {
						const index = label.data('index');
						if (label.hasClass('row')) {
							label.toggleClass('highlight', index === row);
						} else {
							label.toggleClass('highlight', index === column);
						}
					});
				});
			};

			const updateControlVisibility = () => {
				if (heatmapMode) {
					if (toolbar) toolbar.style.display = 'none';
					if (sizingControl) sizingControl.style.display = 'none';
					if (heatmapToolbar) heatmapToolbar.style.display = 'flex';
				} else {
					if (toolbar) toolbar.style.display = 'flex';
					if (sizingControl) sizingControl.style.display = '';
					if (heatmapToolbar) heatmapToolbar.style.display = 'none';
				}
			};

			const renderHeatmap = heatmap => {
				ensureCy();
				heatmapMode = true;
				selectionMode = false;
				updateSelectModeButton();
				clearSelectionHighlight(false);
				if (selectModeButton) {
					selectModeButton.disabled = true;
				}
				if (heatmap) {
					if (heatmap.granularity && heatmapGranularity) {
						heatmapGranularity.value = heatmap.granularity;
					}
					if (heatmap.windowDays && heatmapWindow) {
						heatmapWindow.value = String(heatmap.windowDays);
					}
				}
				updateControlVisibility();
				setHeatmapSummary(heatmap);
				if (legendEl) {
					legendEl.classList.remove('visible');
					legendEl.innerHTML = '';
				}
				cy.stop();
				cy.elements().remove();
				const modules = Array.isArray(heatmap?.modules) ? heatmap.modules : [];
				if (!modules.length) {
					cy.reset();
					return;
				}
				const spacing = modules.length > 60 ? 26 : 34;
				const cellSize = Math.max(18, spacing - 6);
				cy.style()
					.selector('node.heatmap-cell')
					.style('width', cellSize)
					.style('height', cellSize)
					.update();
				const startX = 140;
				const startY = 140;
				const labelGap = 70;
				const mirror = new Map();
				for (const cell of Array.isArray(heatmap.cells) ? heatmap.cells : []) {
					if (typeof cell.row !== 'number' || typeof cell.column !== 'number') {
						continue;
					}
					const normalized = typeof cell.normalizedWeight === 'number' ? cell.normalizedWeight : (typeof cell.normalized === 'number' ? cell.normalized : 0);
					const pack = {
						normalized,
						weight: typeof cell.weight === 'number' ? cell.weight : 0,
						commitCount: typeof cell.commitCount === 'number' ? cell.commitCount : 0,
						commits: Array.isArray(cell.commits) ? cell.commits : []
					};
					mirror.set(cell.row + ':' + cell.column, pack);
					if (cell.row !== cell.column) {
						mirror.set(cell.column + ':' + cell.row, pack);
					}
				}
				const elements = [];
				modules.forEach((name, index) => {
					elements.push({
						data: { id: 'heatmap-row-' + index, label: name, index, type: 'row' },
						classes: 'heatmap-label row',
						position: { x: startX - labelGap, y: startY + index * spacing }
					});
					elements.push({
						data: { id: 'heatmap-column-' + index, label: name, index, type: 'column' },
						classes: 'heatmap-label column',
						position: { x: startX + index * spacing, y: startY - labelGap }
					});
				});
				for (let row = 0; row < modules.length; row++) {
					for (let column = 0; column < modules.length; column++) {
						const key = row + ':' + column;
						const entry = mirror.get(key);
						const normalized = entry?.normalized ?? 0;
						const color = computeHeatmapColor(normalized, heatmap.colorScale ?? {});
						elements.push({
							data: {
								id: 'heatmap-cell-' + row + '-' + column,
								row,
								column,
								normalized,
								normalizedWeight: normalized,
								weight: entry?.weight ?? 0,
								commitCount: entry?.commitCount ?? 0,
								commits: entry?.commits ?? [],
								color
							},
							classes: 'heatmap-cell',
							position: { x: startX + column * spacing, y: startY + row * spacing }
						});
					}
				}
				cy.add(elements);
				cy.style().selector('node.heatmap-cell').style('background-color', 'data(color)').update();
				cy.layout({ name: 'preset' }).run();
				cy.fit(cy.elements(), 80);
				clearHeatmapState(false);
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
							'color': '#ffffff',
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
							'color': '#ffffff'
						}},
						{ selector: 'node.external', style: {
							'background-color': '#AB47BC',
							'border-color': '#6A1B9A',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-frontend', style: {
							'background-color': '#29B6F6',
							'border-color': '#01579B',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-backend', style: {
							'background-color': '#81C784',
							'border-color': '#1B5E20',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-database', style: {
							'background-color': '#FF8A65',
							'border-color': '#D84315',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-cache', style: {
							'background-color': '#F06292',
							'border-color': '#AD1457',
							'color': '#ffffff'
						}},
				{ selector: 'node.category-dataset', style: {
					'background-color': '#4DD0E1',
					'border-color': '#00796B',
					'color': '#ffffff',
					'shape': 'round-rectangle'
				}},
						{ selector: 'node.category-queue', style: {
							'background-color': '#CE93D8',
							'border-color': '#6A1B9A',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-messagebus', style: {
							'background-color': '#9575CD',
							'border-color': '#4527A0',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-externalservice', style: {
							'background-color': '#B39DDB',
							'border-color': '#5E35B1',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-infrastructure', style: {
							'background-color': '#90A4AE',
							'border-color': '#455A64',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-supportingservice', style: {
							'background-color': '#A5D6A7',
							'border-color': '#2E7D32',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-configuration', style: {
							'background-color': '#C5E1A5',
							'border-color': '#558B2F',
							'color': '#ffffff'
						}},
						{ selector: 'node.category-unknown', style: {
							'background-color': '#B0BEC5',
							'border-color': '#455A64',
							'color': '#ffffff'
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
					'color': '#ffffff',
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
				{ selector: 'edge.highlighted.outgoing', style: {
					'line-color': '#81C784',
					'target-arrow-color': '#81C784',
					'line-style': 'solid',
					'width': 3,
					'opacity': 1
				}},
				{ selector: 'edge.highlighted.incoming', style: {
					'line-color': '#64B5F6',
					'target-arrow-color': '#64B5F6',
					'line-style': 'solid',
					'width': 3,
					'opacity': 1
				}},
				{ selector: 'node.dimmed', style: {
					'opacity': 0.15,
					'color': 'rgba(255, 255, 255, 0.35)'
				}},
				{ selector: 'edge.dimmed', style: {
					'opacity': 0.1,
					'text-opacity': 0.1
				}}
				,
				{ selector: 'node.heatmap-cell', style: {
					'width': 28,
					'height': 28,
					'shape': 'round-rectangle',
					'background-color': 'data(color)',
					'border-width': 1,
					'border-color': '#3d1f1f',
					'label': '',
					'opacity': 1
				}},
				{ selector: 'node.heatmap-cell.highlight', style: {
					'border-width': 2,
					'border-color': '#ffe082',
					'background-color': 'data(color)',
					'opacity': 1
				}},
				{ selector: 'node.heatmap-cell.dimmed', style: {
					'opacity': 0.12
				}},
				{ selector: 'node.heatmap-label', style: {
					'background-opacity': 0,
					'label': 'data(label)',
					'color': '#ECEFF1',
					'font-size': 11,
					'font-weight': 600,
					'text-halign': 'center',
					'text-valign': 'center',
					'width': 1,
					'height': 1
				}},
				{ selector: 'node.heatmap-label.highlight', style: {
					'color': '#FFE082'
				}},
				{ selector: 'node.heatmap-label.row', style: {
					'text-halign': 'right'
				}},
				{ selector: 'node.heatmap-label.column', style: {
					'text-valign': 'bottom',
					'text-rotation': '270deg'
				}}
					],
					wheelSensitivity: 0.2,
					minZoom: 0.1,
					maxZoom: 5
				});

				cy.on('tap', 'node', evt => {
					const node = evt.target;
					if (heatmapMode) {
						if (!node.hasClass('heatmap-cell')) {
							return;
						}
						if (heatmapSelection && heatmapSelection.id() === node.id()) {
							clearHeatmapState(true);
						} else {
							applyHeatmapSelection(node);
							send('REN_GRAPH_EVT', { type: 'heatmap-cell', data: node.data() });
						}
						return;
					}
					if (selectionMode) {
						if (highlightedNodeId === node.id()) {
							clearSelectionHighlight(true);
						} else {
							applySelectionHighlight(node);
							send('REN_GRAPH_EVT', { type: 'selection-node', data: node.data() });
						}
						return;
					}
					send('REN_GRAPH_EVT', { type: 'node-tap', data: node.data() });
				});
				cy.on('tap', 'edge', evt => {
					if (heatmapMode || selectionMode) {
						return;
					}
					send('REN_GRAPH_EVT', { type: 'edge-tap', data: evt.target.data() });
				});
				cy.on('tap', evt => {
					if (heatmapMode) {
						if (evt.target === cy) {
							clearHeatmapState(true);
						}
						return;
					}
					if (!selectionMode) {
						return;
					}
					if (evt.target === cy) {
						clearSelectionHighlight(true);
					}
				});
				cy.on('mouseover', 'node.heatmap-cell', evt => {
					if (!heatmapMode) {
						return;
					}
					send('REN_GRAPH_EVT', { type: 'heatmap-hover', data: evt.target.data() });
				});
				cy.on('mouseout', 'node.heatmap-cell', () => {
					if (!heatmapMode) {
						return;
					}
					send('REN_GRAPH_EVT', { type: 'heatmap-selection-cleared' });
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
				if (payload.mode === 'gitHeatmap' && payload.heatmap) {
					renderHeatmap(payload.heatmap);
					return;
				}
				heatmapMode = false;
				heatmapSelection = null;
				setHeatmapSummary(null);
				updateControlVisibility();
				if (selectModeButton) {
					selectModeButton.disabled = false;
				}
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
					let label = node.label;
					if (mode === 'architecture' && typeof node.confidence === 'number' && !Number.isNaN(node.confidence)) {
						label += ' · ' + Math.round(node.confidence * 100) + '%';
					}
					return label;
				};

			const nodePayloads = payload.nodes || [];
			const getSizingValue = node => {
				if (sizingMode === 'imports') {
					return Math.max(1, node.fanIn !== undefined ? node.fanIn : 1);
				} else {
					return Math.max(1, node.fanOut !== undefined ? node.fanOut : 1);
				}
			};
			const weights = nodePayloads.map(node => getSizingValue(node));
			const maxWeight = weights.length ? Math.max(...weights) : 1;
			const minWeight = weights.length ? Math.min(...weights) : 1;
			const computeSize = (node) => {
				const weight = getSizingValue(node);
				if (maxWeight === minWeight) {
					return 90;
				}
				const normalized = (weight - minWeight) / (maxWeight - minWeight);
				return 70 + normalized * 120;
			};

			const nodes = nodePayloads.map(node => {
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
						fanIn: node.fanIn !== undefined ? node.fanIn : 0,
						fanOut: node.fanOut !== undefined ? node.fanOut : 0,
						visualSize: computeSize(node),
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

			const updateNodeSizes = () => {
				if (!cy) {
					return;
				}
				const nodePayloads = cy.nodes().map(node => ({
					fanIn: node.data('fanIn') || 0,
					fanOut: node.data('fanOut') || 0
				}));
				if (nodePayloads.length === 0) {
					return;
				}
				const getSizingValue = node => {
					if (sizingMode === 'imports') {
						return Math.max(1, node.fanIn || 1);
					} else {
						return Math.max(1, node.fanOut || 1);
					}
				};
				const weights = nodePayloads.map(getSizingValue);
				const maxWeight = Math.max(...weights);
				const minWeight = Math.min(...weights);
				const computeSize = node => {
					const weight = getSizingValue(node);
					if (maxWeight === minWeight) {
						return 90;
					}
					const normalized = (weight - minWeight) / (maxWeight - minWeight);
					return 70 + normalized * 120;
				};
				cy.nodes().forEach(node => {
					const nodeData = {
						fanIn: node.data('fanIn') || 0,
						fanOut: node.data('fanOut') || 0
					};
					const newSize = computeSize(nodeData);
					node.style('width', newSize);
					node.style('height', newSize);
				});
				cy.resize();
			};

			const sizingControls = document.querySelectorAll('input[name="sizingMode"]');
			sizingControls.forEach(radio => {
				radio.addEventListener('change', (e) => {
					if (e.target.checked) {
						sizingMode = e.target.value;
						updateNodeSizes();
					}
				});
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

