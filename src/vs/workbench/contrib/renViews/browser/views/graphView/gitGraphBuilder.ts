/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from "../../../../../../platform/log/common/log.js";
import { joinPath } from "../../../../../../base/common/resources.js";
import { GraphWorkspaceContext } from "./graphContext.js";
import {
	GitHeatmapCommitSummary,
	GitHeatmapGranularity,
	GitHeatmapPayload,
	GraphWebviewPayload,
	TimelineEvent,
	GraphTimelinePayload,
} from "./graphTypes.js";
import { toCytoscapeId } from "./graphConstants.js";
import { IGitHeatmapService } from "../../../../../../platform/gitHeatmap/common/gitHeatmapService.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface GitHeatmapBuildOptions {
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

export class GitGraphBuilder {
	constructor(
		private readonly logService: ILogService,
		private readonly gitHeatmapService: IGitHeatmapService,
		private readonly context: GraphWorkspaceContext
	) {}

	async buildGraphTimeline(windowDays: number): Promise<GraphTimelinePayload> {
		const workspaceRoot = this.context.getDefaultWorkspaceRoot();
		if (!workspaceRoot || workspaceRoot.scheme !== "file") {
			throw new Error("Timeline requires a file-based workspace.");
		}

		this.logService.info("[GitGraphBuilder] Building timeline", { windowDays });

		// Reuse readGitLog to get raw history
		const commits = await this.readGitLog(workspaceRoot.fsPath, windowDays);
		
		// Map commits to TimelineEvents
		const events: TimelineEvent[] = [];
		const nodeStates = new Map<string, { [timestamp: number]: { weight: number; status: import("./graphTypes.js").GraphStatusLevel } }>();

		for (const commit of commits) {
			const affectedNodes: string[] = [];
			
			// Simple fuzzy matching of file paths to potential node IDs
			// In a real implementation, we would map these to actual graph nodes more robustly
			// For now, we assume file paths are stable identifiers
			for (const file of commit.files) {
				const fullPath = workspaceRoot ? joinPath(workspaceRoot, file.path) : null;
				if (fullPath) {
					affectedNodes.push(toCytoscapeId(fullPath.toString()));
				}
			}

			// Add event
			events.push({
				id: commit.hash,
				timestamp: commit.timestamp * 1000,
				label: commit.message.split('\n')[0], // First line as label
				description: commit.message,
				author: commit.author,
				type: 'commit',
				affectedNodes,
				metadata: {
					additions: commit.files.reduce((acc, f) => acc + f.additions, 0),
					deletions: commit.files.reduce((acc, f) => acc + f.deletions, 0)
				}
			});

			// Update node states (simple weight increment based on churn)
			const eventTime = commit.timestamp * 1000;
			for (const nodeId of affectedNodes) {
				if (!nodeStates.has(nodeId)) {
					nodeStates.set(nodeId, {});
				}
				const states = nodeStates.get(nodeId)!;
				states[eventTime] = {
					weight: 1 + Math.log(commit.files.length), // Dummy weight logic
					status: 'info'
				};
			}
		}

		return {
			events: events.sort((a, b) => a.timestamp - b.timestamp),
			windowDays,
			nodeStates
		};
	}

