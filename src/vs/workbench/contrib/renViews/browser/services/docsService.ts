import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";

export const IDocsService = createDecorator<IDocsService>("ren.docsService");

export interface ChunkDocs {
	chunkId: string;
	content: string;
	format: "markdown";
	generatedAt: number;
}

export interface IDocsService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateDocs: Event<string>;
	readonly onDidUpdateChunkDocs: Event<ChunkDocs>;

	getLatestDocs(): string | undefined;
	generateDocs(trigger: "auto" | "manual"): Promise<string>;

	// File-level APIs
	generateDocsForFile(
		uri: URI,
		mode?: "initialize" | "regenerate"
	): Promise<ChunkDocs[]>;
	getChunkDocs(chunkId: string): ChunkDocs | undefined;
	listDocsForFile(uri: URI): ChunkDocs[];
	refreshChangedChunks(
		uri: URI,
		changedChunkHashes: string[]
	): Promise<ChunkDocs[]>;
	regenerateChunk(chunkId: string): Promise<ChunkDocs | undefined>;
	removeDocsForFile(uri: URI): Promise<void>;
}
