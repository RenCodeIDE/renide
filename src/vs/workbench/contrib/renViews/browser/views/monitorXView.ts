/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { IRenView } from "./renView.interface.js";
import {
	IRenWorkspaceStore,
	IMonitorXChangelogEntry,
} from "../../common/renWorkspaceStore.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import { ICommandService } from "../../../../../platform/commands/common/commands.js";
import { URI } from "../../../../../base/common/uri.js";
import { renderMonitorXChangelog } from "./monitorXChangelogRenderer.js";
import { IChatService, IChatDetail } from "../../../chat/common/chatService.js";
import { IMarkdownRendererService } from "../../../../../platform/markdown/browser/markdownRenderer.js";
import { MonitorXChatController } from "./monitorXChatController.js";

interface PackageJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

interface ReactProjectInfo {
	packageManager: string;
	devScriptPresent: boolean;
	startScriptPresent: boolean;
	buildScriptPresent: boolean;
	devCommandRaw?: string;
	preferredPort?: number;
	packageJsonPath?: string;
	workspaceLabel: string;
}

export class MonitorXView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;
	private _chatController: MonitorXChatController | undefined;
	private _chatHistoryContainer: HTMLElement | null = null;

	constructor(
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@IChatService private readonly chatService: IChatService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super();
	}

	async show(contentArea: HTMLElement): Promise<void> {
		contentArea.textContent = "";

		this._container = document.createElement("div");
		this._container.className = "ren-monitorx-container";

		const title = document.createElement("h2");
		title.textContent = "MonitorX Dashboard";
		title.className = "ren-monitorx-title";

		const reactInfo = await this.detectReactProject();
		if (reactInfo) {
			const reactInfoDiv = document.createElement("div");
			reactInfoDiv.className = "ren-monitorx-react-info";

			const projectLabel = document.createElement("div");
			projectLabel.className = "ren-monitorx-project-label";
			projectLabel.textContent = `Detected project: ${reactInfo.workspaceLabel}`;
			reactInfoDiv.appendChild(projectLabel);

			const packageManagerLabel = document.createElement("div");
			packageManagerLabel.className = "ren-monitorx-package-manager";
			packageManagerLabel.textContent = `Package manager: ${reactInfo.packageManager}`;
			reactInfoDiv.appendChild(packageManagerLabel);

			const scriptsInfo = document.createElement("div");
			scriptsInfo.className = "ren-monitorx-scripts-info";

			if (reactInfo.buildScriptPresent) {
				const buildButton = document.createElement("button");
				buildButton.textContent = "Build Project";
				buildButton.className = "ren-monitorx-build-button";
				buildButton.onclick = () => this.runBuildScript(reactInfo);
				scriptsInfo.appendChild(buildButton);
			}

			const monitorButton = document.createElement("button");
			monitorButton.textContent = "Open Browser Monitor";
			monitorButton.className = "ren-monitorx-button";
			monitorButton.onclick = () => this.openBrowserPreview(reactInfo);
			if (!reactInfo.devScriptPresent && !reactInfo.startScriptPresent) {
				monitorButton.disabled = true;
				monitorButton.title =
					"Add a dev or start script to package.json to enable quick preview.";
			}
			scriptsInfo.appendChild(monitorButton);

			const helpText = document.createElement("p");
			helpText.className = "ren-monitorx-help-text";
			helpText.textContent =
				reactInfo.devScriptPresent || reactInfo.startScriptPresent
					? "Launch a dev server with your existing npm scripts to preview the experience side-by-side."
					: "Add a `dev` or `start` script to package.json to enable quick preview controls in MonitorX.";

			reactInfoDiv.appendChild(scriptsInfo);
			reactInfoDiv.appendChild(helpText);
			if (!reactInfo.buildScriptPresent) {
				const buildHint = document.createElement("p");
				buildHint.className = "ren-monitorx-help-text";
				buildHint.textContent =
					"Add a `build` script to package.json to enable the quick Build button.";
				reactInfoDiv.appendChild(buildHint);
			}

			this._container.appendChild(title);
			this._container.appendChild(reactInfoDiv);
		} else {
			this._container.appendChild(title);
			const noReactMessage = document.createElement("p");
			noReactMessage.className = "ren-monitorx-no-react";
			noReactMessage.textContent =
				"No React or Next.js project detected in this workspace. Add React dependencies to your package.json and reload MonitorX to unlock build and monitor controls.";
			this._container.appendChild(noReactMessage);
		}

		const changelogSection = document.createElement("section");
		changelogSection.className = "ren-monitorx-changelog-section";

		const changelogTitle = document.createElement("h3");
		changelogTitle.textContent = "Recent Changes";
		changelogTitle.className = "ren-monitorx-changelog-title";

		const changelogBody = document.createElement("div");
		changelogBody.className = "ren-monitorx-changelog-body";
		changelogSection.appendChild(changelogTitle);
		changelogSection.appendChild(changelogBody);
		this._container.appendChild(changelogSection);

		const updateChangelog = (
			entries: IMonitorXChangelogEntry[] | undefined,
		) => {
			const data = entries ?? [];
			renderMonitorXChangelog(changelogBody, data, {
				emptyMessage: "No MonitorX activity recorded yet.",
				limit: 10,
			});
		};

		updateChangelog(await this.workspaceStore.getRecentChangelogEntries(10));
		this._register(
			this.workspaceStore.onDidChangeChangelog((entries) =>
				updateChangelog(entries),
			),
		);

		// Add chat section
		const chatSection = document.createElement("section");
		chatSection.className = "ren-monitorx-chat-section";

		const chatHeader = document.createElement("div");
		chatHeader.className = "ren-monitorx-chat-header";

		const chatTitle = document.createElement("h3");
		chatTitle.textContent = "AI Assistant";
		chatTitle.className = "ren-monitorx-chat-title";

		const newChatButton = document.createElement("button");
		newChatButton.textContent = "New Chat";
		newChatButton.className = "ren-monitorx-new-chat-button";
		newChatButton.onclick = () => this.startNewChat();

		chatHeader.appendChild(chatTitle);
		chatHeader.appendChild(newChatButton);
		chatSection.appendChild(chatHeader);

		// Chat history list
		const chatHistorySection = document.createElement("div");
		chatHistorySection.className = "ren-monitorx-chat-history";
		this._chatHistoryContainer = chatHistorySection;
		chatSection.appendChild(chatHistorySection);

		// Chat panel container
		const chatPanel = document.createElement("div");
		chatPanel.className = "ren-monitorx-chat-widget-container";
		chatSection.appendChild(chatPanel);

		this._container.appendChild(chatSection);
		contentArea.appendChild(this._container);

		// Initialize chat panel and render history
		this._chatController = this._register(
			new MonitorXChatController(
				chatPanel,
				this.chatService,
				this.markdownRendererService,
			),
		);
		await this._chatController.initialize();
		await this.renderChatHistory();
	}

	private async detectReactProject(): Promise<ReactProjectInfo | null> {
		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (!workspaceFolders.length) {
			return null;
		}

		let bestMatch: ReactProjectInfo | null = null;

		for (const folder of workspaceFolders) {
			const folderUri = folder.uri;
			const packageJsonUri = URI.joinPath(folderUri, "package.json");
			let packageJsonContent: string;
			try {
				await this.fileService.stat(packageJsonUri);
				packageJsonContent = (
					await this.fileService.readFile(packageJsonUri)
				).value.toString();
			} catch {
				continue;
			}

			let packageJson: PackageJson;
			try {
				packageJson = JSON.parse(packageJsonContent) as PackageJson;
			} catch (error) {
				console.warn(
					"MonitorXView: failed to parse package.json",
					packageJsonUri.fsPath,
					error,
				);
				continue;
			}

			if (!this.hasReactDependency(packageJson)) {
				continue;
			}

			const scriptsAny = packageJson.scripts ?? {};
			const devScript =
				typeof scriptsAny.dev === "string" ? scriptsAny.dev : undefined;
			const startScript =
				typeof scriptsAny.start === "string" ? scriptsAny.start : undefined;
			const buildScriptPresent = typeof scriptsAny.build === "string";
			const runCommand = devScript ?? startScript;
			const preferredPort = this.inferDevServerPort(runCommand);
			const packageManager = await this.detectPackageManager(folderUri);

			const candidate: ReactProjectInfo = {
				packageManager,
				devScriptPresent: !!devScript,
				startScriptPresent: !!startScript,
				buildScriptPresent,
				devCommandRaw: runCommand,
				preferredPort,
				packageJsonPath: packageJsonUri.fsPath,
				workspaceLabel: folder.name ?? folderUri.fsPath,
			};

			if (
				!bestMatch ||
				this.scoreReactProject(candidate) > this.scoreReactProject(bestMatch)
			) {
				bestMatch = candidate;
			}
		}

		return bestMatch;
	}

	private async detectPackageManager(workspaceUri: URI): Promise<string> {
		const lockFiles = [
			"yarn.lock",
			"pnpm-lock.yaml",
			"bun.lockb",
			"package-lock.json",
		];

		for (const lockFile of lockFiles) {
			const lockFileUri = URI.joinPath(workspaceUri, lockFile);
			try {
				await this.fileService.stat(lockFileUri);
				switch (lockFile) {
					case "yarn.lock":
						return "yarn";
					case "pnpm-lock.yaml":
						return "pnpm";
					case "bun.lockb":
						return "bun";
					case "package-lock.json":
						return "npm";
				}
			} catch {
				// ignore missing file
			}
		}

		return "npm";
	}

	private hasReactDependency(packageJson: PackageJson): boolean {
		const dependencyGroups = [
			packageJson?.dependencies ?? {},
			packageJson?.devDependencies ?? {},
			packageJson?.peerDependencies ?? {},
			packageJson?.optionalDependencies ?? {},
		];
		const reactSignals = new Set([
			"react",
			"react-dom",
			"react-native",
			"next",
			"gatsby",
			"remix",
			"@remix-run/react",
			"expo",
		]);

		for (const deps of dependencyGroups) {
			for (const name of Object.keys(deps)) {
				if (reactSignals.has(name) || name.startsWith("@remix-run/")) {
					return true;
				}
			}
		}

		return false;
	}

	private scoreReactProject(info: ReactProjectInfo): number {
		let score = 0;
		if (info.devScriptPresent) {
			score += 4;
		}
		if (info.startScriptPresent) {
			score += 2;
		}
		if (info.buildScriptPresent) {
			score += 1;
		}
		return score;
	}

	private async runBuildScript(reactInfo: ReactProjectInfo): Promise<void> {
		if (!reactInfo.buildScriptPresent) {
			return;
		}

		const command = `${reactInfo.packageManager} run build`;
		const folders = this.workspaceService.getWorkspace().folders;
		const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

		try {
			await this.commandService.executeCommand("workbench.action.terminal.new");
			if (cwd) {
				await this.commandService.executeCommand(
					"workbench.action.terminal.sendSequence",
					{ text: `cd "${cwd}"\r` },
				);
			}
			await this.commandService.executeCommand(
				"workbench.action.terminal.sendSequence",
				{ text: command + "\r" },
			);
		} catch (error) {
			console.error("Failed to run build script:", error);
		}
	}

	private async openBrowserPreview(reactInfo: ReactProjectInfo): Promise<void> {
		const port = reactInfo.preferredPort ?? 3000;
		const url = `http://localhost:${port}`;
		try {
			await this.commandService.executeCommand(
				"workbench.action.focusSecondEditorGroup",
			);
			await this.commandService.executeCommand("simpleBrowser.show", url, {
				viewColumn: 2,
				preserveFocus: false,
			});
			return;
		} catch {
			try {
				await this.commandService.executeCommand(
					"workbench.action.newGroupRight",
				);
				await this.commandService.executeCommand("simpleBrowser.show", url, {
					viewColumn: 2,
					preserveFocus: false,
				});
				return;
			} catch {
				// continue to fallbacks
			}
		}
		try {
			await this.commandService.executeCommand(
				"workbench.action.openExternal",
				url,
			);
			return;
		} catch {
			// continue to next fallback
		}
		try {
			await this.commandService.executeCommand("vscode.open", URI.parse(url));
		} catch (finalError) {
			console.error("Failed to open browser monitor:", finalError);
		}
	}

	private inferDevServerPort(
		devCommandRaw: string | undefined,
	): number | undefined {
		if (!devCommandRaw) {
			return undefined;
		}
		const cmd = devCommandRaw.toLowerCase();
		if (cmd.includes("vite")) {
			return 5173;
		}
		if (cmd.includes("next")) {
			return 3000;
		}
		if (cmd.includes("react-scripts")) {
			return 3000;
		}
		if (cmd.includes("webpack-dev-server")) {
			return 8080;
		}
		if (cmd.includes("astro")) {
			return 4321;
		}
		if (cmd.includes("svelte")) {
			return 5173;
		}
		if (cmd.includes("vue-cli-service")) {
			return 8080;
		}
		return undefined;
	}

	private async renderChatHistory(): Promise<void> {
		if (!this._chatHistoryContainer) {
			return;
		}

		// Clear existing history
		this._chatHistoryContainer.textContent = "";

		try {
			// Get chat history
			const history = await this.chatService.getHistory();

			// Sort by last message date, most recent first
			const sortedHistory = history.sort(
				(a: IChatDetail, b: IChatDetail) =>
					b.lastMessageDate - a.lastMessageDate,
			);

			// Limit to 10 most recent
			const recentHistory = sortedHistory.slice(0, 10);

			if (recentHistory.length === 0) {
				const emptyMessage = document.createElement("div");
				emptyMessage.textContent = "No past conversations";
				emptyMessage.className = "ren-monitorx-chat-history-empty";
				this._chatHistoryContainer.appendChild(emptyMessage);
				return;
			}

			const activeSessionId = this._chatController?.sessionId;

			// Create history list
			recentHistory.forEach((item: IChatDetail) => {
				const historyItem = document.createElement("div");
				historyItem.className = "ren-monitorx-chat-history-item";
				if (item.sessionId === activeSessionId) {
					historyItem.classList.add("active");
				}

				const title = document.createElement("div");
				title.className = "ren-monitorx-chat-history-title";
				title.textContent = item.title || "Untitled Chat";

				const date = document.createElement("div");
				date.className = "ren-monitorx-chat-history-date";
				date.textContent = new Date(item.lastMessageDate).toLocaleDateString();

				historyItem.appendChild(title);
				historyItem.appendChild(date);

				// Click to load session
				historyItem.onclick = () => {
					void this.loadChatSession(item.sessionId);
				};

				this._chatHistoryContainer!.appendChild(historyItem);
			});
		} catch (error) {
			console.error("Failed to render chat history:", error);
		}
	}

	private async loadChatSession(sessionId: string): Promise<void> {
		try {
			await this._chatController?.loadSession(sessionId);
			await this.renderChatHistory();
		} catch (error) {
			console.error("Failed to load chat session:", error);
		}
	}

	private async startNewChat(): Promise<void> {
		try {
			await this._chatController?.startNewSession();
			await this.renderChatHistory();
			this._chatController?.focusInput();
		} catch (error) {
			console.error("Failed to start new chat:", error);
		}
	}

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
		this._chatController = undefined;
		this._chatHistoryContainer = null;
	}
}
