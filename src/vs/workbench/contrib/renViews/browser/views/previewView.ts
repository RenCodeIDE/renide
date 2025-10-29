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
	devScript?: string;
	startScript?: string;
	buildScript?: string;
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

			if (reactInfo.devScript || reactInfo.startScript) {
				const runButton = document.createElement('button');
				runButton.textContent = '> Run Development Server';
				runButton.className = 'ren-run-button';
				runButton.onclick = () => this.runDevelopmentServer(reactInfo);

				scriptsInfo.appendChild(runButton);
			}

			if (reactInfo.buildScript) {
				const buildButton = document.createElement('button');
				buildButton.textContent = 'Build Project';
				buildButton.className = 'ren-build-button';
				buildButton.onclick = () => this.runBuildScript(reactInfo);

				scriptsInfo.appendChild(buildButton);
			}

			const previewButton = document.createElement('button');
			previewButton.textContent = 'Open Browser Preview';
			previewButton.className = 'ren-preview-button';
			previewButton.onclick = () => this.openBrowserPreview();

			scriptsInfo.appendChild(previewButton);

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
			return { isReactProject: false, packageManager: 'unknown' };
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
				return { isReactProject: false, packageManager: 'unknown' };
			}

			// Detect package manager
			const packageManager = await this.detectPackageManager(rootFolder);

			// Check if React is in devDependencies (prefer dev scripts)
			const isReactInDevDeps = devDependencies.react || devDependencies['react-dom'];

			// Extract scripts based on dependency type
			const scripts = packageJson.scripts || {};
			let devScript, startScript, buildScript;

			if (isReactInDevDeps) {
				// If React is in devDependencies, prefer dev scripts
				devScript = scripts.dev || scripts.start;
				startScript = scripts.start;
				buildScript = scripts.build;
			} else {
				// If React is in regular dependencies, use start scripts
				devScript = scripts.start || scripts.dev;
				startScript = scripts.start;
				buildScript = scripts.build;
			}

			return {
				isReactProject: true,
				packageManager,
				devScript,
				startScript,
				buildScript,
				packageJsonPath: packageJsonUri.fsPath
			};
		} catch (error) {
			return { isReactProject: false, packageManager: 'unknown' };
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
		const scriptToRun = reactInfo.devScript || reactInfo.startScript;
		if (!scriptToRun) {
			return;
		}

		const command = `${reactInfo.packageManager} run ${scriptToRun}`;

		// Execute the command in terminal
		try {
			await this.commandService.executeCommand('workbench.action.terminal.new');
			await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: command + '\r' });
		} catch (error) {
			console.error('Failed to run development server:', error);
		}
	}

	private async runBuildScript(reactInfo: ReactProjectInfo): Promise<void> {
		if (!reactInfo.buildScript) {
			return;
		}

		const command = `${reactInfo.packageManager} run ${reactInfo.buildScript}`;

		try {
			await this.commandService.executeCommand('workbench.action.terminal.new');
			await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: command + '\r' });
		} catch (error) {
			console.error('Failed to run build script:', error);
		}
	}

	private async openBrowserPreview(): Promise<void> {
		// Create a webview panel for browser preview
		try {
			// Use the simple browser extension's command
			await this.commandService.executeCommand('simpleBrowser.show', 'http://localhost:3000');
		} catch (error) {
			// Fallback: try to open external browser
			try {
				await this.commandService.executeCommand('vscode.open', URI.parse('http://localhost:3000'));
			} catch (fallbackError) {
				console.error('Failed to open browser preview:', error, fallbackError);
			}
		}
	}

	hide(): void {
		if (this._container) {
			this._container.remove();
			this._container = null;
		}
	}
}
