/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import {
	ISearchService,
	IFileMatch,
	QueryType,
} from '../../../../../services/search/common/search.js';

import { GraphWorkspaceContext } from './graphContext.js';
import {
	GraphEdgeKind,
	GraphEdgePayload,
	GraphNodeKind,
	GraphNodePayload,
	GraphScopeOptions,
	GitHeatmapCommitSummary,
	GitHeatmapGranularity,
	GitHeatmapPayload,
	GraphWebviewPayload,
	ImportDescriptor,
} from './graphTypes.js';

import {
	GRAPH_DEFAULT_EXCLUDE_GLOBS,
	GRAPH_FILE_EXTENSIONS,
	GRAPH_IGNORED_IMPORT_SPECIFIERS,
	GRAPH_INDEX_FILENAMES,
	getImportBase,
	isExcludedPath,
	toCytoscapeId,
} from './graphConstants.js';
import {
	ArchitectureAnalyzer,
	ArchitectureComponent,
	ArchitectureRelationship,
	ArchitectureComponentKind,
	ArchitectureRelationshipKind,
	DetectionEvidence,
} from './architectureAnalyzer.js';
import { IGitHeatmapService } from '../../../../../../platform/gitHeatmap/common/gitHeatmapService.js';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface GitHeatmapBuildOptions {
	readonly windowDays: number;
	readonly granularity: GitHeatmapGranularity;
}

interface ParsedGitCommit {
	hash: string;
	timestamp: number;
	author: string;
	authorEmail?: string;
	message: string;
	files: ParsedGitCommitFile[];
}

interface ParsedGitCommitFile {
	path: string;
	additions: number;
	deletions: number;
}

interface ReducedHeatmapCommit {
	hash: string;
	timestamp: number;
	author: string;
	authorEmail?: string;
	message: string;
	modules: string[];
	moduleChurn: Map<string, number>;
	commitChurn: number;
	files: Array<ParsedGitCommitFile & { module: string | null }>;
}

interface HeatmapBuildContext {
	readonly granularity: GitHeatmapGranularity;
	readonly windowDays: number;
	readonly generationStartedAt: number;
	readonly totalCommits: number;
	readonly consideredCommits: number;
}

