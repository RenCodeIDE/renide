/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from './renView.interface.js';
import { IRenWorkspaceStore, IMonitorXChangelogEntry } from '../../common/renWorkspaceStore.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { renderMonitorXChangelog } from './monitorXChangelogRenderer.js';

interface ReactProjectInfo {
	isReactProject: boolean;
	packageManager: string;
	devScriptPresent: boolean;
	startScriptPresent: boolean;
	buildScriptPresent: boolean;
	devCommandRaw?: string;
	preferredPort?: number;
	packageJsonPath?: string;
}

export class MonitorXView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;

	constructor(
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore
	) {
		super();
	}

	async show(contentArea: HTMLElement): Promise<void> {
		contentArea.textContent = '';

		this._container = document.createElement('div');
		this._container.className = 'ren-monitorx-container';

		const title = document.createElement('h2');
		title.textContent = 'MonitorX Dashboard';
		title.className = 'ren-monitorx-title';

		const reactInfo = await this.detectReactProject();
		if (reactInfo) {
			const reactInfoDiv = document.createElement('div');
			reactInfoDiv.className = 'ren-monitorx-react-info';
			const scriptsInfo = document.createElement('div');
			scriptsInfo.className = 'ren-monitorx-scripts-info';

			if (reactInfo.buildScriptPresent) {
				const buildButton = document.createElement('button');
				buildButton.textContent = 'Build Project';
				buildButton.className = 'ren-monitorx-build-button';
				buildButton.onclick = () => this.runBuildScript(reactInfo);
				scriptsInfo.appendChild(buildButton);
			}

			const monitorButton = document.createElement('button');
			monitorButton.textContent = 'Open Browser Monitor';
			monitorButton.className = 'ren-monitorx-button';
			monitorButton.onclick = () => this.openBrowserPreview(reactInfo);
			scriptsInfo.appendChild(monitorButton);

			const helpText = document.createElement('p');
			helpText.textContent = 'Ensure package.json includes React dependencies and scripts (dev, start, or build) to take full advantage of MonitorX.';
			helpText.className = 'ren-monitorx-help-text';

			reactInfoDiv.appendChild(scriptsInfo);
			reactInfoDiv.appendChild(helpText);

			this._container.appendChild(title);
			this._container.appendChild(reactInfoDiv);
		} else {
			this._container.appendChild(title);
		}

		const changelogSection = document.createElement('section');
		changelogSection.className = 'ren-monitorx-changelog-section';

		const changelogTitle = document.createElement('h3');
		changelogTitle.textContent = 'Recent Changes';
		changelogTitle.className = 'ren-monitorx-changelog-title';

		const changelogBody = document.createElement('div');
		changelogBody.className = 'ren-monitorx-changelog-body';
		changelogSection.appendChild(changelogTitle);
		changelogSection.appendChild(changelogBody);
		this._container.appendChild(changelogSection);

		const updateChangelog = (entries: IMonitorXChangelogEntry[] | undefined) => {
			const data = entries ?? [];
			renderMonitorXChangelog(changelogBody, data, { emptyMessage: 'No MonitorX activity recorded yet.', limit: 10 });
		};

		updateChangelog(await this.workspaceStore.getRecentChangelogEntries(10));
		this._register(this.workspaceStore.onDidChangeChangelog(entries => updateChangelog(entries)));

		contentArea.appendChild(this._container);
	}

	private async detectReactProject(): Promise<ReactProjectInfo | null> {
		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return {
				isReactProject: false,
				packageManager: 'unknown',
				devScriptPresent: false,
				startScriptPresent: false,
				buildScriptPresent: false
			};
		}

		for (const folder of workspaceFolders) {
			const folderUri = folder.uri;
			const packageJsonUri = URI.joinPath(folderUri, 'package.json');
			try {
				await this.fileService.stat(packageJsonUri);
			} catch {
				continue;
			}

			const packageManager = await this.detectPackageManager(folderUri);
			if (packageManager) {
				const packageJsonContent = await this.fileService.readFile(packageJsonUri);
				const packageJson = JSON.parse(packageJsonContent.value.toString());
				const scriptsAny = packageJson.scripts ?? {};
				const devScriptPresent = typeof scriptsAny.dev === 'string';
				const startScriptPresent = typeof scriptsAny.start === 'string';
				const buildScriptPresent = typeof scriptsAny.build === 'string';
				const devCommandRaw = typeof scriptsAny.dev === 'string' ? scriptsAny.dev : undefined;
				const preferredPort = this.inferDevServerPort(devCommandRaw);
				return {
					isReactProject: true,
					packageManager,
					devScriptPresent,
					startScriptPresent,
					buildScriptPresent,
					devCommandRaw,
					preferredPort,
					packageJsonPath: packageJsonUri.fsPath
				};
			}
		}

		return null;
	}

	private async detectPackageManager(workspaceUri: URI): Promise<string> {
		const lockFiles = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'package-lock.json'];

		for (const lockFile of lockFiles) {
			const lockFileUri = URI.joinPath(workspaceUri, lockFile);
			try {
				await this.fileService.stat(lockFileUri);
				switch (lockFile) {
					case 'yarn.lock':
						return 'yarn';
					case 'pnpm-lock.yaml':
						return 'pnpm';
					case 'bun.lockb':
						return 'bun';
					case 'package-lock.json':
						return 'npm';
				}
			} catch {
				// ignore missing file
			}
		}

		return 'npm';
	}

	private async runBuildScript(reactInfo: ReactProjectInfo): Promise<void> {
		if (!reactInfo.buildScriptPresent) {
			return;
		}

		const command = `${reactInfo.packageManager} run build`;
		const folders = this.workspaceService.getWorkspace().folders;
		const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

		try {
			await this.commandService.executeCommand('workbench.action.terminal.new');
			if (cwd) {
				await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: `cd "${cwd}"\r` });
			}
			await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: command + '\r' });
		} catch (error) {
			console.error('Failed to run build script:', error);
		}
	}

	private async openBrowserPreview(reactInfo: ReactProjectInfo): Promise<void> {
		const port = reactInfo.preferredPort ?? 3000;
		const url = `http://localhost:${port}`;
		try {
			await this.commandService.executeCommand('workbench.action.focusSecondEditorGroup');
			await this.commandService.executeCommand('simpleBrowser.show', url, { viewColumn: 2, preserveFocus: false });
			return;
		} catch {
			try {
				await this.commandService.executeCommand('workbench.action.newGroupRight');
				await this.commandService.executeCommand('simpleBrowser.show', url, { viewColumn: 2, preserveFocus: false });
				return;
			} catch {
				// continue to fallbacks
			}
		}
		try {
			await this.commandService.executeCommand('workbench.action.openExternal', url);
			return;
		} catch {
			// continue to next fallback
		}
		try {
			await this.commandService.executeCommand('vscode.open', URI.parse(url));
		} catch (finalError) {
			console.error('Failed to open browser monitor:', finalError);
		}
	}

	private inferDevServerPort(devCommandRaw: string | undefined): number | undefined {
		if (!devCommandRaw) {
			return undefined;
		}
		const cmd = devCommandRaw.toLowerCase();
		if (cmd.includes('vite')) {
			return 5173;
		}
		if (cmd.includes('next')) {
			return 3000;
		}
		if (cmd.includes('react-scripts')) {
			return 3000;
		}
		if (cmd.includes('webpack-dev-server')) {
			return 8080;
		}
		if (cmd.includes('astro')) {
			return 4321;
		}
		if (cmd.includes('svelte')) {
			return 5173;
		}
		if (cmd.includes('vue-cli-service')) {
			return 8080;
		}
		return undefined;
	}

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
	}
}

