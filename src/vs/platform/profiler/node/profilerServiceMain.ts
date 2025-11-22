/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Server as IPCServer } from '../../../base/parts/ipc/node/ipc.cp.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IProfilerService, ProfileRun, Hotspot, ProfilerIpcChannels, ERROR_UNSUPPORTED_LANGUAGE } from '../common/profiler.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';

class ProfilerService extends Disposable implements IProfilerService {
	declare readonly _serviceBrand: undefined;

	private readonly storageHome: string;

	constructor() {
		super();
		this.storageHome = process.env['VSCODE_PROFILER_STORAGE_HOME'] || '';
		if (!this.storageHome) {
			console.error('VSCODE_PROFILER_STORAGE_HOME not set');
		}
	}

	private detectLanguage(command: string): 'python' | 'node' | 'unknown' {
		const executable = command.split(' ')[0];
		if (['python', 'python3', 'py'].includes(executable)) {
			return 'python';
		}
		if (['node', 'ts-node'].includes(executable)) {
			return 'node';
		}
		return 'unknown';
	}

	async runProfile(command: string, cwd: string, workspaceId: string): Promise<ProfileRun> {
		if (!this.storageHome) {
			throw new Error('Profiler storage not available');
		}

		const language = this.detectLanguage(command);
		if (language === 'unknown') {
			throw new Error(ERROR_UNSUPPORTED_LANGUAGE);
		}

		const runId = Date.now().toString();
		const workspaceStorage = path.join(this.storageHome, workspaceId, 'profiler');
		const runsDir = path.join(workspaceStorage, 'runs');
		await fs.promises.mkdir(runsDir, { recursive: true });

		let runPromise: Promise<ProfileRun>;

		if (language === 'python') {
			runPromise = this.runPythonProfile(runId, runsDir, command, cwd);
		} else {
			runPromise = this.runNodeProfile(runId, runsDir, command, cwd);
		}

		const run = await runPromise;

		// Append to runs list
		const runsListFile = path.join(workspaceStorage, 'runs.json');
		let runs: ProfileRun[] = [];
		if (fs.existsSync(runsListFile)) {
			try {
				runs = JSON.parse(await fs.promises.readFile(runsListFile, 'utf8'));
			} catch {
				// ignore corrupted file
			}
		}
		runs.push(run);
		await fs.promises.writeFile(runsListFile, JSON.stringify(runs, null, 2));

		return run;
	}

	private async runPythonProfile(runId: string, runsDir: string, command: string, cwd: string): Promise<ProfileRun> {
		const outputFile = path.join(runsDir, `profile-${runId}.json`);
		const args = ['record', '--format', 'speedscope', '--output', outputFile, '--'];

		const cmdParts = command.split(' ');
		args.push(...cmdParts);

		return new Promise<ProfileRun>((resolve, reject) => {
			const child = cp.spawn('py-spy', args, {
				cwd,
				stdio: 'inherit'
			});

			child.on('error', (err) => {
				reject(new Error(`Failed to spawn py-spy: ${err.message}`));
			});

			child.on('exit', async (code) => {
				try {
					if (!fs.existsSync(outputFile)) {
						throw new Error(`Profiler output file not found at ${outputFile}`);
					}
					const rawData = await fs.promises.readFile(outputFile, 'utf8');
					const speedscopeData = JSON.parse(rawData);
					const hotspots = this.parseSpeedscopeToHotspots(speedscopeData, runId);

					await this.saveHotspots(runsDir, runId, hotspots.hotspots);

					resolve({
						id: runId,
						createdAt: new Date().toISOString(),
						command,
						cwd,
						language: 'python',
						durationMs: hotspots.durationMs,
						samples: hotspots.totalSamples,
						exitCode: code
					});
				} catch (err) {
					reject(err);
				}
			});
		});
	}

