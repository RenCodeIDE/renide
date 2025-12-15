/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	DisposableStore,
} from "../../../../../../base/common/lifecycle.js";
import * as dom from "../../../../../../base/browser/dom.js";
import { IRenView } from "../renView.interface.js";
import { ILogService } from "../../../../../../platform/log/common/log.js";
import { IChatService } from "../../../../../contrib/chat/common/chatService.js";
import { IChatAgentService } from "../../../../../contrib/chat/common/chatAgents.js";
import { IAgentPlanner } from "../../../../../contrib/chat/common/agentPlanner.js";
import { IRenWorkspaceStore } from "../../../common/renWorkspaceStore.js";
import { IRenMonitorXChangelogBuffer } from "../../../common/renChangelogBuffer.js";
import { IEditorService } from "../../../../../services/editor/common/editorService.js";
import { IViewsService } from "../../../../../services/views/common/viewsService.js";
import { URI } from "../../../../../../base/common/uri.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../../../platform/workspace/common/workspace.js";
import { IChatRequestModel } from "../../../../../contrib/chat/common/chatModel.js";
import { ChatViewId } from "../../../../../contrib/chat/browser/chat.js";
import { ChatViewPane } from "../../../../../contrib/chat/browser/chatViewPane.js";
import { basename, relative as pathRelative } from "../../../../../../base/common/path.js";

interface ActiveAgentInfo {
	agentId: string;
	agentName: string;
	prompt: string;
	model: string | undefined;
	status: "running" | "idle" | "error";
	currentTask: string | undefined;
	requestId: string;
	sessionId: string;
}

interface RecentEditInfo {
	filePath: string;
	agentName: string | undefined;
	agentId: string | undefined;
	timestamp: number;
	description: string;
	subject: string;
	model: string | undefined;
}

interface ProjectRules {
	agentRules: {
		allowedFilePatterns?: string[];
		deniedFilePatterns?: string[];
		codingStandards?: string[];
		toolRestrictions?: string[];
		autoApproveRules?: Array<{ pattern: string; approve: boolean }>;
	};
	projectRules: {
		architectureConstraints?: string[];
		namingConventions?: string[];
		fileOrganization?: string[];
		dependencyRules?: string[];
	};
}