	async buildGitHeatmap(
		options: GitHeatmapBuildOptions
	): Promise<GraphWebviewPayload> {
		const workspaceRoot = this.context.getDefaultWorkspaceRoot();
		if (!workspaceRoot || workspaceRoot.scheme !== "file") {
			throw new Error("Git heatmap requires a file-based workspace.");
		}

		const startTime = Date.now();
		const windowDays = Math.max(
			1,
			Math.min(365, Math.floor(options.windowDays || 90))
		);
		const granularity = options.granularity ?? "topLevel";

		this.logService.info("[GitGraphBuilder] Building heatmap", {
			windowDays,
			granularity,
		});

		const commits = await this.readGitLog(workspaceRoot.fsPath, windowDays);
		this.logService.info("[GitGraphBuilder] Read git log", {
			commits: commits.length,
		});

		const pathCandidates = new Set<string>();
		for (const commit of commits) {
			for (const file of commit.files) {
				if (file?.path) {
					pathCandidates.add(file.path.replace(/\\/g, "/"));
				}
			}
		}
		let ignoredPaths: Set<string> = new Set();
		if (pathCandidates.size) {
			try {
				const ignoredList = await this.gitHeatmapService.filterIgnoredPaths(
					workspaceRoot.fsPath,
					Array.from(pathCandidates)
				);
				ignoredPaths = new Set(
					ignoredList.map((path) => path.replace(/\\/g, "/"))
				);
			} catch (error) {
				this.logService.error(
					"[GitGraphBuilder] failed to evaluate gitignore entries",
					error
				);
			}
		}
		const { filteredCommits, moduleChurnMap, totalCommits, consideredCommits } =
			this.reduceCommits(commits, granularity, ignoredPaths);
		this.logService.info("[GitGraphBuilder] Reduced commits", {
			totalCommits,
			consideredCommits,
			modules: moduleChurnMap.size,
		});

		const heatmap = this.buildHeatmapFromCommits(
			filteredCommits,
			moduleChurnMap,
			{
				granularity,
				windowDays,
				generationStartedAt: startTime,
				totalCommits,
				consideredCommits,
			}
		);

		this.logService.info("[GitGraphBuilder] Built heatmap", {
			modules: heatmap.modules.length,
			cells: heatmap.cells.length,
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
			warnings.push("No Git activity found for the selected window.");
		}

		return {
			nodes: [],
			edges: [],
			mode: "gitHeatmap",
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

	private async readGitLog(
		cwd: string,
		windowDays: number
	): Promise<ParsedGitCommit[]> {
		try {
			const stdout = await this.gitHeatmapService.readGitLog(cwd, windowDays);
			return this.parseGitLog(stdout ?? "");
		} catch (error) {
			this.logService.error(
				"[GitGraphBuilder] git log execution failed",
				error
			);
			throw new Error(
				"Unable to read Git history. Ensure Git is installed and accessible."
			);
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
			if (line.includes("\x1f")) {
				if (current) {
					commits.push(current);
				}
				const parts = line.split("\x1f");
				const hash = parts[0]?.trim() ?? "";
				const timestamp = Number(parts[1] ?? "0");
				const author = parts[2]?.trim() ?? "";
				const authorEmail = parts[3]?.trim() || undefined;
				const message = parts[4]?.trim() ?? "";
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
			const segments = line.split("\t");
			if (segments.length < 3) {
				continue;
			}
			const additions =
				segments[0] === "-" ? 0 : Number.parseInt(segments[0], 10) || 0;
			const deletions =
				segments[1] === "-" ? 0 : Number.parseInt(segments[1], 10) || 0;
			const filePath = segments.slice(2).join("\t").trim();
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

	private reduceCommits(
		commits: ParsedGitCommit[],
		granularity: GitHeatmapGranularity,
		ignoredPaths: Set<string>
	) {
		const moduleChurnMap = new Map<string, number>();
		let totalCommits = 0;
		let consideredCommits = 0;

		const filteredCommits: ReducedHeatmapCommit[] = [];

		for (const commit of commits) {
			totalCommits++;
			// Heuristic: skip massive commits (e.g. initial import, large refactor)
			if (commit.files.length > 40) {
				continue;
			}
			consideredCommits++;

			const modulesInCommit = new Set<string>();
			const commitModuleChurn = new Map<string, number>();
			let commitTotalChurn = 0;

			const validFiles: Array<ParsedGitCommitFile & { module: string | null }> = [];

			for (const file of commit.files) {
				const path = file.path.replace(/\\/g, "/");
				if (
					ignoredPaths.has(path) ||
					this.shouldIgnoreHeatmapPath(path)
				) {
					continue;
				}

				const moduleName = this.getHeatmapModuleKey(path, granularity);
				if (!moduleName) {
					continue;
				}

				const churn = file.additions + file.deletions;
				commitTotalChurn += churn;
				modulesInCommit.add(moduleName);
				commitModuleChurn.set(
					moduleName,
					(commitModuleChurn.get(moduleName) ?? 0) + churn
				);

				validFiles.push({ ...file, module: moduleName });
			}

			if (modulesInCommit.size > 0) {
				for (const [mod, churn] of commitModuleChurn) {
					moduleChurnMap.set(mod, (moduleChurnMap.get(mod) ?? 0) + churn);
				}

				filteredCommits.push({
					hash: commit.hash,
					timestamp: commit.timestamp,
					author: commit.author,
					authorEmail: commit.authorEmail,
					message: commit.message,
					modules: Array.from(modulesInCommit),
					moduleChurn: commitModuleChurn,
					commitChurn: commitTotalChurn,
					files: validFiles,
				});
			}
		}

		return { filteredCommits, moduleChurnMap, totalCommits, consideredCommits };
	}

	private buildHeatmapFromCommits(
		commits: ReducedHeatmapCommit[],
		moduleChurnMap: Map<string, number>,
		context: HeatmapBuildContext
	): GitHeatmapPayload {
		const MAX_MODULES = 120;
		const MAX_CELLS = 2500;
		const MIN_NORMALIZED = 0.05;
		const MIN_WEIGHT = 0.45;
		const MAX_COMMITS_PER_PAIR = 5;
		const MAX_FILES_PER_PAIR_SUMMARY = 6;
		const DECAY_HALF_LIFE = 90;

		const sortedModulesByChurn = Array.from(moduleChurnMap.entries()).sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
		);
		const selectedEntries = sortedModulesByChurn.slice(0, MAX_MODULES);
		const moduleNames = selectedEntries
			.map(([name]) => name)
			.sort((a, b) => a.localeCompare(b));
		const moduleIndex = new Map<string, number>(
			moduleNames.map((name, index) => [name, index])
		);
		const moduleWeightedChurn = new Array(moduleNames.length).fill(0);
		const rowTotals = new Array(moduleNames.length).fill(0);
		const pairStats = new Map<
			string,
			{
				weight: number;
				commitCount: number;
				commits: GitHeatmapCommitSummary[];
			}
		>();
		const now = Date.now();

		for (const commit of commits) {
			const modulesInScope = commit.modules.filter((module) =>
				moduleIndex.has(module)
			);
			if (!modulesInScope.length) {
				continue;
			}
			const ageDays = (now - commit.timestamp * 1000) / MS_PER_DAY;
			const decay = Math.exp(-Math.max(0, ageDays) / DECAY_HALF_LIFE);
			const weight = Number.isFinite(decay) ? Math.max(decay, 0.05) : 0.05;

			for (const moduleName of modulesInScope) {
				const idx = moduleIndex.get(moduleName)!;
				const churnContribution =
					(commit.moduleChurn.get(moduleName) ?? 0) * weight;
				moduleWeightedChurn[idx] += churnContribution;
				rowTotals[idx] += weight;
			}

			const sortedModules = [...modulesInScope].sort((a, b) =>
				a.localeCompare(b)
			);
			for (let i = 0; i < sortedModules.length; i++) {
				const moduleA = sortedModules[i];
				const indexA = moduleIndex.get(moduleA)!;
				for (let j = i; j < sortedModules.length; j++) {
					const moduleB = sortedModules[j];
					const indexB = moduleIndex.get(moduleB)!;
					const key =
						indexA <= indexB ? `${indexA}|${indexB}` : `${indexB}|${indexA}`;
					const stat = pairStats.get(key) ?? {
						weight: 0,
						commitCount: 0,
						commits: [] as GitHeatmapCommitSummary[],
					};
					stat.weight += weight;
					stat.commitCount += 1;
					if (stat.commits.length < MAX_COMMITS_PER_PAIR) {
						const files = commit.files
							.filter(
								(file) =>
									file.module &&
									(file.module === moduleA || file.module === moduleB)
							)
							.slice(0, MAX_FILES_PER_PAIR_SUMMARY)
							.map((file) => ({
								path: file.path,
								additions: file.additions,
								deletions: file.deletions,
							}));
						const pairChurn =
							(commit.moduleChurn.get(moduleA) ?? 0) +
							(moduleA === moduleB ? 0 : commit.moduleChurn.get(moduleB) ?? 0);
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
			const [rowStr, columnStr] = key.split("|");
			const row = Number(rowStr);
			const column = Number(columnStr);
			const denominator = Math.sqrt(
				(rowTotals[row] || 0) * (rowTotals[column] || 0)
			);
			const normalized = denominator > 0 ? stat.weight / denominator : 0;
			return {
				row,
				column,
				weight: Number(stat.weight.toFixed(4)),
				normalizedWeight: Number(
					(Number.isFinite(normalized) ? normalized : 0).toFixed(4)
				),
				commitCount: stat.commitCount,
				commits: stat.commits
					.slice()
					.sort((a, b) => b.timestamp - a.timestamp)
					.slice(0, MAX_COMMITS_PER_PAIR),
			};
		});

		cells = cells.filter((cell) => {
			if (cell.normalizedWeight >= MIN_NORMALIZED) {
				return true;
			}
			return cell.weight >= MIN_WEIGHT;
		});

		cells.sort(
			(a, b) => b.normalizedWeight - a.normalizedWeight || b.weight - a.weight
		);
		if (cells.length > MAX_CELLS) {
			cells.length = MAX_CELLS;
		}

		const normalizedValues = cells
			.map((cell) => cell.normalizedWeight)
			.filter((value) => value > 0)
			.sort((a, b) => a - b);
		const scale = {
			min: normalizedValues[0] ?? 0,
			median: normalizedValues.length
				? normalizedValues[Math.floor(normalizedValues.length / 2)]
				: normalizedValues[0] ?? 0,
			max: normalizedValues[normalizedValues.length - 1] ?? 0,
		};

		const topModules = moduleNames
			.map((name, index) => ({ name, churn: moduleWeightedChurn[index] }))
			.filter((entry) => entry.churn > 0)
			.sort((a, b) => b.churn - a.churn)
			.slice(0, 3)
			.map((entry) => `${entry.name} (${entry.churn.toFixed(0)})`);
		const topPairs = cells
			.slice(0, 3)
			.map(
				(cell) =>
					`${moduleNames[cell.row]} ↔ ${
						moduleNames[cell.column]
					} (${cell.normalizedWeight.toFixed(2)})`
			);

		const filters = [
			"Skipped commits touching more than 40 files.",
			"Ignored hidden folders, package managers, Docker/config artifacts, and .gitignored paths.",
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
				topModules.length
					? `Top churn: ${topModules.join(", ")}`
					: "Coupling heatmap derived from Git activity.",
				topPairs.length
					? `Strongest couplings: ${topPairs.join(", ")}`
					: "No strong module couplings detected.",
			],
			description:
				"Darker cells highlight modules that frequently change together within the selected window.",
			normalization:
				"Weights normalized by the geometric mean of per-module activity.",
			filters,
		};
	}

	private getHeatmapModuleKey(
		path: string,
		granularity: GitHeatmapGranularity
	): string | null {
		const cleaned = path.replace(/^\.\//, "");
		const segments = cleaned
			.split("/")
			.filter((segment) => !!segment && segment !== ".");
		if (!segments.length) {
			return "(root)";
		}
		switch (granularity) {
			case "file":
				return segments.join("/");
			case "twoLevel":
				return segments.slice(0, Math.min(2, segments.length)).join("/");
			case "topLevel":
			default:
				return segments[0];
		}
	}

	private shouldIgnoreHeatmapPath(path: string): boolean {
		const lower = path.toLowerCase();
		const segments = path.split("/");
		if (
			segments.some((segment) => segment.length > 1 && segment.startsWith("."))
		) {
			return true;
		}
		const filename = segments[segments.length - 1] ?? "";
		const filenameLower = filename.toLowerCase();
		if (
			filenameLower === "package.json" ||
			filenameLower === "package-lock.json" ||
			filenameLower === "yarn.lock" ||
			filenameLower === "pnpm-lock.yaml" ||
			filenameLower === "composer.lock" ||
			filenameLower === "cargo.lock" ||
			/^dockerfile(?:\.|$)/.test(filenameLower) ||
			/^docker-compose\./.test(filenameLower) ||
			filenameLower === ".gitignore" ||
			filenameLower === ".gitattributes"
		) {
			return true;
		}
		if (
			lower.includes("node_modules/") ||
			lower.includes("vendor/") ||
			lower.includes("third_party/") ||
			lower.endsWith(".lock") ||
			lower.endsWith(".min.js") ||
			lower.endsWith(".min.css") ||
			lower.startsWith("dist/") ||
			lower.startsWith("out/") ||
			lower.startsWith("build/") ||
			lower.startsWith(".yarn/") ||
			lower.startsWith(".pnpm/")
		) {
			return true;
		}
		return false;
	}
}
