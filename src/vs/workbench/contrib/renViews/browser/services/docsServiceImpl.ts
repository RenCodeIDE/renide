import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IDocsService } from './docsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

const STORAGE_KEY = 'ren.docs.latest';

export class DocsService extends Disposable implements IDocsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdateDocs = this._register(new Emitter<string>());
	readonly onDidUpdateDocs = this._onDidUpdateDocs.event;

	private latest: string | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.latest = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, undefined);
	}

	getLatestDocs(): string | undefined {
		return this.latest;
	}

	async generateDocs(trigger: 'auto' | 'manual'): Promise<string> {
		// TODO: Replace with real server call. For now, produce placeholder content.
		const now = new Date().toISOString();
		const content = `Generated docs (${trigger}) at ${now}.\n\nThis is placeholder content.`;
		this.latest = content;
		this.storageService.store(STORAGE_KEY, content, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidUpdateDocs.fire(content);
		return content;
	}
}

registerSingleton(IDocsService, DocsService, InstantiationType.Delayed);


