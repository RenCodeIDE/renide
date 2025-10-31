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
		if (reactInfo) {
			const reactInfoDiv = document.createElement('div');
			reactInfoDiv.className = 'ren-react-info';
			const scriptsInfo = document.createElement('div');
			scriptsInfo.className = 'ren-scripts-info';

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

			const helpText = document.createElement('p');
			helpText.textContent = 'Make sure you have a package.json file with React dependencies (react, react-dom) and appropriate scripts (dev, start, or build).';
			helpText.className = 'ren-help-text';

			reactInfoDiv.appendChild(scriptsInfo);

			this._container.appendChild(title);
			this._container.appendChild(reactInfoDiv);
		}

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
