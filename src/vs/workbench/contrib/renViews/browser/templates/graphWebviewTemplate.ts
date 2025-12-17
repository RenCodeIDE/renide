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
			background: var(--vscode-editorWidget-background, rgba(32, 32, 32, 0.9));
			border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
			box-shadow: 0 4px 12px rgba(0,0,0,0.3);
			font-size: 12px;
			color: var(--vscode-editorWidget-foreground, #ffffff);
			display: none;
			z-index: 100;
			pointer-events: auto;
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

		#legend .legend-folders {
			margin-top: 4px;
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		#legend .legend-folder-item {
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 11px;
		}

		#legend .legend-folder-item .legend-swatch {
			flex-shrink: 0;
		}

		#legend .legend-folder-name {
			color: rgba(255, 255, 255, 0.9);
			text-transform: capitalize;
		}

		#legend .legend-folder-count {
			color: rgba(255, 255, 255, 0.5);
			font-size: 10px;
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

		#sizingControl .filter-section {
			margin-top: 12px;
			padding-top: 10px;
			border-top: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.1));
		}

		#sizingControl .filter-option {
			display: flex;
			align-items: center;
			gap: 6px;
			cursor: pointer;
			padding: 4px 0;
		}

		#sizingControl .filter-option input[type="checkbox"] {
			margin: 0;
			accent-color: var(--vscode-charts-foreground, #4FC3F7);
			cursor: pointer;
		}

		#sizingControl .filter-option span {
			cursor: pointer;
			user-select: none;
		}

		#sizingControl .hint-text {
			margin-top: 12px;
			padding-top: 8px;
			border-top: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.06));
			font-size: 10px;
			color: rgba(255,255,255,0.5);
			font-style: italic;
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
		<div id="sizingControl" aria-label="Node sizing and filter controls">
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
				<div class="filter-section">
				<h3>Filter</h3>
				<label class="filter-option">
					<input type="checkbox" id="hideLibraries">
					<span>Hide Libraries</span>
				</label>
			</div>
			<div class="hint-text">Hover edges to see imports</div>
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
	let hideLibraries = false;
	const hideLibrariesCheckbox = document.getElementById('hideLibraries');
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

			// Hierarchical folder-based color palette - assigns colors based on folder depth and path
			const HIERARCHICAL_COLORS = {
				// Root level colors (depth 0)
				root: [
					'#4FC3F7',  // Light blue
					'#81C784',  // Green
					'#FFB74D',  // Orange
					'#BA68C8',  // Purple
					'#4DB6AC',  // Teal
					'#F06292',  // Pink
				],
				// Level 1 colors (depth 1)
				level1: [
					'#64B5F6',  // Blue
					'#AED581',  // Light green
					'#FF8A65',  // Coral
					'#9575CD',  // Deep purple
					'#4DD0E1',  // Cyan
					'#DCE775',  // Lime
					'#FFD54F',  // Amber
					'#A1887F',  // Brown
				],
				// Level 2+ colors (depth 2 and deeper)
				deep: [
					'#90A4AE',  // Grey
					'#F48FB1',  // Light pink
					'#CE93D8',  // Light purple
					'#B39DDB',  // Medium purple
					'#9FA8DA',  // Light blue-grey
					'#90CAF9',  // Light blue
					'#81C784',  // Light green
					'#A5D6A7',  // Very light green
					'#C8E6C9',  // Pale green
					'#DCEDC8',  // Very pale green
					'#F1F8E9',  // Almost white green
					'#FFF3E0',  // Pale orange
					'#FFE0B2',  // Light orange
					'#FFCC80',  // Medium orange
					'#FFB74D',  // Orange
				]
			};

			// Configuration for hierarchical coloring
			const COLOR_CONFIG = {
				maxDepth: 3,  // Maximum depth to consider for coloring (0 = root, 1 = level 1, etc.)
				usePathHash: true,  // Use path-based hashing for consistent colors within same folder path
			};

			const folderColorCache = new Map();

			// Reset folder color cache for consistent colors on each graph load
			const resetFolderColorCache = () => {
				folderColorCache.clear();
			};

			// Simple hash function for consistent color assignment based on path
			const hashString = (str) => {
				let hash = 0;
				for (let i = 0; i < str.length; i++) {
					const char = str.charCodeAt(i);
					hash = ((hash << 5) - hash) + char;
					hash = hash & hash; // Convert to 32-bit integer
				}
				return Math.abs(hash);
			};

			const getHierarchicalFolderColor = (path, depth) => {
				if (!path || typeof path !== 'string') {
					return HIERARCHICAL_COLORS.root[0];
				}

				// Clamp depth to configured maximum
				const clampedDepth = Math.min(depth, COLOR_CONFIG.maxDepth);

				// Get appropriate color palette for this depth
				let colorPalette;
				if (clampedDepth === 0) {
					colorPalette = HIERARCHICAL_COLORS.root;
				} else if (clampedDepth === 1) {
					colorPalette = HIERARCHICAL_COLORS.level1;
				} else {
					colorPalette = HIERARCHICAL_COLORS.deep;
				}

				// Use path-based hashing for consistent colors within same folder path
				if (COLOR_CONFIG.usePathHash) {
					const hash = hashString(path.toLowerCase());
					const colorIndex = hash % colorPalette.length;
					return colorPalette[colorIndex];
				} else {
					// Use sequential assignment (less consistent but more predictable)
					if (folderColorCache.has(path)) {
						return folderColorCache.get(path);
					}
					const colorIndex = folderColorCache.size % colorPalette.length;
					const color = colorPalette[colorIndex];
					folderColorCache.set(path, color);
					return color;
				}
			};

			const getFolderColor = (path) => {
				if (!path || typeof path !== 'string') {
					return HIERARCHICAL_COLORS.root[0];
				}

				// Handle file:// URIs - strip protocol and decode URL encoding
				let cleanPath = path;
				if (cleanPath.startsWith('file://')) {
					cleanPath = cleanPath.slice(7); // Remove 'file://'
				}
				try {
					cleanPath = decodeURIComponent(cleanPath);
				} catch (e) {
					// If decoding fails, use the path as-is
				}

				// Extract meaningful folder hierarchy from path
				const segments = cleanPath.replace(/^[\\/\\\\]+/, '').split(/[\\/\\\\]/);

				// Build folder path hierarchy, skipping common container folders
				const meaningfulSegments = [];
				let foundProjectRoot = false;

				for (let i = 0; i < segments.length; i++) {
					const seg = segments[i].toLowerCase();

					// Skip empty segments and common system containers
					if (!seg || seg === 'users' || seg === 'home' || seg === 'documents' ||
					    seg === 'dev work' || seg === 'web dev' || seg === 'devwork' ||
					    seg === 'projects' || seg === 'work' || seg === 'code') {
						continue;
					}

					// Skip segments that look like filenames (contain .)
					if (seg.includes('.')) {
						break; // Stop at filename
					}

					// Handle common project root folders - treat them as starting point
					if (!foundProjectRoot && (seg === 'src' || seg === 'app' || seg === 'lib' ||
					    seg === 'frontend' || seg === 'backend' || seg === 'common' ||
					    seg === 'packages' || seg === 'components' || seg === 'pages' ||
					    seg === 'routes' || seg === 'modules' || seg === 'features')) {
						foundProjectRoot = true;
						meaningfulSegments.length = 0; // Reset - start from project root
						continue;
					}

					// Add meaningful folder segments
					if (foundProjectRoot || meaningfulSegments.length === 0) {
						meaningfulSegments.push(seg);
					}
				}

				// If no meaningful segments found, use root color
				if (meaningfulSegments.length === 0) {
					return HIERARCHICAL_COLORS.root[0];
				}

				// Build hierarchical folder path for coloring
				const folderPath = meaningfulSegments.join('/');
				const depth = meaningfulSegments.length - 1; // Depth is 0-based

				return getHierarchicalFolderColor(folderPath, depth);
			};

			// Canonical layer order used for layout and edge routing
			const LAYER_ORDER = {
				// Frontend
				pages: 0,
				layouts: 1,
				features: 2,
				components: 3,
				hooks: 4,
				state: 5,
				'routing': 6,
				'api-client': 7,
				// Backend
				routes: 0,
				controllers: 1,
				services: 2,
				repositories: 3,
				models: 4,
				middleware: 5,
				infrastructure: 6,
				jobs: 7,
				// Shared
				shared: 10,
				config: 11,
				types: 12,
				external: 13,
				tests: 14
			};

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

	// Render hierarchical folder color legend for file/folder/workspace modes
	const renderFolderLegend = payload => {
			if (!legendEl) {
				return;
			}
			const folderModes = ['file', 'folder', 'workspace'];
			if (!payload || !folderModes.includes(payload.mode)) {
				return false;
			}

			// Build hierarchical folder structure from payload nodes
			const folderHierarchy = new Map(); // depth -> Map<path, count>
			const extractFolderHierarchy = (path) => {
				if (!path || typeof path !== 'string') return null;
				let cleanPath = path;
				if (cleanPath.startsWith('file://')) {
					cleanPath = cleanPath.slice(7);
				}
				try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}
				const segments = cleanPath.replace(/^[\\/\\\\]+/, '').split(/[\\/\\\\]/);

				// Build meaningful folder path, skipping common containers
				const meaningfulSegments = [];
				let foundProjectRoot = false;

				for (let i = 0; i < segments.length; i++) {
					const seg = segments[i].toLowerCase();

					// Skip empty segments and common system containers
					if (!seg || seg === 'users' || seg === 'home' || seg === 'documents' ||
					    seg === 'dev work' || seg === 'web dev' || seg === 'devwork' ||
					    seg === 'projects' || seg === 'work' || seg === 'code') {
						continue;
					}

					// Stop at filename
					if (seg.includes('.')) {
						break;
					}

					// Handle common project root folders
					if (!foundProjectRoot && (seg === 'src' || seg === 'app' || seg === 'lib' ||
					    seg === 'frontend' || seg === 'backend' || seg === 'common' ||
					    seg === 'packages' || seg === 'components' || seg === 'pages' ||
					    seg === 'routes' || seg === 'modules' || seg === 'features')) {
						foundProjectRoot = true;
						meaningfulSegments.length = 0; // Reset to project root
						continue;
					}

					// Add meaningful folder segments
					if (foundProjectRoot || meaningfulSegments.length === 0) {
						meaningfulSegments.push(seg);
					}
				}

				if (meaningfulSegments.length === 0) {
					// Root-level file (e.g. src/App.tsx) - treat as depth 0
					return {
						path: '(root)',
						depth: 0,
						displayPath: 'Root Files'
					};
				}

				return {
					path: meaningfulSegments.join('/'),
					depth: meaningfulSegments.length - 1,
					displayPath: meaningfulSegments.join(' / ')
				};
			};

			(payload.nodes || []).forEach(node => {
				if (!node.path || node.kind === 'external') return;
				const hierarchy = extractFolderHierarchy(node.path);
				if (!hierarchy) return;

				if (!folderHierarchy.has(hierarchy.depth)) {
					folderHierarchy.set(hierarchy.depth, new Map());
				}
				const depthMap = folderHierarchy.get(hierarchy.depth);
				depthMap.set(hierarchy.path, (depthMap.get(hierarchy.path) || 0) + 1);
			});

			// ALWAYS show the legend for file/folder/workspace modes, even if hierarchy is simple
			legendEl.innerHTML = '';
			legendEl.classList.add('visible');
			legendEl.style.display = 'block'; // Force display

			const heading = document.createElement('h3');
			heading.textContent = 'Folder Legend';
			legendEl.appendChild(heading);

			// Add color hint explaining the hierarchical color system
			const hint = document.createElement('div');
			hint.className = 'legend-color-hint';
			hint.style.fontSize = '10px';
			hint.style.color = 'rgba(255, 255, 255, 0.6)';
			hint.style.marginBottom = '8px';
			hint.style.lineHeight = '1.4';
			hint.innerHTML = 'Colors indicate folder depth:<br>' +
				'<span style="display:inline-block;width:8px;height:8px;background:#4FC3F7;border-radius:2px;margin-right:4px;"></span> Root Files<br>' +
				'<span style="display:inline-block;width:8px;height:8px;background:#81C784;border-radius:2px;margin-right:4px;"></span> Subfolders (Level 1)<br>' +
				'<span style="display:inline-block;width:8px;height:8px;background:#FFB74D;border-radius:2px;margin-right:4px;"></span> Deep Nested (Level 2+)';
			legendEl.appendChild(hint);

			// If no hierarchy detected, show a default "Root Only" message
			if (folderHierarchy.size === 0) {
				const item = document.createElement('div');
				item.className = 'legend-folder-item';
				item.style.fontStyle = 'italic';
				item.style.color = 'rgba(255,255,255,0.5)';
				item.textContent = 'All files are in the root scope';
				legendEl.appendChild(item);
				return true;
			}

			const folderSection = document.createElement('div');
			folderSection.className = 'legend-section legend-folders';

			// Sort depths and process each level
			const sortedDepths = Array.from(folderHierarchy.keys()).sort((a, b) => a - b);

			sortedDepths.forEach(depth => {
				const depthMap = folderHierarchy.get(depth);
				const depthLabel = depth === 0 ? 'Root Level' : 'Level ' + depth;
				const depthHeading = document.createElement('h4');
				depthHeading.textContent = depthLabel;
				depthHeading.style.marginTop = depth > 0 ? '12px' : '0';
				depthHeading.style.marginBottom = '6px';
				depthHeading.style.fontSize = '11px';
				depthHeading.style.fontWeight = '600';
				depthHeading.style.textTransform = 'uppercase';
				depthHeading.style.letterSpacing = '0.02em';
				folderSection.appendChild(depthHeading);

				// Sort folders by count descending, limit to top 8 per level
				const sortedFolders = Array.from(depthMap.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 8);

				sortedFolders.forEach(([folderPath, count]) => {
					// Handle root special case
					const isRoot = folderPath === '(root)';
					const displayPath = isRoot ? 'Root Files' : folderPath.split('/').pop();
					const color = isRoot ? HIERARCHICAL_COLORS.root[0] : getHierarchicalFolderColor(folderPath, depth);

					const item = document.createElement('div');
					item.className = 'legend-folder-item';

					const swatch = document.createElement('span');
					swatch.className = 'legend-swatch';
					swatch.style.backgroundColor = color;

					const name = document.createElement('span');
					name.className = 'legend-folder-name';
					name.textContent = displayPath;
					if (!isRoot) name.title = folderPath; // Full path on hover

					const countSpan = document.createElement('span');
					countSpan.className = 'legend-folder-count';
					countSpan.textContent = '(' + count + ')';

					item.appendChild(swatch);
					item.appendChild(name);
					item.appendChild(countSpan);
					folderSection.appendChild(item);
				});
			});

			legendEl.appendChild(folderSection);

			// Show external count if any
			const externalCount = (payload.nodes || []).filter(n => n.kind === 'external').length;
			if (externalCount > 0) {
				const extItem = document.createElement('div');
				extItem.className = 'legend-folder-item';
				extItem.style.marginTop = '12px';

				const swatch = document.createElement('span');
				swatch.className = 'legend-swatch';
				swatch.style.backgroundColor = '#AB47BC';

				const name = document.createElement('span');
				name.className = 'legend-folder-name';
				name.textContent = 'external';

				const countSpan = document.createElement('span');
				countSpan.className = 'legend-folder-count';
				countSpan.textContent = '(' + externalCount + ')';

				extItem.appendChild(swatch);
				extItem.appendChild(name);
				extItem.appendChild(countSpan);
				folderSection.appendChild(extItem);
			}

			return true;
		};

	const renderLegend = payload => {
			if (!legendEl) {
				return;
			}

			// Try folder legend first for file/folder/workspace modes
			if (renderFolderLegend(payload)) {
				return;
			}

			legendEl.innerHTML = '';
			categoryState.clear();
			const archModes = ['architecture', 'dataFlow', 'frontendArch', 'backendArch', 'fullstackArch', 'smartArch'];
			if (!payload || !archModes.includes(payload.mode)) {
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
				if (!cy) {
					return;
				}
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
							'background-color': 'data(folderColor)',
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
							// Apply size to all nodes - parent nodes will override this
							'width': 'data(visualSize)',
							'height': 'data(visualSize)'
						}},
						// Specific arch-* classes can override with their own sizing if needed
						{ selector: '.arch-page, .arch-layout, .arch-component, .arch-hook, .arch-context, .arch-store, .arch-utils, .arch-types, .arch-controller, .arch-service, .arch-repository, .arch-middleware, .arch-route', style: {
							'width': 'data(visualSize)',
							'height': 'data(visualSize)'
						}},
						{ selector: 'node.root-function', style: {
						'background-color': '#ff6b6b',
						'width': 50,
						'height': 50,
						'border-width': 3,
						'border-color': '#fff',
						'font-weight': 'bold'
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
						// Compound/Parent node styles (layer containers)
						// These are the horizontal boxes that contain component nodes
						{ selector: ':parent', style: {
							'background-color': 'data(bgColor)',
							'background-opacity': 0.15,
							'border-color': 'data(borderColor)',
							'border-width': 3,
							'border-style': 'solid',
							'border-opacity': 0.6,
							'shape': 'round-rectangle',
							'padding': 30,
							'text-valign': 'top',
							'text-halign': 'left',
							'text-margin-x': 15,
							'text-margin-y': 10,
							'font-size': 16,
							'font-weight': 'bold',
							'color': 'data(borderColor)',
							'text-background-color': 'rgba(0,0,0,0.7)',
							'text-background-opacity': 1,
							'text-background-padding': '6px',
							'text-background-shape': 'roundrectangle',
							'min-width': 300,
							'min-height': 100
						}},
						// Group/container node styles (explicit group class)
						{ selector: 'node.group', style: {
							'background-color': 'data(bgColor)',
							'background-opacity': 0.2,
							'border-color': 'data(borderColor)',
							'border-width': 3,
							'border-style': 'solid',
							'shape': 'round-rectangle',
							'padding': 30
						}},
						// Layer-specific container styles
						{ selector: 'node.layer-pages', style: {
							'background-color': '#3B82F6',
							'border-color': '#1E40AF'
						}},
						{ selector: 'node.layer-layouts', style: {
							'background-color': '#8B5CF6',
							'border-color': '#5B21B6'
						}},
						{ selector: 'node.layer-components', style: {
							'background-color': '#10B981',
							'border-color': '#047857'
						}},
						{ selector: 'node.layer-hooks', style: {
							'background-color': '#F59E0B',
							'border-color': '#B45309'
						}},
						{ selector: 'node.layer-state', style: {
							'background-color': '#6366F1',
							'border-color': '#4338CA'
						}},
						{ selector: 'node.layer-api-client', style: {
							'background-color': '#14B8A6',
							'border-color': '#0D9488'
						}},
						{ selector: 'node.layer-routes', style: {
							'background-color': '#3B82F6',
							'border-color': '#1E40AF'
						}},
						{ selector: 'node.layer-controllers', style: {
							'background-color': '#0EA5E9',
							'border-color': '#0369A1'
						}},
						{ selector: 'node.layer-services', style: {
							'background-color': '#22C55E',
							'border-color': '#15803D'
						}},
						{ selector: 'node.layer-repositories', style: {
							'background-color': '#A855F7',
							'border-color': '#7E22CE'
						}},
						{ selector: 'node.layer-models', style: {
							'background-color': '#F97316',
							'border-color': '#C2410C'
						}},
						{ selector: 'node.layer-middleware', style: {
							'background-color': '#EF4444',
							'border-color': '#B91C1C'
						}},
						{ selector: 'node.layer-shared', style: {
							'background-color': '#6B7280',
							'border-color': '#374151'
						}},
						{ selector: 'node.layer-config', style: {
							'background-color': '#9CA3AF',
							'border-color': '#4B5563'
						}},
						{ selector: 'node.layer-types', style: {
							'background-color': '#D1D5DB',
							'border-color': '#6B7280'
						}},
						{ selector: 'node.layer-external', style: {
							'background-color': '#E5E7EB',
							'border-color': '#9CA3AF'
						}},
						// Frontend Architecture component type styles
						{ selector: 'node.arch-page', style: {
							'background-color': '#3B82F6',  // Blue
							'border-color': '#1E40AF',
							'border-width': 3,
							'shape': 'round-rectangle',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-layout', style: {
							'background-color': '#8B5CF6',  // Purple
							'border-color': '#5B21B6',
							'border-width': 3,
							'shape': 'round-rectangle',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-component', style: {
							'background-color': '#10B981',  // Green
							'border-color': '#047857',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-hook', style: {
							'background-color': '#F59E0B',  // Orange
							'border-color': '#B45309',
							'shape': 'diamond',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-context', style: {
							'background-color': '#EC4899',  // Pink
							'border-color': '#BE185D',
							'shape': 'hexagon',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-store', style: {
							'background-color': '#6366F1',  // Indigo
							'border-color': '#4338CA',
							'shape': 'octagon',
							'color': '#ffffff'
						}},
						// Backend Architecture type styles
						{ selector: 'node.arch-controller', style: {
							'background-color': '#0EA5E9',  // Sky
							'border-color': '#0369A1',
							'shape': 'round-rectangle',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-service', style: {
							'background-color': '#22C55E',  // Green
							'border-color': '#15803D',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-repository', style: {
							'background-color': '#A855F7',  // Purple
							'border-color': '#7E22CE',
							'shape': 'barrel',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-middleware', style: {
							'background-color': '#F97316',  // Orange
							'border-color': '#C2410C',
							'shape': 'rhomboid',
							'color': '#ffffff'
						}},
						{ selector: 'node.arch-route', style: {
							'background-color': '#14B8A6',  // Teal
							'border-color': '#0D9488',
							'color': '#ffffff'
						}},
						{ selector: 'edge', style: {
							'width': 2,
							'curve-style': 'bezier',
							'line-color': '#E0E0E0',
							'target-arrow-color': '#E0E0E0',
							'target-arrow-shape': 'triangle',
							'arrow-scale': 1.2,
							'label': '',
							'font-size': 12,
							'color': '#ffffff',
							'text-wrap': 'wrap',
							'text-max-width': 180,
							'text-background-color': 'rgba(0, 0, 0, 0.85)',
							'text-background-opacity': 1,
							'text-background-padding': '4px',
							'text-background-shape': 'roundrectangle'
						}},
						// Show label on edge hover - larger, more readable
						{ selector: 'edge.hovered', style: {
							'label': 'data(label)',
							'font-size': 14,
							'font-weight': 600,
							'width': 3,
							'line-color': '#4FC3F7',
							'target-arrow-color': '#4FC3F7',
							'text-background-color': 'rgba(30, 30, 35, 0.95)',
							'text-background-padding': '6px',
							'text-border-color': '#4FC3F7',
							'text-border-width': 1,
							'text-border-opacity': 0.8,
							'text-max-width': 250,
							'z-index': 999
						}},
						// Edges that cross layers are slightly stronger
						{ selector: 'edge.edge-cross-layer', style: {
							'width': 2.5,
							'opacity': 0.9
						}},
						// Intra-layer edges are de-emphasized
						{ selector: 'edge.edge-same-layer', style: {
							'opacity': 0.4
						}},
						// Directional endpoints for cross-layer edges (downwards)
						{ selector: 'edge.edge-dir-down', style: {
							'source-endpoint': '0.5 1.0',
							'target-endpoint': '0.5 0.0'
						}},
						// Directional endpoints for cross-layer edges (upwards)
						{ selector: 'edge.edge-dir-up', style: {
							'source-endpoint': '0.5 0.0',
							'target-endpoint': '0.5 1.0'
						}},
						// Type-specific edge styling for architecture views
						{ selector: 'edge.edge-type-imports', style: {
							'line-style': 'solid'
						}},
						{ selector: 'edge.edge-type-calls', style: {
							'width': 3,
							'line-color': '#81C784',
							'target-arrow-color': '#81C784'
						}},
						{ selector: 'edge.edge-type-uses-state', style: {
							'line-style': 'dashed',
							'line-color': '#FFB74D',
							'target-arrow-color': '#FFB74D'
						}},
						{ selector: 'edge.edge-type-fetches', style: {
							'line-style': 'dotted',
							'line-color': '#4DD0E1',
							'target-arrow-color': '#4DD0E1'
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
					console.error('[GraphWebview] applyGraph called with null/undefined payload');
					return;
				}
				try {
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
						const archModes = ['architecture', 'dataFlow', 'frontendArch', 'backendArch', 'fullstackArch', 'smartArch'];
						if (archModes.includes(payload.mode)) {
							selectButton.textContent = 'Refresh Analysis';
							selectButton.title = 'Re-run architecture detection';
						} else {
							selectButton.textContent = 'Select Target...';
							selectButton.title = 'Select a target to visualize';
						}
					}

					const buildDisplayLabel = (node, mode) => {
						// For architecture modes, use concise labels (filename without extension)
						const archModes = ['frontendArch', 'backendArch', 'fullstackArch', 'smartArch'];
						if (archModes.includes(mode)) {
							// Check for explicit conciseLabel in metadata
							if (node.metadata?.conciseLabel) {
								return node.metadata.conciseLabel;
							}
							// For group/container nodes, use the label as-is
							if (node.metadata?.isGroup) {
								return node.label;
							}
							// Extract concise name from file path or label
							let concise = node.label;
							// Remove file extension
							concise = concise.replace(/\\.[^.]+$/, '');
							// If label looks like a path, get just the filename
							if (concise.includes('/') || concise.includes('\\\\')) {
								const parts = concise.split(/[\\\\/]/);
								concise = parts[parts.length - 1];
							}
							// Handle index files - show parent folder name
							if (concise.toLowerCase() === 'index') {
								const pathParts = (node.path || node.label).split(/[\\\\/]/);
								if (pathParts.length >= 2) {
									concise = pathParts[pathParts.length - 2];
								}
							}
							return concise;
					}

					// Standard label handling for other modes
					let label = node.label;
					if (mode === 'architecture' && typeof node.confidence === 'number' && !Number.isNaN(node.confidence)) {
						label += ' · ' + Math.round(node.confidence * 100) + '%';
					}
					if (mode === 'dataFlow' && node.metadata?.isRoot) {
						label += ' (root)';
					}
					return label;
				};

					// Reset folder color cache for consistent colors
					resetFolderColorCache();

					const nodePayloads = payload.nodes || [];
					console.log('[GraphWebview] Processing graph:', { mode: payload.mode, nodeCount: nodePayloads.length, edgeCount: (payload.edges || []).length });

					// Build a map of nodeId -> layerId for edge routing
					const nodeLayerById = new Map();
					nodePayloads.forEach(node => {
						const layer = node.layer || node.category || node.metadata?.layer;
						if (layer) {
							nodeLayerById.set(node.id, layer);
						}
					});

					if (!nodePayloads || nodePayloads.length === 0) {
						console.warn('[GraphWebview] No nodes to render');
						updateStatus('No nodes to display.', 'warning');
						return;
					}

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

					let nodes;
					try {
						let debugCount = 0;
						nodes = nodePayloads.map(node => {
							const displayLabel = buildDisplayLabel(node, payload.mode);
							const classNames = new Set();
							if (node.kind) {
								classNames.add(node.kind);
							}
							// Handle regular architecture mode
							if (payload.mode === 'architecture') {
								classNames.add('architecture');
								if (node.category) {
									classNames.add('category-' + normalizeCategory(node.category));
								}
							}
							// Handle context-aware architecture modes
							const archModes = ['frontendArch', 'backendArch', 'fullstackArch', 'smartArch'];
							if (archModes.includes(payload.mode)) {
								classNames.add('architecture');
								// Use metadata.type for original ArchNodeType (page, component, etc.)
								// Fall back to node.kind if metadata.type is not available
								const archType = node.metadata?.type || node.kind;
								if (archType) {
									const archClass = 'arch-' + archType;
									classNames.add(archClass);
									// Debug: log first few nodes to verify classes
									if (debugCount < 3) {
										console.log('[GraphWebview] Node', node.id, 'archType:', archType, 'class:', archClass, 'metadata.type:', node.metadata?.type);
										debugCount++;
									}
								}
								// Also support layer-based styling
								if (node.layer || node.metadata?.layer) {
									classNames.add('layer-' + (node.layer || node.metadata.layer));
								}
							}
							if (payload.mode === 'dataFlow') {
								classNames.add('dataflow');
								if (node.metadata?.isRoot) {
									classNames.add('root-function');
								}
							}
							const computedSize = computeSize(node);
							const finalClasses = Array.from(classNames).concat(node.isGroup ? ['group'] : []).join(' ');
							const nodeData = {
								group: 'nodes',
								data: {
									id: node.id,
									label: node.label,
									displayLabel,
									path: node.path,
									kind: node.kind,
									parent: node.parent, // For Cytoscape compound nodes
									fanIn: node.fanIn !== undefined ? node.fanIn : 0,
									fanOut: node.fanOut !== undefined ? node.fanOut : 0,
									visualSize: computedSize,
									openable: node.openable !== undefined ? node.openable : true,
									category: node.category ?? null,
									confidence: node.confidence ?? null,
									tags: node.tags ?? [],
									metadata: node.metadata ?? {},
									description: node.description ?? '',
									evidence: node.evidence ?? [],
									folderColor: node.kind !== 'external' ? getFolderColor(node.path) : '#AB47BC'
								},
								classes: finalClasses
							};
							return nodeData;
						});

						// Debug first few nodes after mapping
						if (nodes.length > 0) {
							console.log('[GraphWebview] Sample nodes:', nodes.slice(0, 3).map(n => ({
								id: n.data.id,
								label: n.data.label,
								size: n.data.visualSize,
								classes: n.classes
							})));
						}
					} catch (nodeError) {
						console.error('[GraphWebview] Error processing nodes:', nodeError);
						updateStatus('Error processing graph nodes. Check console for details.', 'error');
						return;
					}

					let edges;
					try {
						edges = (payload.edges || []).map(edge => {
							const classNames = new Set();
							if (edge.kind) {
								classNames.add(edge.kind);
							}
							// Architecture relationship styling
							if (payload.mode === 'architecture' && edge.category) {
								classNames.add('relationship-' + normalizeCategory(edge.category));
							}

							// Edge type (imports, calls, uses-state, fetches, etc.)
							const edgeType = edge.metadata?.type || edge.category || 'unknown';
							if (edgeType) {
								classNames.add('edge-type-' + normalizeCategory(edgeType));
							}

							// Layer-aware routing: determine source/target layers
							const sourceLayer = nodeLayerById.get(edge.source) || null;
							const targetLayer = nodeLayerById.get(edge.target) || null;
							let sameLayer = false;
							if (sourceLayer && targetLayer) {
								if (sourceLayer === targetLayer) {
									sameLayer = true;
									classNames.add('edge-same-layer');
								} else {
									classNames.add('edge-cross-layer');
									const srcOrder = LAYER_ORDER[sourceLayer] ?? 0;
									const tgtOrder = LAYER_ORDER[targetLayer] ?? 0;
									if (srcOrder < tgtOrder) {
										classNames.add('edge-dir-down');
									} else if (srcOrder > tgtOrder) {
										classNames.add('edge-dir-up');
									}
								}
								classNames.add(
									'edge-layer-' +
										normalizeCategory(sourceLayer) +
										'-' +
										normalizeCategory(targetLayer)
								);
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
									sourceLayer: sourceLayer || null,
									targetLayer: targetLayer || null,
									sameLayer: sameLayer,
									evidence: edge.evidence ?? []
								},
								classes: Array.from(classNames).join(' ')
							};
						});
					} catch (edgeError) {
						console.error('[GraphWebview] Error processing edges:', edgeError);
						updateStatus('Error processing graph edges. Check console for details.', 'error');
						return;
					}

					console.log('[GraphWebview] Prepared', nodes.length, 'nodes and', edges.length, 'edges for rendering');

					try {
						// Build a set of valid node IDs for edge validation
						const validNodeIds = new Set(nodes.map(n => n.data.id));

						// Filter out edges that reference non-existent nodes
						const validEdges = edges.filter(e => {
							const sourceExists = validNodeIds.has(e.data.source);
							const targetExists = validNodeIds.has(e.data.target);
							if (!sourceExists || !targetExists) {
								console.warn('[GraphWebview] Skipping invalid edge: source=' + e.data.source + ' (exists:' + sourceExists + '), target=' + e.data.target + ' (exists:' + targetExists + ')');
								return false;
							}
							return true;
						});

						const skippedEdges = edges.length - validEdges.length;
						if (skippedEdges > 0) {
							console.log('[GraphWebview] Filtered out', skippedEdges, 'edges with missing nodes');
						}

						console.log('[GraphWebview] Adding', nodes.length, 'nodes and', validEdges.length, 'valid edges to Cytoscape');
						const addedElements = cy.add([...nodes, ...validEdges]);
						console.log('[GraphWebview] Added elements:', addedElements.length, 'total (nodes:', cy.nodes().length, ', edges:', cy.edges().length, ')');

						// Verify nodes have proper data and canvas container
						const container = document.getElementById('cy');
						console.log('[GraphWebview] Canvas container:', {
							exists: !!container,
							width: container?.offsetWidth || 0,
							height: container?.offsetHeight || 0,
							clientWidth: container?.clientWidth || 0,
							clientHeight: container?.clientHeight || 0
						});
						console.log('[GraphWebview] Cytoscape instance:', {
							width: cy.width(),
							height: cy.height(),
							extent: cy.extent(),
							nodeCount: cy.nodes().length,
							edgeCount: cy.edges().length
						});

						// Debug: Log detailed node information
						const allNodes = cy.nodes();
						console.log('[GraphWebview] Total nodes in graph:', allNodes.length);

						// Check parent/child relationships
						const parentNodes = allNodes.filter(n => n.isParent());
						const childNodes = allNodes.filter(n => n.isChild());
						console.log('[GraphWebview] Parent nodes:', parentNodes.length);
						parentNodes.forEach(p => {
							console.log('  - Parent "' + p.id() + '" (' + p.data('label') + '): ' + p.children().length + ' children');
						});
						console.log('[GraphWebview] Child nodes:', childNodes.length);

						// Group nodes by parent to check for overlap issues
						const nodesByParent = {};
						allNodes.forEach(n => {
							const parentId = n.data('parent') || 'none';
							if (!nodesByParent[parentId]) nodesByParent[parentId] = [];
							nodesByParent[parentId].push({
								id: n.id(),
								label: n.data('label'),
								type: n.data('kind'),
								category: n.data('category')
							});
						});
						console.log('[GraphWebview] Nodes grouped by parent:', JSON.stringify(nodesByParent, null, 2));

						// Count nodes by category
						const nodesByCategory = {};
						allNodes.forEach(n => {
							const cat = n.data('category') || 'none';
							nodesByCategory[cat] = (nodesByCategory[cat] || 0) + 1;
						});
						console.log('[GraphWebview] Nodes by category:', JSON.stringify(nodesByCategory, null, 2));

						// Sample a few nodes with different types
						const sampleNodes = allNodes.slice(0, 10).map(n => ({
							id: n.id(),
							label: n.data('label'),
							parent: n.data('parent') || null,
							category: n.data('category'),
							classes: n.classes(),
							visible: n.visible()
						}));
						console.log('[GraphWebview] Sample nodes (first 10):', JSON.stringify(sampleNodes, null, 2));

						// Resize Cytoscape to match container before layout
						cy.resize();
						console.log('[GraphWebview] Container size before layout:', 'width=' + (container?.offsetWidth || 0) + ', height=' + (container?.offsetHeight || 0));
						console.log('[GraphWebview] Cytoscape size before layout:', 'width=' + cy.width() + ', height=' + cy.height());

						// Initialize categoryState for all categories BEFORE rendering legend
						// This ensures nodes aren't hidden when applyCategoryVisibility is called
						categoryState.clear();
						(payload.nodes || []).forEach(node => {
							if (node.category) {
								categoryState.set(node.category, true); // Default to visible
							}
						});
						console.log('[GraphWebview] Category state initialized:', Array.from(categoryState.entries()));
						renderLegend(payload);
						applyCategoryVisibility();
						const visibleNodes = cy.nodes().filter(n => n.style('display') !== 'none').length;
						console.log('[GraphWebview] After visibility filter:', visibleNodes, 'visible nodes out of', cy.nodes().length);

						const rootIds = nodes.filter(n => n.classes === 'root').map(n => n.data.id);
						const isArchMode = ['frontendArch', 'backendArch', 'fullstackArch', 'smartArch'].includes(payload.mode);

						// For architecture modes, use custom layered horizontal box layout
						if (isArchMode) {
							try {
								console.log('[GraphWebview] Starting layered architecture layout');

								// Get parent (layer container) nodes and child nodes
								const parentNodes = cy.nodes(':parent');
								const childNodes = cy.nodes(':child');
								const orphanNodes = cy.nodes().filter(n => !n.isParent() && !n.isChild());

								console.log('[GraphWebview] Layout stats:', {
									parentNodes: parentNodes.length,
									childNodes: childNodes.length,
									orphanNodes: orphanNodes.length
								});

								// Layout configuration
								const config = {
									layerHeight: 180,           // Height of each layer container
									layerPadding: 40,           // Padding inside layer containers
									layerGap: 60,               // Gap between layer containers
									nodeWidth: 100,             // Width of child nodes
									nodeHeight: 50,             // Height of child nodes
									nodeGap: 20,                // Gap between nodes in a layer
									startX: 100,                // Starting X position
									startY: 100,                // Starting Y position
								};

								// Group children by parent
								const childrenByParent = new Map();
								childNodes.forEach(child => {
									const parentId = child.data('parent');
									if (parentId) {
										if (!childrenByParent.has(parentId)) {
											childrenByParent.set(parentId, []);
										}
										childrenByParent.get(parentId).push(child);
									}
								});

								// Sort parent nodes by their order (from metadata)
								const sortedParents = parentNodes.toArray().sort((a, b) => {
									const orderA = a.data('order') || a.data('metadata')?.order || 0;
									const orderB = b.data('order') || b.data('metadata')?.order || 0;
									return orderA - orderB;
								});

								console.log('[GraphWebview] Sorted parents:', sortedParents.map(p => ({
									id: p.id(),
									order: p.data('order') || p.data('metadata')?.order || 0,
									childCount: childrenByParent.get(p.id())?.length || 0
								})));

								// Position each layer and its children
								let currentY = config.startY;

								sortedParents.forEach((parent, layerIndex) => {
									const children = childrenByParent.get(parent.id()) || [];
									const childCount = children.length;

									// Calculate layer width based on children
									const layerWidth = Math.max(
										400, // Minimum width
										childCount * (config.nodeWidth + config.nodeGap) + config.layerPadding * 2
									);

									// Position children in a horizontal row inside the layer
									let childX = config.startX + config.layerPadding;
									const childY = currentY + config.layerHeight / 2;

									children.forEach((child, childIndex) => {
										child.position({
											x: childX + config.nodeWidth / 2,
											y: childY
										});
										childX += config.nodeWidth + config.nodeGap;
									});

									// Parent position is center of its children (Cytoscape auto-sizes parent)
									// We just need to ensure children are positioned correctly

									console.log('[GraphWebview] Layer "' + parent.id() + '" positioned at y=' + currentY + ' with ' + childCount + ' children');

									// Move to next layer
									currentY += config.layerHeight + config.layerGap;
								});

								// Position any orphan nodes (nodes without a parent)
								if (orphanNodes.length > 0) {
									console.log('[GraphWebview] Positioning ' + orphanNodes.length + ' orphan nodes');
									let orphanX = config.startX;
									orphanNodes.forEach(node => {
										node.position({
											x: orphanX + config.nodeWidth / 2,
											y: currentY + config.nodeHeight / 2
										});
										orphanX += config.nodeWidth + config.nodeGap;
									});
								}

								// Apply preset layout (positions already set)
								cy.layout({ name: 'preset' }).run();

								// Fit the graph with padding
								cy.resize();
								cy.fit(cy.elements(), 80);

								console.log('[GraphWebview] Layered layout complete');
									send('REN_GRAPH_APPLIED', { nodes: nodes.length, edges: edges.length });

							} catch (layoutError) {
								console.error('[GraphWebview] Layered layout error:', layoutError);
								// Fallback to cose layout
								const layout = cy.layout({
									name: 'cose',
									padding: 80,
									animate: false,
									fit: true,
									nodeRepulsion: 400000,
									nodeOverlap: 10,
									idealEdgeLength: 80,
									nestingFactor: 1.2,
									gravity: 0.4,
									randomize: true,
									componentSpacing: 80,
									numIter: 1000
								});
								layout.one('layoutstop', () => {
										cy.fit(undefined, 60);
										send('REN_GRAPH_APPLIED', { nodes: nodes.length, edges: edges.length });
								});
								layout.run();
							}
						} else {
							// Use standard layout for non-architecture modes
							const layoutName = (payload.mode === 'architecture' || payload.mode === 'dataFlow') ? 'cose' : (nodes.length > 14 ? 'cose' : 'breadthfirst');
							const layoutOptions = layoutName === 'breadthfirst'
								? { name: 'breadthfirst', directed: true, padding: 80, spacingFactor: 1.2, roots: rootIds }
								: { name: 'cose', padding: 60, animate: false };

							const layout = cy.layout(layoutOptions);
							layout.one('layoutstop', () => {
								cy.fit(undefined, 80);
								send('REN_GRAPH_APPLIED', { nodes: nodes.length, edges: edges.length });
							});
							layout.run();
						}
					} catch (renderError) {
						console.error('[GraphWebview] Error rendering graph:', renderError);
						updateStatus('Error rendering graph. Check console for details.', 'error');
					}
				} catch (outerError) {
					console.error('[GraphWebview] Error in applyGraph:', outerError);
					updateStatus('Error applying graph. Check console for details.', 'error');
				}
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
					case 'REN_GRAPH_SELECT_NODES': {
						const nodeIds = Array.isArray(message?.payload?.nodeIds) ? message.payload.nodeIds : [];
						if (nodeIds.length > 0 && cy) {
							clearSelectionHighlight(false);
							// Select first node and highlight its neighborhood
							const firstNode = cy.getElementById(nodeIds[0]);
							if (firstNode.length > 0) {
								applySelectionHighlight(firstNode);
								// Optionally center on the node
								cy.center(firstNode);
								cy.fit(firstNode, 100); // 100px padding
							}
							// If multiple nodes, also highlight others
							nodeIds.slice(1).forEach(nodeId => {
								const node = cy.getElementById(nodeId);
								if (node.length > 0) {
									node.addClass('connected');
								}
							});
						}
						break;
					}
					case 'REN_GRAPH_CLEAR_SELECTION': {
						clearSelectionHighlight(true);
						break;
					}
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

			// Hide Libraries filter
			const applyLibraryFilter = () => {
				if (!cy) return;
				cy.batch(() => {
					cy.nodes().forEach(node => {
						const kind = node.data('kind');
						if (kind === 'external') {
							node.style('display', hideLibraries ? 'none' : 'element');
						}
					});
					// Hide edges connected to hidden nodes
					cy.edges().forEach(edge => {
						const sourceVisible = edge.source().style('display') !== 'none';
						const targetVisible = edge.target().style('display') !== 'none';
						edge.style('display', sourceVisible && targetVisible ? 'element' : 'none');
					});
				});
			};

			if (hideLibrariesCheckbox) {
				hideLibrariesCheckbox.addEventListener('change', (e) => {
					hideLibraries = e.target.checked;
					applyLibraryFilter();
				});
			}

			// Edge hover handlers - show labels on hover
			const setupEdgeHoverHandlers = () => {
				if (!cy) return;
				cy.on('mouseover', 'edge', (evt) => {
					evt.target.addClass('hovered');
				});
				cy.on('mouseout', 'edge', (evt) => {
					evt.target.removeClass('hovered');
				});
			};

			document.getElementById('selectFile').addEventListener('click', () => send('REN_SELECT_FILE'));
			document.getElementById('zoomIn').addEventListener('click', () => applyZoom(1.2));
			document.getElementById('zoomOut').addEventListener('click', () => applyZoom(1 / 1.2));

			window.addEventListener('resize', () => {
				if (!cy) {
					return;
				}
				cy.resize();
			});

			// Extract folder hierarchy helper (duplicated for testing)
			const extractFolderHierarchy = (path) => {
				if (!path || typeof path !== 'string') return null;
				let cleanPath = path;
				if (cleanPath.startsWith('file://')) {
					cleanPath = cleanPath.slice(7);
				}
				try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}
				const segments = cleanPath.replace(/^[\\/\\\\]+/, '').split(/[\\/\\\\]/);

				// Build meaningful folder path, skipping common containers
				const meaningfulSegments = [];
				let foundProjectRoot = false;

				for (let i = 0; i < segments.length; i++) {
					const seg = segments[i].toLowerCase();

					// Skip empty segments and common system containers
					if (!seg || seg === 'users' || seg === 'home' || seg === 'documents' ||
					    seg === 'dev work' || seg === 'web dev' || seg === 'devwork' ||
					    seg === 'projects' || seg === 'work' || seg === 'code') {
						continue;
					}

					// Stop at filename
					if (seg.includes('.')) {
						break;
					}

					// Handle common project root folders
					if (!foundProjectRoot && (seg === 'src' || seg === 'app' || seg === 'lib' ||
					    seg === 'frontend' || seg === 'backend' || seg === 'common' ||
					    seg === 'packages' || seg === 'components' || seg === 'pages' ||
					    seg === 'routes' || seg === 'modules' || seg === 'features')) {
						foundProjectRoot = true;
						meaningfulSegments.length = 0; // Reset to project root
						continue;
					}

					// Add meaningful folder segments
					if (foundProjectRoot || meaningfulSegments.length === 0) {
						meaningfulSegments.push(seg);
					}
				}

				return meaningfulSegments.length > 0 ? {
					path: meaningfulSegments.join('/'),
					depth: meaningfulSegments.length - 1,
					displayPath: meaningfulSegments.join(' / ')
				} : null;
			};

			// Debug function to test hierarchical color assignment
			const testHierarchicalColors = () => {
				console.log('Testing hierarchical color assignment:');
				const testPaths = [
					'/Users/project/file.txt',           // Root level
					'/Users/project/src/file.txt',       // Root level (src is skipped)
					'/Users/project/src/components/file.txt',  // Level 1
					'/Users/project/src/pages/file.txt',       // Level 1 (different from components)
					'/Users/project/src/components/ui/file.txt', // Level 2
					'/Users/project/src/pages/auth/file.txt',    // Level 2
					'/Users/project/src/components/ui/button/file.txt', // Level 3 (deep)
					'/Users/project/packages/utils/file.txt',    // Level 1 (packages)
					'/Users/project/packages/utils/helpers/file.txt', // Level 2
					'/Users/project/app/routes/file.txt',        // Level 1 (app)
				];

				testPaths.forEach(path => {
					const color = getFolderColor(path);
					const hierarchy = extractFolderHierarchy(path);
					const hierarchyStr = hierarchy ? 'Level ' + hierarchy.depth + ': ' + hierarchy.path : 'Root';
					console.log(path + ' -> ' + hierarchyStr + ': ' + color);
				});
			};

			const init = () => {
				if (typeof window.cytoscape !== 'function') {
					setTimeout(init, 50);
					return;
				}
				ensureCy();
				setupEdgeHoverHandlers();
				// Uncomment to test color assignment in browser console:
				// testHierarchicalColors();
				send('REN_GRAPH_READY');
			};

			init();
		})();
		</script>
	</body>
	</html>`;
}

