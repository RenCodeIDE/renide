/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { IRange } from "../../../../../editor/common/core/range.js";

export const IChunkIndexService = createDecorator<IChunkIndexService>(
	"ren.chunkIndexService"
);

export interface SymbolRef {
	name: string;
	kind: string;
	uri: URI;
	range: IRange;
}

export interface FunctionPointer {
	name: string;
	uri: URI;
	range: IRange;
	signature?: string;
}

export interface ChunkRecord {
	uri: URI;
	hash: string;
	parentHash?: string;
	children?: string[];
	description?: string;
	refs: {
		symbols: SymbolRef[];
		files: URI[];
		functions: FunctionPointer[];
	};
	range?: IRange;
	updatedAt: number;
}

export interface IChunkIndexService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	getChunksForFile(uri: URI): Promise<ChunkRecord[]>;
	getChunk(chunkId: string): ChunkRecord | undefined;
	getChildren(chunkId: string): ChunkRecord[]; // Get child chunks
	getParent(chunkId: string): ChunkRecord | undefined; // Get sequential parent
	upsertChunk(record: ChunkRecord): Promise<void>;
	addChild(parentChunkId: string, childChunkId: string): Promise<void>;
	listFileChunks(uri: URI): ChunkRecord[];
	removeChunksForFile(uri: URI): Promise<void>;
}
