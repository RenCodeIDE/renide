import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
// Editor resource accessor no longer needed here; group resource is supplied by caller
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

type EnvEntry = { key: string; value: string };

export class EnvOverlay extends Disposable {
	private readonly store = this._register(new DisposableStore());
	private container: HTMLElement | null = null;
	private tableBody: HTMLElement | null = null;
	private currentResource: URI | null = null;
	private currentEntries: EnvEntry[] = [];

	constructor(
		private readonly hostRoot: HTMLElement,
		private readonly getGroupResource: () => URI | undefined,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService
	) {
		super();
		this.attachListeners();
		this.refresh();
	}

	private attachListeners(): void {
		this.store.add(this.editorService.onDidActiveEditorChange(() => this.refresh()));
		this.store.add(this.editorService.onDidVisibleEditorsChange(() => this.refresh()));
	}

	private async refresh(): Promise<void> {
		const resource = this.getGroupResource();
		if (!resource || (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote)) {
			this.hide();
			return;
		}

		const name = basename(resource);
		if (!this.isDotEnvFilename(name)) {
			this.hide();
			return;
		}

		await this.show(resource);
	}

	private isDotEnvFilename(name: string): boolean {
		// Matches .env, .env.local, .env.development, .env.prod, etc.
		return name === '.env' || name.startsWith('.env.');
	}

	private async show(resource: URI): Promise<void> {
		this.currentResource = resource;
		const content = await this.safeRead(resource);
		const entries = this.parseEnv(content);
		this.currentEntries = entries;

		if (!this.container) {
			this.container = document.createElement('div');
			this.container.className = 'ren-env-overlay';

			const header = document.createElement('div');
			header.className = 'ren-env-overlay-header';
			header.textContent = 'Environment Variables';

			const table = document.createElement('div');
			table.className = 'ren-env-overlay-table';

			const headRow = document.createElement('div');
			headRow.className = 'ren-env-overlay-row ren-env-overlay-head';
			const keyHead = document.createElement('div');
			keyHead.className = 'ren-env-overlay-cell';
			keyHead.textContent = 'Name';
			const valHead = document.createElement('div');
			valHead.className = 'ren-env-overlay-cell';
			valHead.textContent = 'Value';
			headRow.appendChild(keyHead);
			headRow.appendChild(valHead);

			this.tableBody = document.createElement('div');
			this.tableBody.className = 'ren-env-overlay-body';

			table.appendChild(headRow);
			table.appendChild(this.tableBody);

			this.container.appendChild(header);
			this.container.appendChild(table);

			// Add actions
			const actions = document.createElement('div');
			actions.className = 'ren-env-overlay-actions';
			const addBtn = document.createElement('button');
			addBtn.textContent = 'Add variable';
			addBtn.className = 'ren-env-overlay-addbtn';
			addBtn.onclick = () => this.addRow();
			actions.appendChild(addBtn);
			this.container.appendChild(actions);

			const parent = this.findEditorContentRoot() ?? this.hostRoot;
			parent.appendChild(this.container);
		}

		this.renderRows();
	}

	private hide(): void {
		if (this.container) {
			this.container.remove();
			this.container = null;
			this.tableBody = null;
		}
	}

	private async safeRead(resource: URI): Promise<string> {
		try {
			const buffer = await this.fileService.readFile(resource);
			return buffer.value.toString();
		} catch {
			return '';
		}
	}

	private findEditorContentRoot(): HTMLElement | null {
		const candidates = this.hostRoot.querySelectorAll<HTMLElement>('.monaco-editor');
		for (const el of candidates) {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				return el;
			}
		}
		return null;
	}

	private parseEnv(content: string): EnvEntry[] {
		const lines = content.split(/\r?\n/);
		const result: EnvEntry[] = [];
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) {
				continue;
			}
			const eq = line.indexOf('=');
			if (eq <= 0) {
				continue;
			}
			const key = line.slice(0, eq).trim();
			let value = line.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
				value = value.slice(1, -1);
			}
			result.push({ key, value });
		}
		return result;
	}

	private serializeEnv(entries: EnvEntry[]): string {
		const lines: string[] = [];
		for (const { key, value } of entries) {
			if (!key) { continue; }
			const needsQuotes = /\s|#|=/.test(value);
			const val = needsQuotes ? '"' + value.replace(/"/g, '\\"') + '"' : value;
			lines.push(`${key}=${val}`);
		}
		return lines.join('\n') + '\n';
	}

	private renderRows(): void {
		if (!this.tableBody) { return; }
		this.tableBody.textContent = '';
		this.currentEntries.forEach((entry, index) => {
			const row = document.createElement('div');
			row.className = 'ren-env-overlay-row';

			const keyCell = document.createElement('div');
			keyCell.className = 'ren-env-overlay-cell ren-env-overlay-key';
			const keyInput = document.createElement('input');
			keyInput.className = 'ren-env-overlay-input';
			keyInput.value = entry.key;
			keyInput.placeholder = 'NAME';
			keyInput.onchange = () => this.updateKey(index, keyInput.value);
			keyCell.appendChild(keyInput);

			const valueCell = document.createElement('div');
			valueCell.className = 'ren-env-overlay-cell ren-env-overlay-value';
			const valueInput = document.createElement('input');
			valueInput.className = 'ren-env-overlay-input';
			valueInput.value = entry.value;
			valueInput.placeholder = 'value';
			valueInput.onchange = () => this.updateValue(index, valueInput.value);
			valueCell.appendChild(valueInput);

			row.appendChild(keyCell);
			row.appendChild(valueCell);
			this.tableBody!.appendChild(row);
		});
	}

	private async persist(): Promise<void> {
		if (!this.currentResource) { return; }
		const text = this.serializeEnv(this.currentEntries);
		const VSBuffer = (await import('../../../../base/common/buffer.js')).VSBuffer;
		await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(text));
	}

	private async updateKey(index: number, newKey: string): Promise<void> {
		this.currentEntries[index].key = newKey.trim();
		await this.persist();
		this.renderRows();
	}

	private async updateValue(index: number, newValue: string): Promise<void> {
		this.currentEntries[index].value = newValue;
		await this.persist();
	}

	private async addRow(): Promise<void> {
		this.currentEntries.push({ key: '', value: '' });
		this.renderRows();
	}
}
