/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProfilerService, ERROR_UNSUPPORTED_LANGUAGE } from '../../../../platform/profiler/common/profiler.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import * as path from '../../../../base/common/path.js';

export class RunCustomProfileAction extends Action2 {
	constructor() {
		super({
			id: 'ren.profile.runCustom',
			title: { value: localize('ren.profile.runCustom', "Run Custom Profile..."), original: 'Run Custom Profile...' },
			f1: true,
			category: { value: localize('ren', "Ren IDE"), original: 'Ren IDE' }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const profilerService = accessor.get(IProfilerService);
		const quickInputService = accessor.get(IQuickInputService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);
		const editorService = accessor.get(IEditorService);

		const workspaceFolders = workspaceService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			notificationService.warn('Please open a workspace first.');
			return;
		}

		const workspaceRoot = workspaceFolders[0].uri.fsPath;
		const workspaceId = workspaceFolders[0].uri.toString();

		// 1. Pick File
		const filePick = await quickInputService.pick(this.getFilePicks(workspaceFolders[0].uri, accessor), {
			placeHolder: 'Select a file to profile',
			title: 'Run Profiler'
		});

		if (!filePick) {
			return;
		}

		const filePath = filePick.description!;
		const ext = path.extname(filePath);
		let suggestedCommand = '';

		if (ext === '.py') {
			suggestedCommand = `python ${filePath}`;
		} else if (ext === '.js') {
			suggestedCommand = `node ${filePath}`;
		} else if (ext === '.ts') {
			suggestedCommand = `ts-node ${filePath}`;
		} else {
			suggestedCommand = filePath; // Fallback
		}

		// 2. Confirm/Edit Command
		const command = await quickInputService.input({
			value: suggestedCommand,
			placeHolder: 'e.g. python script.py or node script.js',
			prompt: 'Confirm or edit the command to run',
			title: 'Profile Command'
		});

		if (!command) {
			return;
		}

		notificationService.info(`Starting profile: ${command}`);

		try {
			const run = await profilerService.runProfile(command, workspaceRoot, workspaceId);

			notificationService.info(`Profile complete. Duration: ${run.durationMs.toFixed(0)}ms, Samples: ${run.samples}`);

			const hotspots = await profilerService.getHotspots(workspaceId, run.id);

			// Generate Report Content
			const reportContent = [
				`# Profiling Report: ${command}`,
				`Date: ${new Date(run.createdAt).toLocaleString()}`,
				`Duration: ${run.durationMs.toFixed(0)}ms | Samples: ${run.samples}`,
				``,
				`## Top Hotspots`,
				``,
				`| Function | Location | Total Time | Self Time |`,
				`| :--- | :--- | :--- | :--- |`,
				...hotspots.slice(0, 50).map(h => {
					const name = h.functionName || '(anonymous)';
					const location = `[${h.filePath}:${h.lineStart}](file://${path.join(workspaceRoot, h.filePath)}#${h.lineStart})`;
					const total = `${h.cpuPercent.toFixed(1)}%`;
					const self = `${h.selfCpuPercent.toFixed(1)}%`;
					return `| \`${name}\` | ${location} | ${total} | ${self} |`;
				})
			].join('\n');

			// Open in Untitled Editor (Markdown)
			await editorService.openEditor({
				resource: undefined,
				contents: reportContent,
				languageId: 'markdown',
				options: {
					pinned: true
				}
			});

		} catch (err) {
			if ((err as Error).message.includes(ERROR_UNSUPPORTED_LANGUAGE)) {
				notificationService.info('Profiling for this language is not currently supported. Supported languages: Python, Node.js.');
			} else {
				notificationService.error(`Profile failed: ${err}`);
			}
		}
	}

	private async getFilePicks(root: URI, accessor: ServicesAccessor): Promise<IQuickPickItem[]> {
		// This is a simplified file picker. In a real scenario, we'd use IFileService to search.
		// For MVP, we can try to show recently opened files or just let user type.
		// But `quickInputService.pick` can take a promise.

		// Let's use the quick open provider or similar logic?
		// Actually, let's just use a "Type file path" approach combined with some heuristics if possible,
		// or reuse QuickOpen.
		// Since I cannot easily reuse QuickOpen internal logic here, I will implement a basic search for common entry points
		// or just ask the user to pick from currently open editors + some defaults.

		const editorService = accessor.get(IEditorService);
		const picks: IQuickPickItem[] = [];

		// Add currently open files
		editorService.editors.forEach(editor => {
			const resource = editor.resource;
			if (resource && (resource.path.endsWith('.py') || resource.path.endsWith('.js') || resource.path.endsWith('.ts'))) {
				const label = path.basename(resource.path);
				// Use relative path for description if possible
				// For now just use the path
				picks.push({
					label: label,
					description: resource.fsPath, // Use fsPath for command generation
					detail: 'Open Editor'
				});
			}
		});

		// Add an option to browse/type manually?
		// For MVP, just listing open files is a huge improvement.
		// If no open files, maybe we can suggest "Type filename..." but quickPick requires items.

		if (picks.length === 0) {
			return [{
				label: 'No supported files open',
				description: '',
				detail: 'Please open a .py, .js, or .ts file to profile.'
			}];
		}

		return picks;
	}
}

registerAction2(RunCustomProfileAction);
