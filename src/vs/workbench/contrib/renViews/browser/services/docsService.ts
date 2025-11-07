import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";

export const IDocsService = createDecorator<IDocsService>("ren.docsService");

export interface FileDocs {
	uri: URI;
	content: string;
	format: "markdown";
	generatedAt: number;
}

export interface IDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateDocs: Event<string>;
	readonly onDidUpdateFileDocs: Event<FileDocs>;

	getLatestDocs(): string | undefined;
	generateDocs(trigger: "auto" | "manual"): Promise<string>;

	// File-level APIs
	generateDocsForFile(
		uri: URI,
		mode?: "initialize" | "regenerate"
	): Promise<FileDocs | undefined>;
	getFileDocs(uri: URI): FileDocs | undefined;
	removeDocsForFile(uri: URI): Promise<void>;
}
