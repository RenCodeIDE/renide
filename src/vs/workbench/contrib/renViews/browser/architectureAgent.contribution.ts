/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions,
} from "../../../common/contributions.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import { IArchitectureService } from "./services/architectureService.js";
import { IMerkleTreeService } from "../../../../platform/merkleTree/common/merkleTreeService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";

/**
 * Architecture Agent Contribution
 *
 * This background agent triggers architecture analysis when:
 * 1. The workspace is first opened (after LifecyclePhase.Restored)
 * 2. The Merkle tree root hash changes (significant file changes)
 *
 * The analysis runs in the background and caches results for instant display
 * when the user opens the graph view.
 */
export class ArchitectureAgentContribution
	extends Disposable
	implements IWorkbenchContribution
{
	static readonly ID = 'workbench.contrib.architectureAgent';

	/**
	 * Cooldown period between re-analyses (10 minutes)
	 */
	private readonly COOLDOWN_MS = 10 * 60 * 1000;

	/**
	 * Initial delay before starting analysis (wait for Merkle tree)
	 */
	private readonly INITIAL_DELAY_MS = 3000;

	/**
	 * Debounce time for Merkle tree changes
	 */
	private readonly DEBOUNCE_MS = 5000;

	/**
	 * Timestamp of last analysis
	 */
	private lastAnalysisTime = 0;

	/**
	 * Last known Merkle root hash
	 */
	private lastMerkleRootHash: string | undefined;

	/**
	 * Whether initial analysis has been triggered
	 */
	private initialAnalysisTriggered = false;

	/**
	 * Debounced handler for Merkle tree changes
	 */
	private readonly debouncedMerkleChange = new RunOnceScheduler(
		() => this.handleMerkleChangeDebounced(),
		this.DEBOUNCE_MS
	);

	constructor(
		@IArchitectureService private readonly architectureService: IArchitectureService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.logService.info('[ArchitectureAgent] Initializing...');

		// Schedule initial analysis after workspace is fully loaded
		this.scheduleInitialAnalysis();

		// Listen to Merkle tree changes for incremental updates
		this._register(
			this.merkleTreeService.onDidChangeTree(({ oldHash, newHash }) => {
				this.logService.debug(
					`[ArchitectureAgent] Merkle tree changed: ${oldHash?.substring(0, 8) || '(none)'}... → ${newHash?.substring(0, 8) || '(none)'}...`
				);
				this.debouncedMerkleChange.schedule();
			})
		);

		// Listen to workspace folder changes
		this._register(
			this.workspaceService.onDidChangeWorkspaceFolders(() => {
				this.logService.info('[ArchitectureAgent] Workspace folders changed, scheduling re-analysis');
				this.lastMerkleRootHash = undefined;
				this.scheduleInitialAnalysis();
			})
		);

		// Subscribe to analysis progress for logging
		this._register(
			this.architectureService.onAnalysisProgress(progress => {
				this.logService.debug(
					`[ArchitectureAgent] Progress: ${progress.phase} - ${progress.message} (${progress.progress}%)`
				);
			})
		);

		// Subscribe to analysis updates
		this._register(
			this.architectureService.onDidUpdateAnalysis(analysis => {
				this.logService.info(
					`[ArchitectureAgent] Analysis updated: ${analysis.nodes.length} nodes, ${analysis.edges.length} edges, type: ${analysis.codebaseType}`
				);
			})
		);
	}

	/**
	 * Schedule the initial analysis after workspace is ready
	 */
	private scheduleInitialAnalysis(): void {
		if (this.initialAnalysisTriggered) {
			return;
		}

		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this.logService.debug('[ArchitectureAgent] No workspace folders, skipping initial analysis');
			return;
		}

		this.logService.info(
			`[ArchitectureAgent] Scheduling initial analysis in ${this.INITIAL_DELAY_MS}ms...`
		);

		// Use setTimeout to allow Merkle tree to initialize
		setTimeout(() => {
			this.triggerAnalysis('workspace-open');
			this.initialAnalysisTriggered = true;
		}, this.INITIAL_DELAY_MS);
	}

	/**
	 * Handle debounced Merkle tree change
	 */
	private handleMerkleChangeDebounced(): void {
		const currentRootHash = this.merkleTreeService.rootHash;

		// Skip if hash hasn't actually changed
		if (currentRootHash === this.lastMerkleRootHash) {
			this.logService.debug('[ArchitectureAgent] Merkle hash unchanged, skipping');
			return;
		}

		// Check cooldown
		if (!this.hasCooldownExpired()) {
			const remainingMs = this.COOLDOWN_MS - (Date.now() - this.lastAnalysisTime);
			this.logService.debug(
				`[ArchitectureAgent] Cooldown not expired, ${Math.ceil(remainingMs / 1000)}s remaining`
			);
			return;
		}

		this.triggerAnalysis('merkle-change');
	}

	/**
	 * Trigger architecture analysis
	 */
	private async triggerAnalysis(reason: 'workspace-open' | 'merkle-change' | 'manual'): Promise<void> {
		// Skip if already analyzing
		if (this.architectureService.isAnalyzing()) {
			this.logService.debug('[ArchitectureAgent] Analysis already in progress, skipping');
			return;
		}

		// Check if workspace has folders
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this.logService.debug('[ArchitectureAgent] No workspace folders, skipping analysis');
			return;
		}

		this.logService.info(`[ArchitectureAgent] Triggering analysis (reason: ${reason})`);

		try {
			// Update tracking
			this.lastAnalysisTime = Date.now();
			this.lastMerkleRootHash = this.merkleTreeService.rootHash;

			// Run analysis (this is non-blocking for the UI)
			await this.architectureService.analyzeWorkspace('auto');

			this.logService.info('[ArchitectureAgent] Analysis completed successfully');
		} catch (error) {
			this.logService.error('[ArchitectureAgent] Analysis failed:', error);
		}
	}

	/**
	 * Check if cooldown period has expired
	 */
	private hasCooldownExpired(): boolean {
		return Date.now() - this.lastAnalysisTime >= this.COOLDOWN_MS;
	}

	/**
	 * Force re-analysis (for manual refresh)
	 */
	public async forceReanalysis(): Promise<void> {
		this.logService.info('[ArchitectureAgent] Forcing re-analysis');
		await this.architectureService.invalidateCache();
		this.lastAnalysisTime = 0;
		this.lastMerkleRootHash = undefined;
		await this.triggerAnalysis('manual');
	}

	override dispose(): void {
		this.debouncedMerkleChange.dispose();
		super.dispose();
	}
}

// Register the contribution
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench
);

workbenchRegistry.registerWorkbenchContribution(
	ArchitectureAgentContribution,
	LifecyclePhase.Restored
);