export class GraphDataBuilder {
	private readonly architectureAnalyzer: ArchitectureAnalyzer;

	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly context: GraphWorkspaceContext,
		commandService: ICommandService,
		languageFeaturesService: ILanguageFeaturesService,
		@IGitHeatmapService private readonly gitHeatmapService: IGitHeatmapService,
	) {
		this.architectureAnalyzer = new ArchitectureAnalyzer(
			this.logService,
			this.fileService,
			this.searchService,
			commandService,
			languageFeaturesService,
			this.context,
		);
	}

	get onArchitectureProgress() {
		return this.architectureAnalyzer.onProgress;
	}

	async buildGraphForFile(sourceUri: URI): Promise<GraphWebviewPayload> {
		return this.buildGraphFromFiles([sourceUri], {
			scopeRoots: new Set([this.context.getUriKey(sourceUri)]),
			scopeMode: 'file',
		});
	}

	async buildGraphForScope(
		folders: URI[],
		mode: 'folder' | 'workspace',
	): Promise<GraphWebviewPayload> {
		const files = await this.collectFilesInScope(folders);
		return this.buildGraphFromFiles(files, {
			scopeRoots: new Set(files.map((uri) => this.context.getUriKey(uri))),
			scopeMode: mode,
		});
	}

	async buildArchitectureGraph(): Promise<GraphWebviewPayload> {
		const analysis = await this.architectureAnalyzer.analyze();
		const nodeById = new Map<string, GraphNodePayload>();
		for (const component of analysis.components) {
			const node = this.createArchitectureNode(component);
			nodeById.set(node.id, node);
		}

		const edges: GraphEdgePayload[] = [];
		for (const relationship of analysis.relationships) {
			if (
				!nodeById.has(relationship.source) ||
				!nodeById.has(relationship.target)
			) {
				continue;
			}
			const edge = this.createArchitectureEdge(relationship);
			edges.push(edge);
			const sourceNode = nodeById.get(edge.source);
			const targetNode = nodeById.get(edge.target);
			if (sourceNode) {
				sourceNode.fanOut += 1;
				sourceNode.weight = Math.max(
					sourceNode.weight,
					sourceNode.fanIn + sourceNode.fanOut,
				);
			}
			if (targetNode) {
				targetNode.fanIn += 1;
				targetNode.weight = Math.max(
					targetNode.weight,
					targetNode.fanIn + targetNode.fanOut,
				);
			}
		}

		for (const node of nodeById.values()) {
			node.weight = Math.max(
				node.weight,
				Math.max(1, Math.round((node.confidence ?? 0.5) * 5)),
			);
		}

		return {
			nodes: Array.from(nodeById.values()),
			edges,
			mode: 'architecture',
			summary: analysis.summary,
			warnings: analysis.warnings,
			generatedAt: analysis.generatedAt,
			metadata: this.buildArchitectureMetadata(nodeById.values(), edges),
		};
	}

	private async readGitLog(cwd: string, windowDays: number): Promise<ParsedGitCommit[]> {
		try {
			const stdout = await this.gitHeatmapService.readGitLog(cwd, windowDays);
			return this.parseGitLog(stdout ?? '');
		} catch (error) {
			this.logService.error('[GraphDataBuilder] git log execution failed', error);
			throw new Error('Unable to read Git history. Ensure Git is installed and accessible.');
		}
	}

	private parseGitLog(raw: string): ParsedGitCommit[] {
		const commits: ParsedGitCommit[] = [];
		if (!raw) {
			return commits;
		}
		const lines = raw.split(/\r?\n/);
		let current: ParsedGitCommit | null = null;
		for (const line of lines) {
			if (!line) {
				continue;
			}
			if (line.includes('\x1f')) {
				if (current) {
					commits.push(current);
				}
				const parts = line.split('\x1f');
				const hash = parts[0]?.trim() ?? '';
				const timestamp = Number(parts[1] ?? '0');
				const author = parts[2]?.trim() ?? '';
				const authorEmail = parts[3]?.trim() || undefined;
				const message = parts[4]?.trim() ?? '';
				current = {
					hash,
					timestamp: Number.isFinite(timestamp) ? timestamp : 0,
					author,
					authorEmail,
					message,
					files: [],
				};
				continue;
			}
			if (!current) {
				continue;
			}
			const segments = line.split('\t');
			if (segments.length < 3) {
				continue;
			}
			const additions = segments[0] === '-' ? 0 : Number.parseInt(segments[0], 10) || 0;
			const deletions = segments[1] === '-' ? 0 : Number.parseInt(segments[1], 10) || 0;
			const filePath = segments.slice(2).join('\t').trim();
			if (!filePath) {
				continue;
			}
			current.files.push({ path: filePath, additions, deletions });
		}
		if (current) {
			commits.push(current);
		}
		return commits;
	}

	private reduceCommits(commits: ParsedGitCommit[], granularity: GitHeatmapGranularity, ignoredPaths: Set<string>) {
		const moduleChurnMap = new Map<string, number>();
		const filteredCommits: ReducedHeatmapCommit[] = [];
		let consideredCommits = 0;
		for (const commit of commits) {
			if (!commit.files.length || commit.files.length > 40) {
				continue;
			}
			const moduleChurn = new Map<string, number>();
			const processedFiles: Array<ParsedGitCommitFile & { module: string | null }> = [];
			for (const file of commit.files) {
				const normalizedPath = file.path.replace(/\\/g, '/');
				if (ignoredPaths.has(normalizedPath)) {
					continue;
				}
				if (this.shouldIgnoreHeatmapPath(normalizedPath)) {
					continue;
				}
				const moduleKey = this.getHeatmapModuleKey(normalizedPath, granularity);
				if (!moduleKey) {
					continue;
				}
				const churn = Math.max(0, file.additions || 0) + Math.max(0, file.deletions || 0);
				moduleChurn.set(moduleKey, (moduleChurn.get(moduleKey) ?? 0) + churn);
				processedFiles.push({ ...file, module: moduleKey });
			}
			if (moduleChurn.size === 0) {
				continue;
			}
			const modules = Array.from(moduleChurn.keys());
			const commitChurn = Array.from(moduleChurn.values()).reduce((sum, value) => sum + value, 0);
			filteredCommits.push({
				hash: commit.hash,
				timestamp: commit.timestamp,
				author: commit.author,
				authorEmail: commit.authorEmail,
				message: commit.message,
				modules,
				moduleChurn,
				commitChurn,
				files: processedFiles,
			});
			consideredCommits++;
			for (const [module, churn] of moduleChurn) {
				moduleChurnMap.set(module, (moduleChurnMap.get(module) ?? 0) + churn);
			}
		}
		return { filteredCommits, moduleChurnMap, totalCommits: commits.length, consideredCommits };
	}

	private buildHeatmapFromCommits(
		commits: ReducedHeatmapCommit[],
		moduleChurnMap: Map<string, number>,
		context: HeatmapBuildContext,
	): GitHeatmapPayload {
		const MAX_MODULES = 120;
		const MAX_CELLS = 2500;
		const MIN_NORMALIZED = 0.05;
		const MIN_WEIGHT = 0.45;
		const MAX_COMMITS_PER_PAIR = 5;
		const MAX_FILES_PER_PAIR_SUMMARY = 6;
		const DECAY_HALF_LIFE = 90;

		const sortedModulesByChurn = Array.from(moduleChurnMap.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		const selectedEntries = sortedModulesByChurn.slice(0, MAX_MODULES);
		const moduleNames = selectedEntries.map(([name]) => name).sort((a, b) => a.localeCompare(b));
		const moduleIndex = new Map<string, number>(moduleNames.map((name, index) => [name, index]));
		const moduleWeightedChurn = new Array(moduleNames.length).fill(0);
		const rowTotals = new Array(moduleNames.length).fill(0);
		const pairStats = new Map<string, { weight: number; commitCount: number; commits: GitHeatmapCommitSummary[] }>();
		const now = Date.now();

		for (const commit of commits) {
			const modulesInScope = commit.modules.filter(module => moduleIndex.has(module));
			if (!modulesInScope.length) {
				continue;
			}
			const ageDays = (now - commit.timestamp * 1000) / MS_PER_DAY;
			const decay = Math.exp(-Math.max(0, ageDays) / DECAY_HALF_LIFE);
			const weight = Number.isFinite(decay) ? Math.max(decay, 0.05) : 0.05;

			for (const moduleName of modulesInScope) {
				const idx = moduleIndex.get(moduleName)!;
				const churnContribution = (commit.moduleChurn.get(moduleName) ?? 0) * weight;
				moduleWeightedChurn[idx] += churnContribution;
				rowTotals[idx] += weight;
			}

			const sortedModules = [...modulesInScope].sort((a, b) => a.localeCompare(b));
			for (let i = 0; i < sortedModules.length; i++) {
				const moduleA = sortedModules[i];
				const indexA = moduleIndex.get(moduleA)!;
				for (let j = i; j < sortedModules.length; j++) {
					const moduleB = sortedModules[j];
					const indexB = moduleIndex.get(moduleB)!;
					const key = indexA <= indexB ? `${indexA}|${indexB}` : `${indexB}|${indexA}`;
					const stat = pairStats.get(key) ?? { weight: 0, commitCount: 0, commits: [] as GitHeatmapCommitSummary[] };
					stat.weight += weight;
					stat.commitCount += 1;
					if (stat.commits.length < MAX_COMMITS_PER_PAIR) {
						const files = commit.files
							.filter(file => file.module && (file.module === moduleA || file.module === moduleB))
							.slice(0, MAX_FILES_PER_PAIR_SUMMARY)
							.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions }));
						const pairChurn = (commit.moduleChurn.get(moduleA) ?? 0) + (moduleA === moduleB ? 0 : (commit.moduleChurn.get(moduleB) ?? 0));
						stat.commits.push({
							hash: commit.hash,
							message: commit.message,
							author: commit.author,
							authorEmail: commit.authorEmail,
							timestamp: commit.timestamp * 1000,
							modules: moduleA === moduleB ? [moduleA] : [moduleA, moduleB],
							churn: pairChurn,
							files,
						});
					}
					pairStats.set(key, stat);
				}
			}
		}

		let cells = Array.from(pairStats.entries()).map(([key, stat]) => {
			const [rowStr, columnStr] = key.split('|');
			const row = Number(rowStr);
			const column = Number(columnStr);
			const denominator = Math.sqrt((rowTotals[row] || 0) * (rowTotals[column] || 0));
			const normalized = denominator > 0 ? stat.weight / denominator : 0;
			return {
				row,
				column,
				weight: Number(stat.weight.toFixed(4)),
				normalizedWeight: Number((Number.isFinite(normalized) ? normalized : 0).toFixed(4)),
				commitCount: stat.commitCount,
				commits: stat.commits
					.slice()
					.sort((a, b) => b.timestamp - a.timestamp)
					.slice(0, MAX_COMMITS_PER_PAIR),
			};
		});

		cells = cells.filter(cell => {
			if (cell.normalizedWeight >= MIN_NORMALIZED) {
				return true;
			}
			return cell.weight >= MIN_WEIGHT;
		});

		cells.sort((a, b) => b.normalizedWeight - a.normalizedWeight || b.weight - a.weight);
		if (cells.length > MAX_CELLS) {
			cells.length = MAX_CELLS;
		}

		const normalizedValues = cells
			.map(cell => cell.normalizedWeight)
			.filter(value => value > 0)
			.sort((a, b) => a - b);
		const scale = {
			min: normalizedValues[0] ?? 0,
			median: normalizedValues.length ? normalizedValues[Math.floor(normalizedValues.length / 2)] : (normalizedValues[0] ?? 0),
			max: normalizedValues[normalizedValues.length - 1] ?? 0,
		};

		const topModules = moduleNames
			.map((name, index) => ({ name, churn: moduleWeightedChurn[index] }))
			.filter(entry => entry.churn > 0)
			.sort((a, b) => b.churn - a.churn)
			.slice(0, 3)
			.map(entry => `${entry.name} (${entry.churn.toFixed(0)})`);
		const topPairs = cells
			.slice(0, 3)
			.map(cell => `${moduleNames[cell.row]} ↔ ${moduleNames[cell.column]} (${cell.normalizedWeight.toFixed(2)})`);

		const filters = [
			'Skipped commits touching more than 40 files.',
			'Ignored hidden folders, package managers, Docker/config artifacts, and .gitignored paths.',
			`Applied exponential time decay (half-life ${DECAY_HALF_LIFE} days).`,
		];

		return {
			modules: moduleNames,
			granularity: context.granularity,
			windowDays: context.windowDays,
			totalCommits: context.totalCommits,
			consideredCommits: context.consideredCommits,
			generationStartedAt: context.generationStartedAt,
			churn: moduleWeightedChurn,
			cells,
			colorScale: scale,
			summary: [
				topModules.length ? `Top churn: ${topModules.join(', ')}` : 'Coupling heatmap derived from Git activity.',
				topPairs.length ? `Strongest couplings: ${topPairs.join(', ')}` : 'No strong module couplings detected.',
			],
			description: 'Darker cells highlight modules that frequently change together within the selected window.',
			normalization: 'Weights normalized by the geometric mean of per-module activity.',
			filters,
		};
	}

	private getHeatmapModuleKey(path: string, granularity: GitHeatmapGranularity): string | null {
		const cleaned = path.replace(/^\.\//, '');
		const segments = cleaned.split('/').filter(segment => !!segment && segment !== '.');
		if (!segments.length) {
			return '(root)';
		}
		switch (granularity) {
			case 'file':
				return segments.join('/');
			case 'twoLevel':
				return segments.slice(0, Math.min(2, segments.length)).join('/');
			case 'topLevel':
			default:
				return segments[0];
		}
	}

	private shouldIgnoreHeatmapPath(path: string): boolean {
		const lower = path.toLowerCase();
		const segments = path.split('/');
		if (segments.some(segment => segment.length > 1 && segment.startsWith('.'))) {
			return true;
		}
		const filename = segments[segments.length - 1] ?? '';
		const filenameLower = filename.toLowerCase();
		if (
			filenameLower === 'package.json' ||
			filenameLower === 'package-lock.json' ||
			filenameLower === 'yarn.lock' ||
			filenameLower === 'pnpm-lock.yaml' ||
			filenameLower === 'composer.lock' ||
			filenameLower === 'cargo.lock' ||
			/^dockerfile(?:\.|$)/.test(filenameLower) ||
			/^docker-compose\./.test(filenameLower) ||
			filenameLower === '.gitignore' ||
			filenameLower === '.gitattributes'
		) {
			return true;
		}
		if (
			lower.includes('node_modules/') ||
			lower.includes('vendor/') ||
			lower.includes('third_party/') ||
			lower.endsWith('.lock') ||
			lower.endsWith('.min.js') ||
			lower.endsWith('.min.css') ||
			lower.startsWith('dist/') ||
			lower.startsWith('out/') ||
			lower.startsWith('build/') ||
			lower.startsWith('.yarn/') ||
			lower.startsWith('.pnpm/')
		) {
			return true;
		}
		return false;
	}

	async buildGitHeatmap(options: GitHeatmapBuildOptions): Promise<GraphWebviewPayload> {
		const workspaceRoot = this.context.getDefaultWorkspaceRoot();
		if (!workspaceRoot || workspaceRoot.scheme !== 'file') {
			throw new Error('Git heatmap requires a file-based workspace.');
		}

		const startTime = Date.now();
		const windowDays = Math.max(1, Math.min(365, Math.floor(options.windowDays || 90)));
		const granularity = options.granularity ?? 'topLevel';

		const commits = await this.readGitLog(workspaceRoot.fsPath, windowDays);
		const pathCandidates = new Set<string>();
		for (const commit of commits) {
			for (const file of commit.files) {
				if (file?.path) {
					pathCandidates.add(file.path.replace(/\\/g, '/'));
				}
			}
		}
		let ignoredPaths: Set<string> = new Set();
		if (pathCandidates.size) {
			try {
				const ignoredList = await this.gitHeatmapService.filterIgnoredPaths(workspaceRoot.fsPath, Array.from(pathCandidates));
				ignoredPaths = new Set(ignoredList.map(path => path.replace(/\\/g, '/')));
			} catch (error) {
				this.logService.error('[GraphDataBuilder] failed to evaluate gitignore entries', error);
			}
		}
		const { filteredCommits, moduleChurnMap, totalCommits, consideredCommits } = this.reduceCommits(commits, granularity, ignoredPaths);
		const heatmap = this.buildHeatmapFromCommits(filteredCommits, moduleChurnMap, {
			granularity,
			windowDays,
			generationStartedAt: startTime,
			totalCommits,
			consideredCommits,
		});

		const summary: string[] = [];
		if (heatmap.modules.length) {
			summary.push(`Modules analyzed: ${heatmap.modules.length}`);
		}
		if (heatmap.cells.length) {
			summary.push(`Active couplings: ${heatmap.cells.length}`);
		}
		summary.push(`Commits considered: ${consideredCommits} of ${totalCommits}`);

		const warnings: string[] = [];
		if (!consideredCommits) {
			warnings.push('No Git activity found for the selected window.');
		}

		return {
			nodes: [],
			edges: [],
			mode: 'gitHeatmap',
			summary,
			warnings,
			generatedAt: Date.now(),
			metadata: {
				windowDays,
				granularity,
				totalCommits,
				consideredCommits,
			},
			heatmap: heatmap,
		};
	}

	private createArchitectureNode(
		component: ArchitectureComponent,
	): GraphNodePayload {
		const evidenceDescriptions = this.takeEvidenceDescriptions(
			component.evidence,
		);
		const primaryResource =
			this.getEvidenceResource(component.evidence) ??
			this.parseMetadataResource(component.metadata?.workspaceFolder);
		const path = primaryResource
			? primaryResource.toString(true)
			: `arch://${component.key}`;
		const openable =
			!!primaryResource && this.context.isWithinWorkspace(primaryResource);
		const metadata: Record<string, unknown> = {
			...(component.metadata ?? {}),
			key: component.key,
		};
		if (component.tags?.length) {
			metadata.tags = component.tags;
		}
		return {
			id: component.id,
			label: component.label,
			path,
			kind: this.mapComponentKindToNodeKind(component.kind),
			weight: Math.max(1, Math.round((component.confidence ?? 0.4) * 4)),
			fanIn: 0,
			fanOut: 0,
			openable,
			category: component.kind,
			confidence: component.confidence,
			tags: component.tags ?? [],
			metadata,
			description: component.description,
			evidence: evidenceDescriptions,
		};
	}

	private createArchitectureEdge(
		relationship: ArchitectureRelationship,
	): GraphEdgePayload {
		const evidenceDescriptions = this.takeEvidenceDescriptions(
			relationship.evidence,
		);
		return {
			id: relationship.id,
			source: relationship.source,
			target: relationship.target,
			label:
				relationship.description ??
				this.formatRelationshipLabel(relationship.kind),
			specifier: `architecture:${relationship.kind}`,
			kind: this.mapRelationshipKindToEdgeKind(relationship.kind),
			symbols: evidenceDescriptions,
			category: relationship.kind,
			confidence: relationship.confidence,
			metadata: { ...(relationship.metadata ?? {}), kind: relationship.kind },
			evidence: evidenceDescriptions,
		};
	}

	private mapComponentKindToNodeKind(
		kind: ArchitectureComponentKind,
	): GraphNodeKind {
		switch (kind) {
			case 'application':
			case 'infrastructure':
			case 'configuration':
				return 'root';
			case 'externalService':
				return 'external';
			default:
				return 'relative';
		}
	}

	private mapRelationshipKindToEdgeKind(
		kind: ArchitectureRelationshipKind,
	): GraphEdgeKind {
		switch (kind) {
			case 'calls':
			case 'publishes':
			case 'consumes':
				return 'external';
			case 'dependsOn':
			case 'connectsTo':
			case 'stores':
			case 'queries':
			case 'hosts':
			default:
				return 'relative';
		}
	}

	private buildArchitectureMetadata(
		nodes: Iterable<GraphNodePayload>,
		edges: GraphEdgePayload[],
	): Record<string, unknown> {
		const nodeArray = Array.from(nodes);
		const categoryCounts = new Map<string, number>();
		const datasets: Array<{
			id: string;
			label: string;
			metadata?: Record<string, unknown>;
		}> = [];
		for (const node of nodeArray) {
			const category = node.category ?? 'unknown';
			categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
			if (category === 'dataset') {
				datasets.push({
					id: node.id,
					label: node.label,
					metadata: node.metadata,
				});
			}
		}

		const relationshipCounts = new Map<string, number>();
		for (const edge of edges) {
			const category = edge.category ?? edge.kind;
			relationshipCounts.set(
				category,
				(relationshipCounts.get(category) ?? 0) + 1,
			);
		}

		return {
			categoryCounts: Object.fromEntries(categoryCounts),
			relationshipCounts: Object.fromEntries(relationshipCounts),
			datasets,
		};
	}

	private takeEvidenceDescriptions(
		evidence: DetectionEvidence[],
		max = 4,
	): string[] {
		const descriptions: string[] = [];
		for (const entry of evidence) {
			if (!entry?.description) {
				continue;
			}
			descriptions.push(entry.description);
			if (descriptions.length >= max) {
				break;
			}
		}
		return descriptions;
	}

	private getEvidenceResource(evidence: DetectionEvidence[]): URI | undefined {
		for (const entry of evidence) {
			if (entry.resource) {
				return entry.resource;
			}
		}
		return undefined;
	}

	private parseMetadataResource(value: unknown): URI | undefined {
		if (typeof value !== 'string' || !value) {
			return undefined;
		}
		try {
			return URI.parse(value);
		} catch (error) {
			this.logService.debug(
				'[GraphDataBuilder] failed to parse metadata resource',
				value,
				error,
			);
			return undefined;
		}
	}

	private formatRelationshipLabel(kind: ArchitectureRelationshipKind): string {
		return kind.replace(/([a-z])([A-Z])/g, '$1 $2');
	}

	async collectFilesInScope(folders: readonly URI[]): Promise<URI[]> {
		if (!folders.length) {
			return [];
		}
		const folderQueries = folders.map((folder) => ({ folder }));
		const searchQuery = {
			type: QueryType.File as QueryType.File,
			folderQueries,
			filePattern: undefined,
			sortByScore: false,
			excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
			maxResults: 5000,
		};
		const results = await this.searchService.fileSearch(searchQuery);
		const files: URI[] = [];
		if (results.limitHit) {
			this.logService.warn(
				'[GraphView] file search limit reached; graph may be incomplete.',
			);
		}
		for (const match of results.results) {
			const resource = (match as IFileMatch).resource;
			if (!resource) {
				continue;
			}
			if (isExcludedPath(resource.path)) {
				continue;
			}
			const lowerPath = resource.path.toLowerCase();
			if (!GRAPH_FILE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
				continue;
			}
			files.push(resource);
		}
		return files;
	}

	private async buildGraphFromFiles(
		initialFiles: URI[],
		options: GraphScopeOptions,
	): Promise<GraphWebviewPayload> {
		type MutableGraphNode = {
			id: string;
			label: string;
			path: string;
			kind: GraphNodeKind;
			weight: number;
			fanIn: number;
			fanOut: number;
			openable: boolean;
		};

		const nodes = new Map<string, MutableGraphNode>();
		const edges = new Map<
			string,
			{
				payload: GraphEdgePayload;
				labelParts: Set<string>;
				symbolNames: Set<string>;
			}
		>();
		const processed = new Set<string>();
		const queue: URI[] = [...initialFiles];
		const descriptorCache = new Map<string, Promise<ImportDescriptor[]>>();
		const resolvedCache = new Map<string, Promise<URI | undefined>>();

		const ensureFileNode = (uri: URI): MutableGraphNode => {
			const id = this.toNodeId(uri);
			let node = nodes.get(id);
			const isRoot =
				options.scopeMode !== 'workspace' &&
				options.scopeRoots.has(this.context.getUriKey(uri));
			const isExcluded = isExcludedPath(uri.path);
			const isWithinWorkspace = this.context.isWithinWorkspace(uri);
			const openable = isWithinWorkspace && !isExcluded;
			if (!node) {
				node = {
					id,
					label: this.context.extUri.basename(uri),
					path: uri.toString(true),
					kind: isRoot ? 'root' : 'relative',
					weight: 1,
					fanIn: 0,
					fanOut: 0,
					openable,
				};
				nodes.set(id, node);
			} else if (isRoot && node.kind !== 'root') {
				node.kind = 'root';
			}
			node.openable = node.openable && openable;
			return node;
		};

		const ensureExternalNode = (specifier: string, resolvedUri?: URI): MutableGraphNode => {
			const id = this.toNodeId(`module:${specifier}`);
			let node = nodes.get(id);
			if (!node) {
				// Try to extract basename from resolvedUri if available
				let label = specifier;
				if (resolvedUri) {
					label = this.context.extUri.basename(resolvedUri);
				} else {
					// Try to extract basename from specifier path if it looks like a file path
					const specifierParts = specifier.split(/[\\/]/);
					const lastPart = specifierParts[specifierParts.length - 1];
					if (lastPart && lastPart.includes('.')) {
						label = lastPart;
					}
				}
				node = {
					id,
					label,
					path: specifier,
					kind: 'external',
					weight: 1,
					fanIn: 0,
					fanOut: 0,
					openable: false,
				};
				nodes.set(id, node);
			}
			return node;
		};

		while (queue.length) {
			const fileUri = queue.shift()!;
			const fileKey = this.context.getUriKey(fileUri);
			if (processed.has(fileKey)) {
				continue;
			}
			processed.add(fileKey);

			const sourceNode = ensureFileNode(fileUri);
			let descriptors: ImportDescriptor[] = [];
			try {
				descriptors = await this.getImportDescriptors(fileUri, descriptorCache);
			} catch (error) {
				this.logService.error(
					'[GraphView] failed to parse imports',
					fileUri.toString(true),
					error,
				);
				continue;
			}

			for (const descriptor of descriptors) {
				const resolvedUri = await this.resolveImportTargetCached(
					fileUri,
					descriptor.specifier,
					resolvedCache,
				);
				if (this.shouldIgnoreImport(descriptor.specifier, resolvedUri)) {
					continue;
				}

				let targetNode: MutableGraphNode;
				let targetId: string;
				let edgeKind: GraphEdgeKind;
				if (
					resolvedUri &&
					this.context.isWithinWorkspace(resolvedUri) &&
					!isExcludedPath(resolvedUri.path)
				) {
					queue.push(resolvedUri);
					targetNode = ensureFileNode(resolvedUri);
					targetId = targetNode.id;
					edgeKind = descriptor.isSideEffectOnly ? 'sideEffect' : 'relative';
				} else {
					targetNode = ensureExternalNode(descriptor.specifier, resolvedUri);
					targetId = targetNode.id;
					edgeKind = descriptor.isSideEffectOnly ? 'sideEffect' : 'external';
				}

				const edgeKey = `${targetId}->${sourceNode.id}`;
				let entry = edges.get(edgeKey);
				if (!entry) {
					const payload: GraphEdgePayload = {
						id: this.toNodeId(`edge:${edgeKey}`),
						source: targetId,
						target: sourceNode.id,
						label: '',
						specifier: descriptor.specifier,
						kind: edgeKind,
						sourcePath: targetNode.path,
						targetPath: sourceNode.path,
						symbols: [],
					};
					entry = {
						payload,
						labelParts: new Set<string>(),
						symbolNames: new Set<string>(),
					};
					edges.set(edgeKey, entry);
				}

				for (const symbol of this.getSymbolsForDescriptor(descriptor)) {
					entry.labelParts.add(symbol);
				}
				for (const candidate of this.getSymbolNameCandidates(descriptor)) {
					entry.symbolNames.add(candidate);
				}

				if (descriptor.isSideEffectOnly) {
					entry.payload.kind = 'sideEffect';
				} else if (entry.payload.kind !== 'sideEffect') {
					entry.payload.kind = edgeKind;
				}

				targetNode.fanOut += 1;
				sourceNode.fanIn += 1;
				sourceNode.weight = Math.max(
					sourceNode.weight,
					sourceNode.fanIn + sourceNode.fanOut,
				);
				targetNode.weight = Math.max(
					targetNode.weight,
					targetNode.fanIn + targetNode.fanOut,
				);
				entry.payload.label = this.composeEdgeLabel(
					entry.labelParts,
					entry.payload.kind,
				);
				entry.payload.symbols = entry.symbolNames.size
					? Array.from(entry.symbolNames)
					: [];
			}
		}

		const nodeArray = Array.from(nodes.values()).map((node) => {
			if (node.weight <= 1) {
				node.weight = Math.max(1, node.fanIn + node.fanOut);
			}
			return node;
		});
		const edgeArray = Array.from(edges.values(), (entry) => {
			if (!entry.payload.symbols || entry.payload.symbols.length === 0) {
				entry.payload.symbols = entry.symbolNames.size
					? Array.from(entry.symbolNames)
					: [];
			}
			return entry.payload;
		});
		return { nodes: nodeArray, edges: edgeArray };
	}

	private async getImportDescriptors(
		uri: URI,
		cache: Map<string, Promise<ImportDescriptor[]>>,
	): Promise<ImportDescriptor[]> {
		const key = this.context.getUriKey(uri);
		let promise = cache.get(key);
		if (!promise) {
			promise = (async () => {
				const buffer = await this.fileService.readFile(uri);
				const content = buffer.value.toString();
				return this.extractImportDescriptors(content);
			})();
			cache.set(key, promise);
		}
		return promise;
	}

	private async resolveImportTargetCached(
		sourceUri: URI,
		specifier: string,
		cache: Map<string, Promise<URI | undefined>>,
	): Promise<URI | undefined> {
		const cacheKey = `${this.context.getUriKey(sourceUri)}::${specifier}`;
		let promise = cache.get(cacheKey);
		if (!promise) {
			promise = this.resolveImportTarget(sourceUri, specifier);
			cache.set(cacheKey, promise);
		}
		return promise;
	}

	private toNodeId(value: URI | string): string {
		const raw = typeof value === 'string' ? value : value.toString(true);
		return toCytoscapeId(raw);
	}

	private getSymbolsForDescriptor(descriptor: ImportDescriptor): string[] {
		const symbols: string[] = [];
		if (descriptor.defaultImport) {
			symbols.push(
				this.decorateSymbol(
					descriptor.defaultImport.name,
					descriptor.defaultImport.isTypeOnly,
				),
			);
		}
		if (descriptor.namespaceImport) {
			symbols.push(
				this.decorateSymbol(
					`* as ${descriptor.namespaceImport.name}`,
					descriptor.namespaceImport.isTypeOnly,
				),
			);
		}
		for (const item of descriptor.namedImports) {
			const display = item.propertyName
				? `${item.propertyName} as ${item.name}`
				: item.name;
			symbols.push(this.decorateSymbol(display, item.isTypeOnly));
		}
		return symbols;
	}

	private getSymbolNameCandidates(descriptor: ImportDescriptor): string[] {
		const candidates: string[] = [];
		if (descriptor.defaultImport) {
			candidates.push(descriptor.defaultImport.name);
		}
		if (descriptor.namespaceImport) {
			candidates.push(descriptor.namespaceImport.name);
		}
		for (const item of descriptor.namedImports) {
			candidates.push(item.propertyName ?? item.name);
		}
		return candidates;
	}

	private decorateSymbol(name: string, isTypeOnly: boolean): string {
		return isTypeOnly ? `${name} (type)` : name;
	}

	private composeEdgeLabel(symbols: Set<string>, kind: GraphEdgeKind): string {
		if (kind === 'sideEffect') {
			return '[side-effect]';
		}
		if (symbols.size === 0) {
			return '';
		}
		return Array.from(symbols)
			.sort((a, b) => a.localeCompare(b))
			.join(', ');
	}

	private async resolveImportTarget(
		sourceUri: URI,
		specifier: string,
	): Promise<URI | undefined> {
		if (!specifier) {
			return undefined;
		}
		let baseUri: URI | undefined;
		if (specifier.startsWith('.')) {
			baseUri = this.context.extUri.resolvePath(
				this.context.extUri.dirname(sourceUri),
				specifier,
			);
		} else if (specifier.startsWith('/')) {
			const workspaceRoot = this.context.getDefaultWorkspaceRoot();
			if (workspaceRoot) {
				baseUri = this.context.extUri.resolvePath(workspaceRoot, specifier);
			}
		} else {
			return undefined;
		}

		if (!baseUri) {
			return undefined;
		}

		const candidates = this.expandImportCandidates(baseUri);
		for (const candidate of candidates) {
			try {
				if (await this.fileService.exists(candidate)) {
					return candidate;
				}
			} catch (error) {
				this.logService.debug('[GraphView] error checking candidate', error);
			}
		}
		return undefined;
	}

	private expandImportCandidates(baseUri: URI): URI[] {
		const extUri = this.context.extUri;
		const extension = extUri.extname(baseUri).toLowerCase();
		const candidates: URI[] = [];
		const seen = new Set<string>();
		const pushCandidate = (uri: URI) => {
			const key = uri.toString();
			if (!seen.has(key)) {
				seen.add(key);
				candidates.push(uri);
			}
		};

		if (extension && GRAPH_FILE_EXTENSIONS.some((ext) => ext === extension)) {
			pushCandidate(baseUri);
			return candidates;
		}

		const dir = extUri.dirname(baseUri);
		const baseName = extUri.basename(baseUri);

		for (const ext of GRAPH_FILE_EXTENSIONS) {
			pushCandidate(extUri.joinPath(dir, `${baseName}${ext}`));
		}

		if (baseName && baseName !== 'index') {
			for (const indexName of GRAPH_INDEX_FILENAMES) {
				pushCandidate(extUri.joinPath(baseUri, indexName));
			}
		}

		return candidates;
	}

	private shouldIgnoreImport(
		specifier: string,
		resolvedUri: URI | undefined,
	): boolean {
		const base = getImportBase(specifier);
		if (GRAPH_IGNORED_IMPORT_SPECIFIERS.has(base)) {
			return true;
		}
		if (resolvedUri) {
			const path = resolvedUri.path.toLowerCase();
			if (
				path.includes('/node_modules/') ||
				path.includes('\\node_modules\\')
			) {
				return true;
			}
		}
		return false;
	}

	private extractImportDescriptors(content: string): ImportDescriptor[] {
		const descriptors: ImportDescriptor[] = [];
		let match: RegExpExecArray | null;

		const importFromRegex = /import\s+([^'";]+?)\s+from\s+['"]([^'";]+)['"]/g;
		while ((match = importFromRegex.exec(content)) !== null) {
			let clause = match[1]?.trim() ?? '';
			const specifier = match[2]?.trim() ?? '';
			if (!specifier) {
				continue;
			}

			let clauseIsTypeOnly = false;
			if (clause.startsWith('type ')) {
				clauseIsTypeOnly = true;
				clause = clause.slice(4).trim();
			}

			const descriptor: ImportDescriptor = {
				specifier,
				defaultImport: undefined,
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: false,
			};

			let remainder = clause;
			if (
				remainder &&
				!remainder.startsWith('{') &&
				!remainder.startsWith('*')
			) {
				const commaIndex = remainder.indexOf(',');
				const defaultPart =
					commaIndex === -1 ? remainder : remainder.slice(0, commaIndex);
				remainder = commaIndex === -1 ? '' : remainder.slice(commaIndex + 1);
				const name = defaultPart.trim();
				if (name) {
					descriptor.defaultImport = { name, isTypeOnly: clauseIsTypeOnly };
				}
			}

			remainder = remainder.trim();
			if (remainder.startsWith('{') && remainder.includes('}')) {
				const inside = remainder.slice(1, remainder.indexOf('}'));
				for (const entry of inside.split(',')) {
					let token = entry.trim();
					if (!token) {
						continue;
					}
					let isTypeOnly = clauseIsTypeOnly;
					if (token.startsWith('type ')) {
						isTypeOnly = true;
						token = token.slice(5).trim();
					}
					const asMatch = /^(.*?)\s+as\s+(.*)$/.exec(token);
					if (asMatch) {
						const original = asMatch[1].trim();
						const alias = asMatch[2].trim();
						if (alias) {
							descriptor.namedImports.push({
								name: alias,
								propertyName:
									original && original !== alias ? original : undefined,
								isTypeOnly,
							});
						}
					} else if (token) {
						descriptor.namedImports.push({
							name: token,
							propertyName: undefined,
							isTypeOnly,
						});
					}
				}
			} else if (remainder.startsWith('*')) {
				const nsMatch = /\*\s+as\s+([A-Za-z0-9_$]+)/.exec(remainder);
				if (nsMatch) {
					descriptor.namespaceImport = {
						name: nsMatch[1],
						isTypeOnly: clauseIsTypeOnly,
					};
				}
			}

			descriptors.push(descriptor);
		}

		const sideEffectRegex = /import\s+['"]([^'";]+)['"]/g;
		while ((match = sideEffectRegex.exec(content)) !== null) {
			const specifier = match[1]?.trim() ?? '';
			if (!specifier) {
				continue;
			}
			descriptors.push({
				specifier,
				defaultImport: undefined,
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: true,
			});
		}

		const importEqualsRegex =
			/import\s+(type\s+)?([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"]([^'";]+)['"]\s*\)/g;
		while ((match = importEqualsRegex.exec(content)) !== null) {
			const specifier = match[3]?.trim() ?? '';
			const name = match[2]?.trim() ?? '';
			if (!specifier || !name) {
				continue;
			}
			const isTypeOnly = !!match[1];
			descriptors.push({
				specifier,
				defaultImport: { name, isTypeOnly },
				namespaceImport: undefined,
				namedImports: [],
				isSideEffectOnly: false,
			});
		}

		return descriptors;
	}
}