export class MonitorView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _contentContainer: HTMLElement | null = null;
	private _dynamicContainer: HTMLElement | null = null;
	private _rulesSectionEl: HTMLElement | null = null;
	private _refreshInterval: number | null = null;
	private _disposables = new DisposableStore();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IAgentPlanner private readonly agentPlanner: IAgentPlanner,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IRenMonitorXChangelogBuffer
		private readonly changelogBuffer: IRenMonitorXChangelogBuffer,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@IViewsService private readonly viewsService: IViewsService
	) {
		super();
	}

	show(contentArea: HTMLElement): void {
		this.logService.info("[MonitorView] show()");
		contentArea.textContent = "";

		this._mainContainer = document.createElement("div");
		this._mainContainer.className = "ren-monitor-container";
		this._mainContainer.style.display = "flex";
		this._mainContainer.style.flexDirection = "column";
		this._mainContainer.style.height = "100%";
		this._mainContainer.style.overflow = "hidden";

		const title = document.createElement("h2");
		title.textContent = "Monitor View";
		title.className = "ren-monitor-title";
		title.style.padding = "16px";
		title.style.margin = "0";
		title.style.borderBottom = "1px solid var(--vscode-panel-border)";
		this._mainContainer.appendChild(title);

		this._contentContainer = document.createElement("div");
		this._contentContainer.className = "ren-monitor-content";
		this._contentContainer.style.flex = "1";
		this._contentContainer.style.overflow = "auto";
		this._contentContainer.style.padding = "16px";
		this._mainContainer.appendChild(this._contentContainer);

		this._dynamicContainer = document.createElement("div");
		this._contentContainer.appendChild(this._dynamicContainer);

		// Render rules once (static section)
		this.renderRules(this.getRules());

		contentArea.appendChild(this._mainContainer);

		// Initial render
		this.updateView();

		// Set up auto-refresh every 2.5 seconds
		this._refreshInterval = window.setInterval(() => {
			this.updateView();
		}, 2500);

		// Listen to changes
		this._disposables.add(
			this.changelogBuffer.onDidChangeDraft(() => this.updateView())
		);
		this._disposables.add(
			this.workspaceStore.onDidChangeChangelog(() => this.updateView())
		);
	}

	hide(): void {
		this.logService.info("[MonitorView] hide()");
		if (this._refreshInterval !== null) {
			window.clearInterval(this._refreshInterval);
			this._refreshInterval = null;
		}
		this._disposables.clear();
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}

	private async updateView(): Promise<void> {
		if (!this._contentContainer) {
			return;
		}

		try {
			// Get all data
			const [activeAgents, recentEdits, projectDescription] = await Promise.all([
				this.getActiveAgents(),
				this.getRecentEdits(),
				this.getProjectDescription(),
			]);

			// Ensure dynamic container exists
			if (!this._dynamicContainer) {
				this._dynamicContainer = document.createElement("div");
				this._contentContainer.appendChild(this._dynamicContainer);
			}

			// Preserve scroll position while refreshing dynamic content
			const scrollTop = this._contentContainer.scrollTop;

			dom.clearNode(this._dynamicContainer);

			// Render dynamic sections
			this.renderProjectDescription(projectDescription, this._dynamicContainer);
			this.renderActiveAgents(activeAgents, this._dynamicContainer);
			this.renderRecentEdits(recentEdits, this._dynamicContainer);

			// Re-attach rules section if it was created
			if (this._rulesSectionEl && !this._rulesSectionEl.isConnected) {
				this._contentContainer.appendChild(this._rulesSectionEl);
			}

			// Restore scroll position
			this._contentContainer.scrollTop = scrollTop;
		} catch (error) {
			this.logService.error("[MonitorView] Failed to update view:", error);
			if (this._contentContainer) {
				const errorDiv = document.createElement("div");
				errorDiv.style.padding = "20px";
				errorDiv.style.color = "var(--vscode-errorForeground)";
				errorDiv.textContent = `Failed to load monitor data: ${
					error instanceof Error ? error.message : String(error)
				}`;
				this._contentContainer.appendChild(errorDiv);
			}
		}
	}

	private async getActiveAgents(): Promise<ActiveAgentInfo[]> {
		const history = await this.chatService.getHistory();
		const activeAgents: ActiveAgentInfo[] = [];

		for (const detail of history) {
			const session = this.chatService.getSession(detail.sessionId);
			if (!session) {
				continue;
			}
			const requests = session.getRequests();
			if (requests.length === 0) {
				continue;
			}

			const lastRequest = requests[requests.length - 1];
			const response = lastRequest.response;

			// Check if request is in progress
			const isInProgress = response?.isInProgress?.get() ?? false;
			if (!isInProgress && response?.isComplete) {
				continue; // Skip completed requests
			}

			const agentId = response?.agent?.id;
			if (!agentId) {
				continue;
			}

			const agent = this.chatAgentService.getAgent(agentId);
			if (!agent) {
				continue;
			}

			// Get plan and current task
			const plan = this.agentPlanner.getPlan(lastRequest.id);
			const currentTask = plan?.tasks.find((t) => t.status === "in_progress");

			// Get prompt text
			const promptText =
				typeof lastRequest.message === "string"
					? lastRequest.message
					: lastRequest.message.text || "";

			activeAgents.push({
				agentId: agent.id,
				agentName: agent.name || agentId,
				prompt: promptText,
				model: lastRequest.modelId,
				status: isInProgress ? "running" : "idle",
				currentTask: currentTask?.description,
				requestId: lastRequest.id,
				sessionId: session.sessionId,
			});
		}

		return activeAgents;
	}

	private async getRecentEdits(): Promise<RecentEditInfo[]> {
		const entries = await this.workspaceStore.getAllChangelogEntries();
		const drafts = this.changelogBuffer.listDrafts();
		const recentEdits: RecentEditInfo[] = [];

		// Get history once for all lookups
		const history = await this.chatService.getHistory();

		// Process confirmed entries
		for (const entry of entries) {
			const requestId = entry.metadata?.requestId as string | undefined;
			let agentName: string | undefined;
			let agentId: string | undefined;
			let model: string | undefined;

			if (requestId) {
				// Try to find session by requestId
				for (const detail of history) {
					const session = this.chatService.getSession(detail.sessionId);
					if (!session) {
						continue;
					}
					const requests = session.getRequests();
					const request = requests.find(
						(r: IChatRequestModel) => r.id === requestId
					);
					if (request) {
						const reqAgentId = request.response?.agent?.id;
						if (reqAgentId) {
							const agent = this.chatAgentService.getAgent(reqAgentId);
							if (agent) {
								agentName = agent.name || reqAgentId;
								agentId = agent.id;
							}
						}
						model = request.modelId;
						break;
					}
				}
			}

			// Add each file as a separate edit entry
			for (const file of entry.files) {
				recentEdits.push({
					filePath: file.path,
					agentName,
					agentId,
					timestamp: entry.timestamp,
					description: entry.description,
					subject: entry.subject,
					model,
				});
			}
		}

		// Process pending drafts
		for (const draft of drafts) {
			const sessionId = draft.sessionId;
			let agentName: string | undefined;
			let agentId: string | undefined;
			let model: string | undefined;

			const session = this.chatService.getSession(sessionId);
			if (session) {
				const requests = session.getRequests();
				if (requests.length > 0) {
					const lastRequest = requests[requests.length - 1];
					const reqAgentId = lastRequest.response?.agent?.id;
					if (reqAgentId) {
						const agent = this.chatAgentService.getAgent(reqAgentId);
						if (agent) {
							agentName = agent.name || reqAgentId;
							agentId = agent.id;
						}
					}
					model = lastRequest.modelId;
				}
			}

			for (const file of draft.files) {
				recentEdits.push({
					filePath: file.path,
					agentName,
					agentId,
					timestamp: draft.updatedAt,
					description: draft.description,
					subject: draft.subject,
					model,
				});
			}
		}

		// Sort by timestamp descending
		recentEdits.sort((a, b) => b.timestamp - a.timestamp);
		return recentEdits.slice(0, 50); // Limit to 50 most recent
	}

	private async getProjectDescription(): Promise<string | undefined> {
		// Get from workspace store
		return this.workspaceStore.getString("projectDescription") || undefined;
	}

	private getRules(): ProjectRules {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders && workspace.folders.length > 0) {
			const folder = workspace.folders[0];
			const key = `projectRules:${folder.uri.toString()}`;
			const stored = this.storageService.get(key, StorageScope.WORKSPACE);
			if (stored) {
				try {
					return JSON.parse(stored) as ProjectRules;
				} catch {
					// Invalid JSON, return defaults
				}
			}
		}
		return {
			agentRules: {},
			projectRules: {},
		};
	}

	private saveRules(rules: ProjectRules): void {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders && workspace.folders.length > 0) {
			const folder = workspace.folders[0];
			const key = `projectRules:${folder.uri.toString()}`;
			this.storageService.store(
				key,
				JSON.stringify(rules),
				StorageScope.WORKSPACE,
				StorageTarget.USER
			);
		}
	}

	private renderProjectDescription(description: string | undefined, container?: HTMLElement): void {
		const target = container ?? this._contentContainer;
		if (!target) {
			return;
		}
		const section = this.createSection("Project Description", true);

		if (description) {
			const content = document.createElement("div");
			content.style.padding = "12px";
			content.style.backgroundColor = "var(--vscode-textBlockQuote-background)";
			content.style.borderRadius = "4px";
			content.style.whiteSpace = "pre-wrap";
			content.style.fontSize = "13px";
			content.style.lineHeight = "1.6";
			content.textContent = description;
			section.appendChild(content);
		} else {
			const empty = document.createElement("div");
			empty.style.padding = "12px";
			empty.style.color = "var(--vscode-descriptionForeground)";
			empty.style.fontStyle = "italic";
			empty.textContent =
				"No project description available. Background agent will generate one when analyzing the project.";
			section.appendChild(empty);
		}

		target.appendChild(section);
	}

	private renderActiveAgents(agents: ActiveAgentInfo[], container?: HTMLElement): void {
		const target = container ?? this._contentContainer;
		if (!target) {
			return;
		}
		const section = this.createSection("Active Agents", true);

		// Parallel count badge
		const headerRow = document.createElement("div");
		headerRow.style.display = "flex";
		headerRow.style.alignItems = "center";
		headerRow.style.gap = "12px";
		headerRow.style.marginBottom = "12px";

		const badge = document.createElement("span");
		badge.textContent = `${agents.length} running in parallel`;
		badge.style.padding = "4px 8px";
		badge.style.borderRadius = "12px";
		badge.style.backgroundColor =
			agents.length > 0
				? "var(--vscode-badge-background)"
				: "var(--vscode-descriptionForeground)";
		badge.style.color = "var(--vscode-badge-foreground)";
		badge.style.fontSize = "11px";
		badge.style.fontWeight = "600";
		headerRow.appendChild(badge);

		section.appendChild(headerRow);

		if (agents.length === 0) {
			const empty = document.createElement("div");
			empty.style.padding = "12px";
			empty.style.color = "var(--vscode-descriptionForeground)";
			empty.style.fontStyle = "italic";
			empty.textContent = "No active agents";
			section.appendChild(empty);
		} else {
			for (const agent of agents) {
				const agentCard = this.createAgentCard(agent);
				section.appendChild(agentCard);
			}
		}

		target.appendChild(section);
	}

	private createAgentCard(agent: ActiveAgentInfo): HTMLElement {
		const card = document.createElement("div");
		card.style.marginBottom = "12px";
		card.style.padding = "12px";
		card.style.border = "1px solid var(--vscode-panel-border)";
		card.style.borderRadius = "4px";
		card.style.backgroundColor = "var(--vscode-sideBar-background)";
		card.style.cursor = "pointer";
		card.style.transition = "background-color 0.2s ease";

		// Add hover effect
		card.addEventListener("mouseenter", () => {
			card.style.backgroundColor = "var(--vscode-list-hoverBackground)";
		});
		card.addEventListener("mouseleave", () => {
			card.style.backgroundColor = "var(--vscode-sideBar-background)";
		});

		// Add click handler to open chat and load session
		card.addEventListener("click", async () => {
			try {
				this.logService.info(
					`[MonitorView] Opening chat for agent session: ${agent.sessionId}`
				);
				const chatViewPane = await this.viewsService.openView<ChatViewPane>(
					ChatViewId
				);
				if (chatViewPane) {
					await chatViewPane.loadSession(agent.sessionId);
					this.logService.info(
						`[MonitorView] Successfully loaded chat session: ${agent.sessionId}`
					);
				} else {
					this.logService.warn(`[MonitorView] Failed to open chat view pane`);
				}
			} catch (error) {
				this.logService.error(
					`[MonitorView] Error opening chat for session ${agent.sessionId}:`,
					error
				);
			}
		});

		// Header with agent name and status
		const header = document.createElement("div");
		header.style.display = "flex";
		header.style.justifyContent = "space-between";
		header.style.alignItems = "center";
		header.style.marginBottom = "8px";

		const name = document.createElement("div");
		name.style.fontWeight = "600";
		name.style.fontSize = "13px";
		name.textContent = agent.agentName;
		header.appendChild(name);

		const statusBadge = document.createElement("span");
		statusBadge.textContent =
			agent.status === "running" ? "● Running" : "○ Idle";
		statusBadge.style.fontSize = "11px";
		statusBadge.style.color =
			agent.status === "running"
				? "var(--vscode-terminal-ansiGreen)"
				: "var(--vscode-descriptionForeground)";
		header.appendChild(statusBadge);

		card.appendChild(header);

		// Model
		if (agent.model) {
			const model = document.createElement("div");
			model.style.fontSize = "11px";
			model.style.color = "var(--vscode-descriptionForeground)";
			model.style.marginBottom = "8px";
			model.textContent = `Model: ${agent.model}`;
			card.appendChild(model);
		}

		// Current task
		if (agent.currentTask) {
			const task = document.createElement("div");
			task.style.fontSize = "12px";
			task.style.marginBottom = "8px";
			task.style.padding = "8px";
			task.style.backgroundColor = "var(--vscode-textBlockQuote-background)";
			task.style.borderRadius = "4px";
			task.textContent = `Task: ${agent.currentTask}`;
			card.appendChild(task);
		}

		// Prompt (truncated)
		const prompt = document.createElement("details");
		// Prevent click from propagating to card (so expanding/collapsing doesn't open chat)
		prompt.addEventListener("click", (e) => {
			e.stopPropagation();
		});
		const promptSummary = document.createElement("summary");
		promptSummary.textContent = "Current Prompt";
		promptSummary.style.cursor = "pointer";
		promptSummary.style.fontSize = "12px";
		promptSummary.style.marginBottom = "4px";
		prompt.appendChild(promptSummary);

		const promptContent = document.createElement("div");
		promptContent.style.padding = "8px";
		promptContent.style.backgroundColor =
			"var(--vscode-textBlockQuote-background)";
		promptContent.style.borderRadius = "4px";
		promptContent.style.fontSize = "11px";
		promptContent.style.whiteSpace = "pre-wrap";
		promptContent.style.maxHeight = "200px";
		promptContent.style.overflow = "auto";
		promptContent.textContent = agent.prompt || "(No prompt)";
		prompt.appendChild(promptContent);

		card.appendChild(prompt);

		return card;
	}

	private renderRecentEdits(edits: RecentEditInfo[], container?: HTMLElement): void {
		const target = container ?? this._contentContainer;
		if (!target) {
			return;
		}
		const section = this.createSection("Recent File Edits", true);

		if (edits.length === 0) {
			const empty = document.createElement("div");
			empty.style.padding = "12px";
			empty.style.color = "var(--vscode-descriptionForeground)";
			empty.style.fontStyle = "italic";
			empty.textContent = "No recent edits";
			section.appendChild(empty);
		} else {
			const list = document.createElement("div");
			list.style.display = "flex";
			list.style.flexDirection = "column";
			list.style.gap = "8px";

			const MAX_RECENT_EDITS = 10;
			const displayEdits = edits.slice(0, MAX_RECENT_EDITS);
			for (const edit of displayEdits) {
				const editItem = this.createEditItem(edit);
				list.appendChild(editItem);
			}

			section.appendChild(list);

			if (edits.length > MAX_RECENT_EDITS) {
				const footer = document.createElement("div");
				footer.style.marginTop = "8px";
				footer.style.fontSize = "11px";
				footer.style.color = "var(--vscode-descriptionForeground)";
				footer.style.display = "flex";
				footer.style.alignItems = "center";
				footer.style.gap = "8px";

				const summary = document.createElement("span");
				summary.textContent = `Showing the latest ${MAX_RECENT_EDITS} edits.`;
				footer.appendChild(summary);

				const openChangelog = document.createElement("button");
				openChangelog.textContent = "Open Changelog";
				openChangelog.style.padding = "4px 8px";
				openChangelog.style.border = "1px solid var(--vscode-button-border)";
				openChangelog.style.borderRadius = "4px";
				openChangelog.style.background = "transparent";
				openChangelog.style.color = "var(--vscode-button-foreground)";
				openChangelog.style.cursor = "pointer";
				openChangelog.onclick = () => {
					this.openChangelogView();
				};

				footer.appendChild(openChangelog);
				section.appendChild(footer);
			}
		}

		target.appendChild(section);
	}

	private createEditItem(edit: RecentEditInfo): HTMLElement {
		const item = document.createElement("div");
		item.style.padding = "10px";
		item.style.border = "1px solid var(--vscode-panel-border)";
		item.style.borderRadius = "4px";
		item.style.backgroundColor = "var(--vscode-sideBar-background)";
		item.style.cursor = "pointer";
		item.style.transition = "background-color 0.2s";

		item.onmouseenter = () => {
			item.style.backgroundColor = "var(--vscode-list-hoverBackground)";
		};
		item.onmouseleave = () => {
			item.style.backgroundColor = "var(--vscode-sideBar-background)";
		};

		item.onclick = () => {
			try {
				const uri = URI.file(edit.filePath);
				this.editorService.openEditor({
					resource: uri,
					options: { revealIfOpened: true },
				});
			} catch (error) {
				this.logService.error("[MonitorView] Failed to open file:", error);
			}
		};

		// File path
		const filePath = document.createElement("div");
		filePath.style.fontWeight = "600";
		filePath.style.fontSize = "12px";
		filePath.style.marginBottom = "4px";
		const pathInfo = this.toRelativePath(edit.filePath);
		filePath.textContent = pathInfo.displayPath;
		filePath.title = pathInfo.tooltip;
		item.appendChild(filePath);

		// Meta info row
		const meta = document.createElement("div");
		meta.style.display = "flex";
		meta.style.gap = "12px";
		meta.style.fontSize = "11px";
		meta.style.color = "var(--vscode-descriptionForeground)";
		meta.style.marginBottom = "4px";

		if (edit.agentName) {
			const agent = document.createElement("span");
			agent.textContent = `Agent: ${edit.agentName}`;
			meta.appendChild(agent);
		}

		if (edit.model) {
			const model = document.createElement("span");
			model.textContent = `Model: ${edit.model}`;
			meta.appendChild(model);
		}

		const time = document.createElement("span");
		time.textContent = new Date(edit.timestamp).toLocaleString();
		meta.appendChild(time);

		item.appendChild(meta);

		// Description
		if (edit.description) {
			const desc = document.createElement("div");
			desc.style.fontSize = "11px";
			desc.style.marginTop = "4px";
			desc.style.color = "var(--vscode-descriptionForeground)";
			desc.textContent = edit.description;
			item.appendChild(desc);
		}

		return item;
	}

	private toRelativePath(
		absolutePath: string
	): { displayPath: string; tooltip: string } {
		try {
			const workspace = this.workspaceService.getWorkspace();
			const folder = workspace.folders?.[0];
			if (folder) {
				const root = folder.uri.fsPath;
				const rel = pathRelative(root, absolutePath);
				if (rel && !rel.startsWith("..")) {
					return { displayPath: rel, tooltip: absolutePath };
				}
			}
		} catch {
			// fall through
		}

		const displayPath = basename(absolutePath) || absolutePath;
		return { displayPath, tooltip: absolutePath };
	}

	private async openChangelogView(): Promise<void> {
		try {
			await this.viewsService.openView("workbench.view.monitorX.changelog", true);
		} catch (error) {
			this.logService.error("[MonitorView] Failed to open changelog view", error);
		}
	}

	private renderRules(rules: ProjectRules): void {
		const section = this.createSection("Rules Configuration", false);
		this._rulesSectionEl = section;

		const tabs = document.createElement("div");
		tabs.style.display = "flex";
		tabs.style.gap = "8px";
		tabs.style.marginBottom = "12px";
		tabs.style.borderBottom = "1px solid var(--vscode-panel-border)";

		let activeTab: "agent" | "project" = "agent";
		const agentTab = document.createElement("button");
		agentTab.textContent = "Agent Rules";
		agentTab.style.padding = "8px 16px";
		agentTab.style.border = "none";
		agentTab.style.borderBottom = "2px solid var(--vscode-button-foreground)";
		agentTab.style.backgroundColor = "transparent";
		agentTab.style.color = "var(--vscode-button-foreground)";
		agentTab.style.cursor = "pointer";
		agentTab.onclick = () => {
			activeTab = "agent";
			updateTabs();
			updateContent();
		};

		const projectTab = document.createElement("button");
		projectTab.textContent = "Project Rules";
		projectTab.style.padding = "8px 16px";
		projectTab.style.border = "none";
		projectTab.style.borderBottom = "2px solid transparent";
		projectTab.style.backgroundColor = "transparent";
		projectTab.style.color = "var(--vscode-descriptionForeground)";
		projectTab.style.cursor = "pointer";
		projectTab.onclick = () => {
			activeTab = "project";
			updateTabs();
			updateContent();
		};

		const updateTabs = () => {
			if (activeTab === "agent") {
				agentTab.style.borderBottomColor = "var(--vscode-button-foreground)";
				agentTab.style.color = "var(--vscode-button-foreground)";
				projectTab.style.borderBottomColor = "transparent";
				projectTab.style.color = "var(--vscode-descriptionForeground)";
			} else {
				projectTab.style.borderBottomColor = "var(--vscode-button-foreground)";
				projectTab.style.color = "var(--vscode-button-foreground)";
				agentTab.style.borderBottomColor = "transparent";
				agentTab.style.color = "var(--vscode-descriptionForeground)";
			}
		};

		tabs.appendChild(agentTab);
		tabs.appendChild(projectTab);
		section.appendChild(tabs);

		const contentArea = document.createElement("div");
		contentArea.style.minHeight = "200px";

		const textarea = document.createElement("textarea");
		textarea.style.width = "100%";
		textarea.style.minHeight = "200px";
		textarea.style.padding = "12px";
		textarea.style.fontFamily = "var(--vscode-editor-font-family)";
		textarea.style.fontSize = "12px";
		textarea.style.backgroundColor = "var(--vscode-input-background)";
		textarea.style.color = "var(--vscode-input-foreground)";
		textarea.style.border = "1px solid var(--vscode-input-border)";
		textarea.style.borderRadius = "4px";
		textarea.style.resize = "vertical";

		const updateContent = () => {
			if (activeTab === "agent") {
				textarea.value = JSON.stringify(rules.agentRules, null, 2);
			} else {
				textarea.value = JSON.stringify(rules.projectRules, null, 2);
			}
		};

		updateContent();
		contentArea.appendChild(textarea);

		const buttons = document.createElement("div");
		buttons.style.display = "flex";
		buttons.style.gap = "8px";
		buttons.style.marginTop = "12px";

		const saveButton = document.createElement("button");
		saveButton.textContent = "Save";
		saveButton.style.padding = "6px 12px";
		saveButton.style.borderRadius = "4px";
		saveButton.style.border = "1px solid var(--vscode-button-border)";
		saveButton.style.backgroundColor = "var(--vscode-button-background)";
		saveButton.style.color = "var(--vscode-button-foreground)";
		saveButton.style.cursor = "pointer";
		saveButton.onclick = () => {
			try {
				const newRules = JSON.parse(textarea.value);
				if (activeTab === "agent") {
					rules.agentRules = newRules;
				} else {
					rules.projectRules = newRules;
				}
				this.saveRules(rules);
				// Show success feedback
				saveButton.textContent = "Saved!";
				setTimeout(() => {
					saveButton.textContent = "Save";
				}, 2000);
			} catch (error) {
				// Show error feedback
				saveButton.textContent = "Invalid JSON";
				saveButton.style.backgroundColor = "var(--vscode-errorForeground)";
				setTimeout(() => {
					saveButton.textContent = "Save";
					saveButton.style.backgroundColor = "var(--vscode-button-background)";
				}, 2000);
			}
		};

		buttons.appendChild(saveButton);
		contentArea.appendChild(buttons);
		section.appendChild(contentArea);

		this._contentContainer!.appendChild(section);
	}

	private createSection(title: string, collapsible: boolean): HTMLElement {
		const section = document.createElement("div");
		section.style.marginBottom = "24px";

		const header = document.createElement("div");
		header.style.fontSize = "14px";
		header.style.fontWeight = "600";
		header.style.marginBottom = "12px";
		header.style.paddingBottom = "8px";
		header.style.borderBottom = "1px solid var(--vscode-panel-border)";
		header.textContent = title;
		section.appendChild(header);

		return section;
	}
}
