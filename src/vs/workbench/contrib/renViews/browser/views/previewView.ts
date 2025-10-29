/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IRenView } from './renView.interface.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';

interface ReactProjectInfo {
	isReactProject: boolean;
	packageManager: string;
	devScriptPresent: boolean;
	startScriptPresent: boolean;
	buildScriptPresent: boolean;
	devCommandRaw?: string; // the actual command string for dev (e.g., "vite", "next dev")
	preferredPort?: number; // inferred dev server port
	packageJsonPath?: string;
}

export class PreviewView extends Disposable implements IRenView {
	private _container: HTMLElement | null = null;

	constructor(
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();
	}

	async show(contentArea: HTMLElement): Promise<void> {
		// Clear existing content safely
		contentArea.textContent = '';

		// Create elements instead of using innerHTML
		this._container = document.createElement('div');
		this._container.className = 'ren-preview-container';

		const title = document.createElement('h2');
		title.textContent = 'React Project Preview';
		title.className = 'ren-preview-title';

		// Detect React project
		const reactInfo = await this.detectReactProject();

		if (reactInfo.isReactProject) {
			const reactInfoDiv = document.createElement('div');
			reactInfoDiv.className = 'ren-react-info';

			const statusText = document.createElement('p');
			statusText.textContent = '✓ React project detected!';
			statusText.className = 'ren-react-status';

			const packageManagerText = document.createElement('p');
			packageManagerText.textContent = `Package Manager: ${reactInfo.packageManager}`;
			packageManagerText.className = 'ren-package-manager';

			const scriptsInfo = document.createElement('div');
			scriptsInfo.className = 'ren-scripts-info';

			// Show detected preview URL
			const previewUrl = `http://localhost:${reactInfo.preferredPort ?? 3000}`;
			const urlText = document.createElement('p');
			urlText.className = 'ren-help-text';
			urlText.textContent = `Preview URL: ${previewUrl}`;

			if (reactInfo.devScriptPresent || reactInfo.startScriptPresent) {
				const runButton = document.createElement('button');
				runButton.textContent = '> Run Development Server';
				runButton.className = 'ren-run-button';
				runButton.onclick = () => this.runDevelopmentServer(reactInfo);

				scriptsInfo.appendChild(runButton);
			}

			if (reactInfo.buildScriptPresent) {
				const buildButton = document.createElement('button');
				buildButton.textContent = 'Build Project';
				buildButton.className = 'ren-build-button';
				buildButton.onclick = () => this.runBuildScript(reactInfo);

				scriptsInfo.appendChild(buildButton);
			}

			const previewButton = document.createElement('button');
			previewButton.textContent = 'Open Browser Preview';
			previewButton.className = 'ren-preview-button';
			previewButton.onclick = () => this.openBrowserPreview(reactInfo);

			scriptsInfo.appendChild(previewButton);
			scriptsInfo.appendChild(urlText);

			reactInfoDiv.appendChild(statusText);
			reactInfoDiv.appendChild(packageManagerText);
			reactInfoDiv.appendChild(scriptsInfo);

			this._container.appendChild(title);
			this._container.appendChild(reactInfoDiv);
		} else {
			const notReactDiv = document.createElement('div');
			notReactDiv.className = 'ren-not-react';

			const statusText = document.createElement('p');
			statusText.textContent = 'X No React project detected in this workspace.';
			statusText.className = 'ren-not-react-status';

			const helpText = document.createElement('p');
			helpText.textContent = 'Make sure you have a package.json file with React dependencies (react, react-dom) and appropriate scripts (dev, start, or build).';
			helpText.className = 'ren-help-text';

			notReactDiv.appendChild(statusText);
			notReactDiv.appendChild(helpText);

			this._container.appendChild(title);
			this._container.appendChild(notReactDiv);
		}

		contentArea.appendChild(this._container);
	}

	private async detectReactProject(): Promise<ReactProjectInfo> {
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

		const rootFolder = workspaceFolders[0].uri;
		const packageJsonUri = URI.joinPath(rootFolder, 'package.json');

		try {
			const packageJsonContent = await this.fileService.readFile(packageJsonUri);
			const packageJson = JSON.parse(packageJsonContent.value.toString());

			// Check for React dependencies
			const dependencies = packageJson.dependencies || {};
			const devDependencies = packageJson.devDependencies || {};
			const hasReact = dependencies.react || dependencies['react-dom'] || devDependencies.react || devDependencies['react-dom'];

			if (!hasReact) {
				return {
					isReactProject: false,
					packageManager: 'unknown',
					devScriptPresent: false,
					startScriptPresent: false,
					buildScriptPresent: false
				};
			}

			// Detect package manager
			const packageManager = await this.detectPackageManager(rootFolder);

			// Extract scripts and infer dev server details
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
		} catch (error) {
			return {
				isReactProject: false,
				packageManager: 'unknown',
				devScriptPresent: false,
				startScriptPresent: false,
				buildScriptPresent: false
			};
		}
	}

	private async detectPackageManager(workspaceUri: URI): Promise<string> {
		// Check for lock files to determine package manager
		const lockFiles = [
			'yarn.lock',
			'pnpm-lock.yaml',
			'bun.lockb',
			'package-lock.json'
		];

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
				// File doesn't exist, continue
			}
		}

		return 'npm'; // Default fallback
	}

	private async runDevelopmentServer(reactInfo: ReactProjectInfo): Promise<void> {
		const scriptName = reactInfo.devScriptPresent ? 'dev' : (reactInfo.startScriptPresent ? 'start' : undefined);
		if (!scriptName) {
			return;
		}

		const command = `${reactInfo.packageManager} run ${scriptName}`;
		const folders = this.workspaceService.getWorkspace().folders;
		const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

		try {
			await this.commandService.executeCommand('workbench.action.terminal.new');
			if (cwd) {
				await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: `cd "${cwd}"\r` });
			}
			await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: command + '\r' });

			// Open the preview immediately; avoid CSP-blocked polling from workbench context
			this.openBrowserPreview(reactInfo);
		} catch (error) {
			console.error('Failed to run development server:', error);
		}
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
			// Try to focus an existing right group (split). If none exists, this is a no-op.
			await this.commandService.executeCommand('workbench.action.focusSecondEditorGroup');
			// Open Simple Browser in the second column if available
			await this.commandService.executeCommand('simpleBrowser.show', url, { viewColumn: 2, preserveFocus: false });
			return;
		} catch {
			// If focusing the group or opening failed, try creating a right split and open again
			try {
				await this.commandService.executeCommand('workbench.action.newGroupRight');
				await this.commandService.executeCommand('simpleBrowser.show', url, { viewColumn: 2, preserveFocus: false });
				return;
			} catch {
				// continue to fallbacks below
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
			console.error('Failed to open browser preview:', finalError);
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

	// Note: Avoid polling localhost from workbench due to CSP; simpleBrowser handles loading state

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
	}
}
