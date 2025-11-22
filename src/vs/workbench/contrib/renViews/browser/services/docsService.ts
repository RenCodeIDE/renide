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

export interface DirectoryDocs {
	uri: URI; // Directory URI
	content: string; // Markdown documentation
	format: "markdown";
	generatedAt: number;
	fileCount?: number; // Number of files included
	includedFiles?: URI[]; // List of files that were documented
}

export interface IDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateDocs: Event<string>;
	readonly onDidUpdateFileDocs: Event<FileDocs>;
	readonly onDidUpdateDirectoryDocs: Event<DirectoryDocs>;

	getLatestDocs(): string | undefined;
	generateDocs(trigger: "auto" | "manual"): Promise<string>;

	// File-level APIs
	generateDocsForFile(
		uri: URI,
		mode?: "initialize" | "regenerate"
	): Promise<FileDocs | undefined>;
	getFileDocs(uri: URI): FileDocs | undefined;
	removeDocsForFile(uri: URI): Promise<void>;

	// Directory-level APIs
	generateDocsForDirectory(
		uri: URI,
		mode?: "initialize" | "regenerate"
	): Promise<DirectoryDocs | undefined>;
	getDirectoryDocs(uri: URI): DirectoryDocs | undefined;
	removeDocsForDirectory(uri: URI): Promise<void>;
}