	private async runNodeProfile(runId: string, runsDir: string, command: string, cwd: string): Promise<ProfileRun> {
		const outputFile = path.join(runsDir, `profile-${runId}.cpuprofile`);
		const cmdParts = command.split(' ');
		const executable = cmdParts[0];
		const scriptArgs = cmdParts.slice(1);

		// Inject profiler args
		// node --cpu-prof --cpu-prof-name=outputFile script.js ...
		const args = ['--cpu-prof', `--cpu-prof-name=${outputFile}`, ...scriptArgs];

		return new Promise<ProfileRun>((resolve, reject) => {
			const child = cp.spawn(executable, args, {
				cwd,
				stdio: 'inherit'
			});

			child.on('error', (err) => {
				reject(new Error(`Failed to spawn node: ${err.message}`));
			});

			child.on('exit', async (code) => {
				try {
					if (!fs.existsSync(outputFile)) {
						// Try to find it in cwd if node ignored the absolute path (can happen)
						const localOutput = path.join(cwd, path.basename(outputFile));
						if (fs.existsSync(localOutput)) {
							await fs.promises.rename(localOutput, outputFile);
						} else {
							throw new Error(`Profiler output file not found at ${outputFile}`);
						}
					}

					const rawData = await fs.promises.readFile(outputFile, 'utf8');
					const profileData = JSON.parse(rawData);
					const hotspots = this.parseCpuProfileToHotspots(profileData, runId);

					await this.saveHotspots(runsDir, runId, hotspots.hotspots);

					resolve({
						id: runId,
						createdAt: new Date().toISOString(),
						command,
						cwd,
						language: 'node',
						durationMs: hotspots.durationMs,
						samples: hotspots.totalSamples,
						exitCode: code
					});
				} catch (err) {
					reject(err);
				}
			});
		});
	}

	private async saveHotspots(runsDir: string, runId: string, hotspots: Hotspot[]) {
		const hotspotsFile = path.join(runsDir, `hotspots-${runId}.json`);
		// Wrap in { hotspots: ... } to match existing read format
		await fs.promises.writeFile(hotspotsFile, JSON.stringify({ hotspots }, null, 2));
	}

	async getProfileRuns(workspaceId: string): Promise<ProfileRun[]> {
		if (!this.storageHome) {
			return [];
		}
		const runsListFile = path.join(this.storageHome, workspaceId, 'profiler', 'runs.json');
		if (!fs.existsSync(runsListFile)) {
			return [];
		}
		try {
			return JSON.parse(await fs.promises.readFile(runsListFile, 'utf8'));
		} catch {
			return [];
		}
	}

	async getHotspots(workspaceId: string, runId: string): Promise<Hotspot[]> {
		if (!this.storageHome) {
			return [];
		}
		const hotspotsFile = path.join(this.storageHome, workspaceId, 'profiler', 'runs', `hotspots-${runId}.json`);
		if (!fs.existsSync(hotspotsFile)) {
			return [];
		}
		try {
			const data = JSON.parse(await fs.promises.readFile(hotspotsFile, 'utf8'));
			return data.hotspots;
		} catch {
			return [];
		}
	}

	private parseSpeedscopeToHotspots(data: any, runId: string): { hotspots: Hotspot[], totalSamples: number, durationMs: number } {
		const profile = data.profiles?.[0];
		if (!profile) {
			return { hotspots: [], totalSamples: 0, durationMs: 0 };
		}

		const frames = data.shared.frames;
		const samples = profile.samples;
		const weights = profile.weights;

		const totalDuration = weights.reduce((a: number, b: number) => a + b, 0);
		const totalSamples = samples.length;
		const frameStats = new Map<number, { self: number, total: number }>();

		samples.forEach((stack: number[], index: number) => {
			const weight = weights[index];
			if (stack.length > 0) {
				const leafFrame = stack[stack.length - 1];
				const stats = frameStats.get(leafFrame) || { self: 0, total: 0 };
				stats.self += weight;
				frameStats.set(leafFrame, stats);

				const uniqueFrames = new Set(stack);
				uniqueFrames.forEach(frameId => {
					const s = frameStats.get(frameId) || { self: 0, total: 0 };
					s.total += weight;
					frameStats.set(frameId, s);
				});
			}
		});

		const hotspots: Hotspot[] = [];
		frameStats.forEach((stats, frameId) => {
			const frame = frames[frameId];
			if (!frame) {
				return;
			}

			hotspots.push({
				runId,
				filePath: frame.file || '',
				functionName: frame.name,
				lineStart: frame.line,
				lineEnd: frame.line,
				cpuPercent: (stats.total / totalDuration) * 100,
				selfCpuPercent: (stats.self / totalDuration) * 100,
			});
		});

		hotspots.sort((a, b) => b.cpuPercent - a.cpuPercent);

		return {
			hotspots,
			totalSamples,
			durationMs: totalDuration * 1000
		};
	}

