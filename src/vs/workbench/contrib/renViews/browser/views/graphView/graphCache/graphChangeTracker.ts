/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	CachedGraph,
	GraphChange,
} from './graphCacheTypes.js';
import type { GraphNodePayload, GraphEdgePayload, GraphWebviewPayload, GraphEdgeKind } from '../graphTypes.js';

/**
 * Tracks changes in graph and computes incremental updates
 */
export class GraphChangeTracker {
	/**
	 * Detect changes between old and new Merkle hashes
	 */
	detectChanges(
		oldHashes: Map<string, string>,
		newHashes: Map<string, string>
	): GraphChange[] {
		const changes: GraphChange[] = new Array();

		// Find added/modified nodes
		for (const [nodeId, newHash] of Array.from(newHashes.entries())) {
			const oldHash = oldHashes.get(nodeId);
			if (!oldHash) {
				// Node added - we'll need to fetch the node to add it
				// Note: We can't provide the node here, it will be populated later
				changes.push({ type: 'node-added', node: { id: nodeId } as GraphNodePayload } as GraphChange);
			} else if (oldHash !== newHash) {
				// Node modified - hash changed, content needs to be re-parsed
				changes.push({ type: 'node-updated', nodeId, updates: {} } as GraphChange);
			}
		}

		// Find removed nodes
		for (const [nodeId] of Array.from(oldHashes.entries())) {
			if (!newHashes.has(nodeId)) {
				changes.push({ type: 'node-removed', nodeId });
			}
		}

		return changes;
	}

	/**
	 * Get list of node IDs that changed (for re-parsing)
	 */
	getChangedNodeIds(changes: GraphChange[]): string[] {
		return changes
			.filter(c => c.type === 'node-updated' || c.type === 'node-added')
			.map(c => c.type === 'node-updated' ? c.nodeId : c.node.id);
	}

	/**
	 * Compute which nodes are affected by changes
	 */
	computeAffectedNodes(changes: GraphChange[], graph: CachedGraph): Set<string> {
		const affectedNodes = new Set<string>();

		for (const change of changes) {
			switch (change.type) {
				case 'node-added':
					affectedNodes.add(change.node.id);
					break;
				case 'node-removed':
				case 'node-updated':
					affectedNodes.add(change.nodeId);
					break;
				case 'edge-added':
					affectedNodes.add(change.edge.source);
					affectedNodes.add(change.edge.target);
					break;
				case 'edge-removed':
				case 'edge-updated':
					// Find edge in graph
					const edge = graph.payload.edges.find((e) => e.id === change.edgeId);
					if (edge) {
						affectedNodes.add(edge.source);
						affectedNodes.add(edge.target);
					}
					break;
			}
		}

		return affectedNodes;
	}

	/**
	 * Apply changes to a cached graph (incremental update)
	 */
	applyChanges(graph: CachedGraph, changes: GraphChange[]): GraphWebviewPayload {
		const updatedNodes = new Map<string, GraphNodePayload>(
			graph.payload.nodes.map((n) => [n.id, { ...n }])
		);
		const updatedEdges = new Map<string, GraphEdgePayload>(
			graph.payload.edges.map((e) => [e.id, { ...e }])
		);

		// Apply changes
		for (const change of changes) {
			switch (change.type) {
				case 'node-added':
					if ('node' in change && change.node) {
						updatedNodes.set(change.node.id, change.node);
					}
					break;

				case 'node-removed':
					updatedNodes.delete(change.nodeId);
					// Also remove edges connected to this node
					for (const [edgeId, edge] of updatedEdges.entries()) {
						if (edge.source === change.nodeId || edge.target === change.nodeId) {
							updatedEdges.delete(edgeId);
						}
					}
					break;

				case 'node-updated':
					const existingNode = updatedNodes.get(change.nodeId);
					if (existingNode) {
						updatedNodes.set(change.nodeId, { ...existingNode, ...change.updates });
					}
					break;

				case 'edge-added':
					if ('edge' in change && change.edge) {
						updatedEdges.set(change.edge.id, change.edge);
					}
					break;

				case 'edge-removed':
					updatedEdges.delete(change.edgeId);
					break;

				case 'edge-updated':
					const existingEdge = updatedEdges.get(change.edgeId);
					if (existingEdge) {
						updatedEdges.set(change.edgeId, { ...existingEdge, ...change.updates });
					}
					break;

				case 'node-metadata-updated':
					const node = updatedNodes.get(change.nodeId);
					if (node) {
						updatedNodes.set(change.nodeId, {
							...node,
							metadata: { ...node.metadata, ...change.metadata },
						});
					}
					break;
			}
		}

		// Recompute node metrics (fanIn, fanOut, weight)
		const nodeMap = new Map(updatedNodes);
		for (const node of Array.from(nodeMap.values())) {
			node.fanIn = 0;
			node.fanOut = 0;
		}

		for (const edge of Array.from(updatedEdges.values())) {
			const sourceNode = nodeMap.get(edge.source);
			const targetNode = nodeMap.get(edge.target);
			if (sourceNode) {
				sourceNode.fanOut++;
			}
			if (targetNode) {
				targetNode.fanIn++;
			}
		}

		// Update weights
		for (const node of Array.from(nodeMap.values())) {
			node.weight = Math.max(node.weight, node.fanIn + node.fanOut);
		}

		return {
			...graph.payload,
			nodes: Array.from(nodeMap.values()),
			edges: Array.from(updatedEdges.values()),
		};
	}

	/**
	 * Compute hash for an edge
	 */
	computeEdgeHash(components: {
		sourceHash: string;
		targetHash: string;
		specifier: string;
		symbols: string[];
		kind: GraphEdgeKind;
	}): string {
		const sortedSymbols = [...components.symbols].sort().join(',');
		const hashInput = [
			components.sourceHash,
			components.targetHash,
			components.specifier,
			sortedSymbols,
			components.kind,
		].join('|');

		// Use simple hash for now (in production, use proper crypto hash)
		return this.simpleHash(hashInput);
	}

	/**
	 * Simple hash function (for edge hashing)
	 */
	private simpleHash(input: string): string {
		let hash = 0;
		for (let i = 0; i < input.length; i++) {
			const char = input.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * Determine if changes can be applied incrementally
	 */
	canUpdateIncrementally(changes: GraphChange[]): boolean {
		// Can update incrementally if:
		// - No structural changes (additions/removals)
		// - Only node updates (content changes)
		// - Limited number of changes

		const structuralChanges = changes.filter(
			(c) => c.type === 'node-added' || c.type === 'node-removed'
		);
		const edgeTopologyChanges = changes.filter(
			(c) => c.type === 'edge-added' || c.type === 'edge-removed'
		);

		// If structural changes, require full rebuild
		if (structuralChanges.length > 0 || edgeTopologyChanges.length > 0) {
			return false;
		}

		// If too many changes, might be better to rebuild
		if (changes.length > 20) {
			return false;
		}

		// Can do incremental update for node updates
		return changes.every(c => c.type === 'node-updated' || c.type === 'node-metadata-updated' || c.type === 'edge-updated');
	}
}

