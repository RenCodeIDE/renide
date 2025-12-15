/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTML template for the architecture visualization webview panel using React Flow.
 * Used for smartArch, frontendArch, backendArch, and fullstackArch modes.
 * @param nonce - Content Security Policy nonce for inline scripts
 * @returns Complete HTML document string for the webview
 */
export function buildArchWebviewHTML(nonce: string): string {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Architecture View</title>
		<style>
			html, body, #root {
				height: 100%;
				width: 100%;
				margin: 0;
				padding: 0;
				overflow: hidden;
				background: var(--vscode-editor-background, #1e1e1e);
				font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
			}

			.react-flow__node {
				font-size: 12px;
			}

			/* Custom node styles */
			.arch-node {
				padding: 12px 16px;
				border-radius: 8px;
				border: 2px solid;
				background: rgba(255, 255, 255, 0.05);
				color: #fff;
				min-width: 140px;
				box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
				transition: transform 0.15s ease, box-shadow 0.15s ease;
			}

			.arch-node:hover {
				transform: translateY(-2px);
				box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
			}

			.arch-node .node-header {
				display: flex;
				align-items: center;
				gap: 8px;
				font-weight: 600;
				font-size: 13px;
			}

			.arch-node .node-icon {
				font-size: 16px;
			}

			.arch-node .node-subtitle {
				font-size: 10px;
				opacity: 0.7;
				margin-top: 4px;
			}

			/* Category-specific colors */
			.arch-node.page {
				background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%);
				border-color: #1D4ED8;
			}

			.arch-node.layout {
				background: linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%);
				border-color: #6D28D9;
			}

			.arch-node.component {
				background: linear-gradient(135deg, #10B981 0%, #059669 100%);
				border-color: #047857;
			}

			.arch-node.hook {
				background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
				border-color: #B45309;
			}

			.arch-node.context {
				background: linear-gradient(135deg, #EC4899 0%, #DB2777 100%);
				border-color: #BE185D;
			}

			.arch-node.store {
				background: linear-gradient(135deg, #6366F1 0%, #4F46E5 100%);
				border-color: #4338CA;
			}

			/* Backend types */
			.arch-node.controller {
				background: linear-gradient(135deg, #0EA5E9 0%, #0284C7 100%);
				border-color: #0369A1;
			}

			.arch-node.service {
				background: linear-gradient(135deg, #22C55E 0%, #16A34A 100%);
				border-color: #15803D;
			}

			.arch-node.repository {
				background: linear-gradient(135deg, #A855F7 0%, #9333EA 100%);
				border-color: #7E22CE;
			}

			.arch-node.middleware {
				background: linear-gradient(135deg, #F97316 0%, #EA580C 100%);
				border-color: #C2410C;
			}

			.arch-node.route {
				background: linear-gradient(135deg, #14B8A6 0%, #0D9488 100%);
				border-color: #0F766E;
			}

			/* Edge styles */
			.react-flow__edge-path {
				stroke-width: 2;
			}

			/* Legend panel */
			.legend-panel {
				position: absolute;
				top: 12px;
				left: 12px;
				background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.95));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.1));
				border-radius: 8px;
				padding: 12px 16px;
				z-index: 10;
				font-size: 11px;
				max-width: 180px;
			}

			.legend-panel h4 {
				margin: 0 0 10px 0;
				font-size: 12px;
				color: var(--vscode-foreground, #fff);
				border-bottom: 1px solid rgba(255, 255, 255, 0.1);
				padding-bottom: 8px;
			}

			.legend-item {
				display: flex;
				align-items: center;
				gap: 8px;
				margin: 6px 0;
				color: var(--vscode-foreground, #ccc);
			}

			.legend-color {
				width: 16px;
				height: 16px;
				border-radius: 4px;
			}

			/* Status panel */
			.status-panel {
				position: absolute;
				bottom: 12px;
				left: 50%;
				transform: translateX(-50%);
				background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.95));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.1));
				border-radius: 8px;
				padding: 8px 16px;
				z-index: 10;
				font-size: 12px;
				color: var(--vscode-foreground, #fff);
				transition: opacity 0.3s ease;
			}

			.status-panel.loading {
				color: #4FC3F7;
			}

			.status-panel.success {
				color: #81C784;
			}

			.status-panel.warning {
				color: #FFB74D;
			}

			.status-panel.error {
				color: #EF5350;
			}

			/* Controls override */
			.react-flow__controls {
				background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.95));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.1));
				border-radius: 8px;
			}

			.react-flow__controls button {
				background: transparent;
				border: none;
				color: var(--vscode-foreground, #fff);
			}

			.react-flow__controls button:hover {
				background: rgba(255, 255, 255, 0.1);
			}

			/* MiniMap override */
			.react-flow__minimap {
				background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.9));
				border: 1px solid var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.1));
				border-radius: 8px;
			}
		</style>
	</head>
	<body>
		<div id="root"></div>

		<!-- React & ReactFlow from CDN -->
		<script nonce="${nonce}" src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
		<script nonce="${nonce}" src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
		<script nonce="${nonce}" src="https://unpkg.com/@xyflow/react@12/dist/index.umd.js" crossorigin></script>
		<script nonce="${nonce}" src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js" crossorigin></script>

		<script nonce="${nonce}">
			// Add error handling for library loading
			window.onerror = function(msg, url, lineNo, columnNo, error) {
				console.error('React Flow Error:', msg, url, lineNo);
				document.getElementById('root').innerHTML = '<div style="color: #EF5350; padding: 20px; text-align: center;"><h3>Error Loading Architecture View</h3><p>' + msg + '</p><p>Try refreshing or switching to Workspace view.</p></div>';
				return false;
			};

			// Check if libraries loaded
			if (typeof React === 'undefined') {
				document.getElementById('root').innerHTML = '<div style="color: #FFB74D; padding: 20px; text-align: center;"><h3>Loading React Flow...</h3><p>External libraries are loading from CDN. If this takes too long, your network might be blocking unpkg.com.</p></div>';
			} else {
				try {
					const { useState, useCallback, useEffect, useMemo } = React;

					// @xyflow/react v12 exports to window as 'ReactFlowProvider' (check)
					// Try multiple possible global names
					const xyflowLib = window.ReactFlowNS || window['@xyflow/react'] || window.ReactFlow || {};
					const {
						ReactFlow: ReactFlowComponent,
						ReactFlowProvider,
						Background,
						Controls,
						MiniMap,
						useNodesState,
						useEdgesState,
						Position,
						MarkerType
					} = xyflowLib;

					const ReactFlow = ReactFlowComponent || xyflowLib.default || xyflowLib;

					if (!ReactFlow || !useNodesState) {
						throw new Error('ReactFlow not loaded properly. Available keys: ' + Object.keys(xyflowLib).join(', '));
					}

					// VS Code API
					const vscode = acquireVsCodeApi();

					// Icon mapping for node types
					const nodeIcons = {
						page: '📄',
						layout: '📐',
						component: '🧩',
						hook: '🪝',
						context: '🔗',
						store: '📦',
						controller: '🎮',
						service: '⚙️',
						repository: '🗄️',
						middleware: '🔒',
						route: '🛤️'
					};

					// Category colors for legend
					const categoryColors = {
						page: '#3B82F6',
						layout: '#8B5CF6',
						component: '#10B981',
						hook: '#F59E0B',
						context: '#EC4899',
						store: '#6366F1',
						controller: '#0EA5E9',
						service: '#22C55E',
						repository: '#A855F7',
						middleware: '#F97316',
						route: '#14B8A6'
					};

					// Custom node component
					function ArchitectureNode({ data }) {
						const type = data.type || 'component';
						const icon = nodeIcons[type] || '📦';

						return React.createElement('div', {
							className: 'arch-node ' + type,
							onClick: () => {
								if (data.path) {
									vscode.postMessage({ type: 'REN_GRAPH_OPEN_FILE', payload: { path: data.path } });
								}
							}
						}, [
							React.createElement('div', { className: 'node-header', key: 'header' }, [
								React.createElement('span', { className: 'node-icon', key: 'icon' }, icon),
								React.createElement('span', { key: 'label' }, data.label)
							]),
							data.subtitle && React.createElement('div', { className: 'node-subtitle', key: 'subtitle' }, data.subtitle)
						]);
					}

					// Node types registry
					const nodeTypes = { archNode: ArchitectureNode };

					// Auto-layout using dagre
					function getLayoutedElements(nodes, edges, direction = 'TB') {
						if (!window.dagre) {
							console.warn('Dagre not loaded, using simple layout');
							return {
								nodes: nodes.map((n, i) => ({ ...n, position: { x: (i % 5) * 200, y: Math.floor(i / 5) * 100 } })),
								edges
							};
						}
						const dagreGraph = new dagre.graphlib.Graph();
						dagreGraph.setDefaultEdgeLabel(() => ({}));
						dagreGraph.setGraph({ rankdir: direction, nodesep: 80, ranksep: 100 });

						nodes.forEach((node) => {
							dagreGraph.setNode(node.id, { width: 160, height: 60 });
						});

						edges.forEach((edge) => {
							dagreGraph.setEdge(edge.source, edge.target);
						});

						dagre.layout(dagreGraph);

						const layoutedNodes = nodes.map((node) => {
							const nodeWithPosition = dagreGraph.node(node.id);
							return {
								...node,
								position: {
									x: nodeWithPosition.x - 80,
									y: nodeWithPosition.y - 30
								}
							};
						});

						return { nodes: layoutedNodes, edges };
					}

					// Legend component
					function Legend({ categories }) {
						return React.createElement('div', { className: 'legend-panel' }, [
							React.createElement('h4', { key: 'title' }, 'Component Types'),
							...categories.map(cat =>
								React.createElement('div', { className: 'legend-item', key: cat }, [
									React.createElement('div', {
										className: 'legend-color',
										key: 'color',
										style: { background: categoryColors[cat] || '#666' }
									}),
									React.createElement('span', { key: 'label' }, cat.charAt(0).toUpperCase() + cat.slice(1))
								])
							)
						]);
					}

					// Status panel component
					function StatusPanel({ message, level }) {
						if (!message) return null;
						return React.createElement('div', {
							className: 'status-panel ' + (level || 'info')
						}, message);
					}

					// Main App
					function App() {
						const [nodes, setNodes, onNodesChange] = useNodesState([]);
						const [edges, setEdges, onEdgesChange] = useEdgesState([]);
						const [status, setStatus] = useState({ message: 'Waiting for data...', level: 'loading' });
						const [categories, setCategories] = useState([]);

						// Convert payload to React Flow format
						const processPayload = useCallback((payload) => {
							console.log('[ArchView] Processing payload:', payload);
							if (!payload || !payload.nodes) {
								setStatus({ message: 'No data received', level: 'warning' });
								return;
							}

							const rfNodes = payload.nodes.map((node, index) => ({
								id: node.id,
								type: 'archNode',
								data: {
									label: node.label,
									type: node.kind || 'component',
									path: node.path,
									subtitle: node.layer ? node.layer : undefined
								},
								position: { x: 0, y: 0 }
							}));

							const rfEdges = (payload.edges || []).map((edge) => ({
								id: edge.id,
								source: edge.source,
								target: edge.target,
								label: edge.label,
								animated: edge.label === 'renders',
								style: { stroke: edge.label === 'uses' ? '#F59E0B' : '#E0E0E0' },
								markerEnd: { type: MarkerType ? MarkerType.ArrowClosed : 'arrowclosed' }
							}));

							// Apply layout
							const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(rfNodes, rfEdges);

							setNodes(layoutedNodes);
							setEdges(layoutedEdges);

							// Extract unique categories for legend
							const uniqueCats = [...new Set(rfNodes.map(n => n.data.type))];
							setCategories(uniqueCats);

							setStatus({
								message: rfNodes.length + ' components, ' + rfEdges.length + ' connections',
								level: 'success'
							});

							// Auto-clear status
							setTimeout(() => setStatus({ message: '', level: '' }), 4000);
						}, [setNodes, setEdges]);

						// Handle messages from extension
						useEffect(() => {
							const handleMessage = (event) => {
								const msg = event.data;
								console.log('[ArchView] Received message:', msg.type);
								if (msg.type === 'REN_GRAPH_DATA') {
									processPayload(msg.payload);
								} else if (msg.type === 'REN_GRAPH_STATUS') {
									setStatus({ message: msg.payload.message, level: msg.payload.level });
									if (msg.payload.autoClearMs) {
										setTimeout(() => setStatus({ message: '', level: '' }), msg.payload.autoClearMs);
									}
								}
							};

							window.addEventListener('message', handleMessage);

							// Signal ready
							console.log('[ArchView] Signaling ready');
							vscode.postMessage({ type: 'REN_GRAPH_READY' });

							return () => window.removeEventListener('message', handleMessage);
						}, [processPayload]);

						// Handle node click
						const onNodeClick = useCallback((event, node) => {
							if (node.data.path) {
								vscode.postMessage({ type: 'REN_GRAPH_OPEN_FILE', payload: { path: node.data.path } });
							}
						}, []);

						return React.createElement('div', { style: { width: '100%', height: '100%' } }, [
							categories.length > 0 && React.createElement(Legend, { categories, key: 'legend' }),
							React.createElement(StatusPanel, { message: status.message, level: status.level, key: 'status' }),
							React.createElement(ReactFlow, {
								key: 'flow',
								nodes: nodes,
								edges: edges,
								onNodesChange: onNodesChange,
								onEdgesChange: onEdgesChange,
								onNodeClick: onNodeClick,
								nodeTypes: nodeTypes,
								fitView: true,
								attributionPosition: 'bottom-right',
								proOptions: { hideAttribution: true }
							}, [
								Background && React.createElement(Background, { key: 'bg', color: '#333', gap: 20 }),
								Controls && React.createElement(Controls, { key: 'controls' }),
								MiniMap && React.createElement(MiniMap, {
									key: 'minimap',
									nodeColor: (node) => categoryColors[node.data?.type] || '#666',
									maskColor: 'rgba(0, 0, 0, 0.8)'
								})
							])
						]);
					}

					// Render
					const root = ReactDOM.createRoot(document.getElementById('root'));
					root.render(React.createElement(App));
				} catch (e) {
					console.error('React Flow init error:', e);
					document.getElementById('root').innerHTML = '<div style="color: #EF5350; padding: 20px; text-align: center;"><h3>Initialization Error</h3><p>' + e.message + '</p></div>';
				}
			}
		</script>
	</body>
	</html>`;
}