	private parseCpuProfileToHotspots(profile: any, runId: string): { hotspots: Hotspot[], totalSamples: number, durationMs: number } {
		// V8 .cpuprofile format
		const nodes = profile.nodes; // { id, callFrame, hitCount, children }
		// const timeDeltas = profile.timeDeltas || []; // Unused
		const startTime = profile.startTime;
		const endTime = profile.endTime;
		const durationUs = endTime - startTime; // microseconds

		// Calculate total hits
		let totalHits = 0;
		nodes.forEach((node: any) => {
			totalHits += (node.hitCount || 0);
		});

		if (totalHits === 0) {
			return { hotspots: [], totalSamples: 0, durationMs: durationUs / 1000 };
		}

		// Map node ID to node
		const nodeMap = new Map<number, any>();
		nodes.forEach((node: any) => nodeMap.set(node.id, node));

		// Calculate self hits
		const nodeStats = new Map<number, { self: number, total: number }>();

		// Initialize self hits from hitCount
		nodes.forEach((node: any) => {
			nodeStats.set(node.id, { self: node.hitCount || 0, total: 0 });
		});

		// Calculate total hits (inclusive) via bottom-up traversal?
		// Actually simpler: Propagate self-time up the tree for total time?
		// The "nodes" array is a tree structure with children IDs.

		// Recursive function to calculate total (inclusive) hits for a node
		const calculateTotal = (nodeId: number): number => {
			const node = nodeMap.get(nodeId);
			if (!node) {
				return 0;
			}

			const stats = nodeStats.get(nodeId)!;

			let childrenTotal = 0;
			// Note: A node's total hits = self hits + sum of children's total hits?
			// Not exactly in sampling profilers, because samples are leaves.
			// But V8 format `hitCount` implies a sample landed *exactly* in this frame.
			// So total hits for a frame = hits in this frame + hits in all descendant frames.

			// HOWEVER, nodes in V8 profile are call *sites*, so the tree structure is the call graph.
			// So yes, Total = Self + Sum(Children Total).

			if (node.children) {
				node.children.forEach((childId: number) => {
					childrenTotal += calculateTotal(childId);
				});
			}

			stats.total = stats.self + childrenTotal;
			return stats.total;
		};

		// Find root(s). Usually node with id 1 is root.
		// But we can just iterate all nodes since we need to calculate for all.
		// Wait, we need to avoid re-calculating.
		// The tree is directed. We can just start from root.
		const root = nodes.find((n: any) => n.id === 1) || nodes[0];
		if (root) {
			calculateTotal(root.id);
		}

		// Flatten to Hotspots
		const hotspots: Hotspot[] = [];

		nodeStats.forEach((stats, nodeId) => {
			const node = nodeMap.get(nodeId);
			// Filter out (garbage collector), (idle), (program), etc if desired
			// For now keep them but maybe filter root
			if (node.id === root.id) {
				return;
			}

			const callFrame = node.callFrame;
			if (!callFrame) {
				return;
			}

			hotspots.push({
				runId,
				filePath: callFrame.url || '',
				functionName: callFrame.functionName || '(anonymous)',
				lineStart: callFrame.lineNumber, // V8 uses 0-based? Usually 0-based.
				lineEnd: callFrame.lineNumber,
				cpuPercent: (stats.total / totalHits) * 100,
				selfCpuPercent: (stats.self / totalHits) * 100
			});
		});

		// Sort
		hotspots.sort((a, b) => b.cpuPercent - a.cpuPercent);

		// Fix 0-based line numbers if necessary (VS Code uses 1-based)
		hotspots.forEach(h => {
			if (h.lineStart !== null) {
				h.lineStart++;
			}
			if (h.lineEnd !== null) {
				h.lineEnd++;
			}
		});

		return {
			hotspots,
			totalSamples: totalHits,
			durationMs: durationUs / 1000
		};
	}
}

const server = new IPCServer('profiler');
const service = new ProfilerService();
const disposables = new DisposableStore();
server.registerChannel(ProfilerIpcChannels.Profiler, ProxyChannel.fromService(service, disposables));
