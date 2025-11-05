import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';

export const IDocsService = createDecorator<IDocsService>('ren.docsService');

export interface IDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateDocs: Event<string>;
	getLatestDocs(): string | undefined;
	generateDocs(trigger: 'auto' | 'manual'): Promise<string>;
}


