/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { Range } from "../../../../../editor/common/core/range.js";
import { URI } from "../../../../../base/common/uri.js";
import { formatChunkIdentifier } from "../../browser/services/chunkIndexServiceImpl.js";
import {
	buildChunkDependencyGraph,
	computeChunkLineBounds,
} from "../../browser/services/chunkVectorSync.js";
import { normalizeEndpoint } from "../../browser/services/chunkVectorClient.js";
import { ChunkRecord } from "../../browser/services/chunkIndexService.js";

suite("Ren Chunk Vectorization", () => {
	test("formatChunkIdentifier encodes segments and clamps ordinal", () => {
		const chunkId = formatChunkIdentifier(
			"my workspace",
			"src/features/example.ts",
			7.9
		);
		assert.strictEqual(
			chunkId,
			`${encodeURIComponent("my workspace")}:${encodeURIComponent(
				"src/features/example.ts"
			)}:7`
		);

		const zeroOrdinal = formatChunkIdentifier("ws", "file.ts", -3);
		assert.strictEqual(
			zeroOrdinal,
			`${encodeURIComponent("ws")}:${encodeURIComponent("file.ts")}:0`
		);
	});

	test("computeChunkLineBounds converts 1-based ranges to inclusive 0-based bounds", () => {
		const { startLine, endLine } = computeChunkLineBounds(
			new Range(12, 1, 18, 1)
		);

		assert.strictEqual(startLine, 11);
		assert.strictEqual(endLine, 17);
	});

	test("computeChunkLineBounds handles missing end line by defaulting to start", () => {
		// When only startLineNumber is provided, endLineNumber defaults to startLineNumber
		const { startLine, endLine } = computeChunkLineBounds(
			new Range(3, 1, 3, 1)
		);

		assert.strictEqual(startLine, 2);
		assert.strictEqual(endLine, 2);
	});

	test("computeChunkLineBounds handles undefined range", () => {
		const { startLine, endLine } = computeChunkLineBounds(undefined);

		assert.strictEqual(startLine, 0);
		assert.strictEqual(endLine, 0);
	});

	test("buildChunkDependencyGraph collects dependencies from record refs", () => {
		const sourceUri = URI.parse("file:///workspace/src/app.ts");
		const dependencyUri = URI.parse("file:///workspace/src/utils.ts");
		const record: ChunkRecord = {
			uri: sourceUri,
			hash: "merkle-123",
			ordinal: 1,
			refs: {
				symbols: [
					{
						name: "useUtils",
						kind: "function",
						uri: dependencyUri,
						range: new Range(5, 1, 5, 20),
					},
				],
				files: [dependencyUri],
				functions: [
					{
						name: "useUtils",
						uri: dependencyUri,
						range: new Range(5, 1, 5, 20),
						signature: "(arg: string) => string",
					},
				],
			},
			range: new Range(1, 1, 20, 1),
			updatedAt: Date.now(),
		};

		const graph = buildChunkDependencyGraph(record);
		assert.strictEqual(graph.files.length, 1);
		assert.strictEqual(graph.files[0], dependencyUri.toString());
		assert.strictEqual(graph.symbols.length, 1);
		assert.strictEqual(graph.symbols[0].name, "useUtils");
		assert.strictEqual(graph.functions.length, 1);
		assert.strictEqual(graph.functions[0].name, "useUtils");
		assert.deepStrictEqual(graph.symbols[0].range, {
			startLineNumber: 5,
			startColumn: 1,
			endLineNumber: 5,
			endColumn: 20,
		});
	});

	test("normalizeEndpoint avoids duplicate /api segments", () => {
		const url = normalizeEndpoint(
			"https://ren.example.com/api",
			"/api/code-chunks/search"
		);

		assert.strictEqual(url, "https://ren.example.com/api/code-chunks/search");
	});

	test("normalizeEndpoint appends endpoint when base has no api suffix", () => {
		const url = normalizeEndpoint(
			"https://ren.example.com/",
			"/api/code-chunks/upsert"
		);

		assert.strictEqual(
			url,
			"https://ren.example.com/api/code-chunks/upsert"
		);
	});
});

