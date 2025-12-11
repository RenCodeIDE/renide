/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { isString } from "../../../../../base/common/types.js";
import { streamToBuffer } from "../../../../../base/common/buffer.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import {
	IRequestService,
	isSuccess,
} from "../../../../../platform/request/common/request.js";
import { IRequestOptions } from "../../../../../base/parts/request/common/request.js";

export interface ChunkVectorMetadata {
	chunkId: string;
	userName: string;
	projectHash: string;
	filePath: string;
	startLine: number;
	endLine: number;
	ordinal: number;
	merkleHash: string;
	parentHash?: string;
}

export interface ChunkVectorDependencyRange {
	startLineNumber?: number;
	startColumn?: number;
	endLineNumber?: number;
	endColumn?: number;
}

export interface ChunkVectorDependencySymbol {
	name: string;
	kind: string;
	uri: string;
	range?: ChunkVectorDependencyRange;
}

export interface ChunkVectorDependencyFunction {
	name: string;
	uri: string;
	signature?: string;
	range?: ChunkVectorDependencyRange;
}

export interface ChunkVectorDependencyGraph {
	files: string[];
	symbols: ChunkVectorDependencySymbol[];
	functions: ChunkVectorDependencyFunction[];
}

export interface ChunkVectorUpsertPayload {
	code: string;
	metadata: ChunkVectorMetadata;
	dependencyGraph: ChunkVectorDependencyGraph;
}

export interface ChunkVectorSearchRequest {
	query: string;
	projectHash: string;
	limit?: number;
}

export interface ChunkVectorSearchResult {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	merkleHash?: string;
	dependencyGraph?: ChunkVectorDependencyGraph;
	ordinal?: number | null;
	parentHash?: string | null;
	userName?: string;
}

export interface ChunkVectorClientParams {
	requestService: IRequestService;
	serverAddress: string;
	accessToken: string;
	logService?: ILogService;
	token?: CancellationToken;
}

const VECTOR_UPSERT_ENDPOINT = "/api/code-chunks/upsert";
const VECTOR_SEARCH_ENDPOINT = "/api/code-chunks/search";

export async function upsertChunkVector(
	params: ChunkVectorClientParams,
	payload: ChunkVectorUpsertPayload
): Promise<void> {
	const { requestService, serverAddress, accessToken, logService } = params;
	const token = params.token ?? CancellationToken.None;

	const url = normalizeEndpoint(serverAddress, VECTOR_UPSERT_ENDPOINT);
	const body = JSON.stringify(payload);

	if (!accessToken) {
		throw new Error(
			"Authentication token is required to upsert chunk vectors."
		);
	}

	logService?.debug(
		`[ChunkVectorClient] Upserting chunk ${payload.metadata.chunkId} to ${url}`
	);

	const context = await requestService.request(
		buildRequestOptions(url, accessToken, body),
		token
	);

	if (!isSuccess(context)) {
		const message = await readErrorMessage(context, logService);
		throw new Error(message);
	}

	// Drain response body to avoid leaking the stream; ignore content.
	try {
		await streamToBuffer(context.stream);
	} catch {
		// ignore stream read errors on success
	}

	logService?.debug(
		`[ChunkVectorClient] Successfully upserted chunk ${payload.metadata.chunkId}`
	);
}

export async function searchChunkVectors(
	params: ChunkVectorClientParams,
	request: ChunkVectorSearchRequest
): Promise<ChunkVectorSearchResult[]> {
	const { requestService, serverAddress, accessToken, logService } = params;
	const token = params.token ?? CancellationToken.None;

	const url = normalizeEndpoint(serverAddress, VECTOR_SEARCH_ENDPOINT);
	const body = JSON.stringify(request);

	if (!accessToken) {
		throw new Error(
			"Authentication token is required to search chunk vectors."
		);
	}

	logService?.debug(
		`[ChunkVectorClient] Searching chunk vectors at ${url} (query="${
			request.query
		}", limit=${request.limit ?? "default"})`
	);

	const context = await requestService.request(
		buildRequestOptions(url, accessToken, body),
		token
	);

	const buffer = await streamToBuffer(context.stream);
	const responseText = buffer.toString();

	if (!isSuccess(context)) {
		const message = await parseJsonError(responseText, context.res?.statusCode);
		logService?.error(
			`[ChunkVectorClient] Search failed (${
				context.res?.statusCode ?? "unknown"
			}): ${message}`
		);
		throw new Error(message);
	}

	try {
		const parsed = JSON.parse(responseText);
		const rawResults: unknown[] = Array.isArray(parsed?.results)
			? parsed.results
			: [];
		return rawResults
			.filter((item): item is Record<string, unknown> => {
				return !!item && typeof item === "object";
			})
			.map((item) => {
				const rawStartLine = item.startLine;
				const rawEndLine = item.endLine;
				const rawScore = item.score;
				const rawDependencyGraph = item.dependencyGraph;
				const rawSymbols = (rawDependencyGraph as any)?.symbols;
				const rawFunctions = (rawDependencyGraph as any)?.functions;
				const rawFiles = (rawDependencyGraph as any)?.files;

				const startLine =
					typeof rawStartLine === "number" && Number.isFinite(rawStartLine)
						? Math.max(0, Math.floor(rawStartLine))
						: 0;
				const endLine =
					typeof rawEndLine === "number" && Number.isFinite(rawEndLine)
						? Math.max(startLine, Math.floor(rawEndLine))
						: startLine;
				const score =
					typeof rawScore === "number" && Number.isFinite(rawScore)
						? rawScore
						: 0;

				return {
					id: String(item.id ?? ""),
					filePath: String(item.filePath ?? ""),
					startLine,
					endLine,
					score,
					ordinal:
						typeof item.ordinal === "number" && Number.isFinite(item.ordinal)
							? Math.max(0, Math.floor(item.ordinal))
							: null,
					merkleHash:
						typeof item.merkleHash === "string" ? item.merkleHash : undefined,
					parentHash:
						typeof item.parentHash === "string" ? item.parentHash : null,
					userName:
						typeof item.userName === "string" ? item.userName : undefined,
					dependencyGraph: {
						files: Array.isArray(rawFiles)
							? rawFiles.filter((candidate): candidate is string => {
									return typeof candidate === "string";
							  })
							: [],
						symbols: Array.isArray(rawSymbols)
							? rawSymbols
									.filter(
										(candidate): candidate is Record<string, unknown> =>
											!!candidate && typeof candidate === "object"
									)
									.map((candidate) => ({
										name:
											typeof candidate.name === "string" ? candidate.name : "",
										kind:
											typeof candidate.kind === "string" ? candidate.kind : "",
										uri: typeof candidate.uri === "string" ? candidate.uri : "",
										range:
											typeof candidate.range === "object" &&
											candidate.range !== null
												? {
														startLineNumber: Number.isFinite(
															(candidate.range as any)?.startLineNumber
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).startLineNumber
																	)
															  )
															: undefined,
														startColumn: Number.isFinite(
															(candidate.range as any)?.startColumn
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).startColumn
																	)
															  )
															: undefined,
														endLineNumber: Number.isFinite(
															(candidate.range as any)?.endLineNumber
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).endLineNumber
																	)
															  )
															: undefined,
														endColumn: Number.isFinite(
															(candidate.range as any)?.endColumn
														)
															? Math.max(
																	0,
																	Math.floor((candidate.range as any).endColumn)
															  )
															: undefined,
												  }
												: undefined,
									}))
							: [],
						functions: Array.isArray(rawFunctions)
							? rawFunctions
									.filter(
										(candidate): candidate is Record<string, unknown> =>
											!!candidate && typeof candidate === "object"
									)
									.map((candidate) => ({
										name:
											typeof candidate.name === "string" ? candidate.name : "",
										uri: typeof candidate.uri === "string" ? candidate.uri : "",
										signature:
											typeof candidate.signature === "string"
												? candidate.signature
												: undefined,
										range:
											typeof candidate.range === "object" &&
											candidate.range !== null
												? {
														startLineNumber: Number.isFinite(
															(candidate.range as any)?.startLineNumber
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).startLineNumber
																	)
															  )
															: undefined,
														startColumn: Number.isFinite(
															(candidate.range as any)?.startColumn
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).startColumn
																	)
															  )
															: undefined,
														endLineNumber: Number.isFinite(
															(candidate.range as any)?.endLineNumber
														)
															? Math.max(
																	0,
																	Math.floor(
																		(candidate.range as any).endLineNumber
																	)
															  )
															: undefined,
														endColumn: Number.isFinite(
															(candidate.range as any)?.endColumn
														)
															? Math.max(
																	0,
																	Math.floor((candidate.range as any).endColumn)
															  )
															: undefined,
												  }
												: undefined,
									}))
							: [],
					},
				};
			});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error ?? "Unknown error");
		logService?.error(
			`[ChunkVectorClient] Failed to parse search response: ${message}`
		);
		throw new Error(
			`Failed to parse vector search response: ${message || "Invalid JSON"}`
		);
	}
}

export function normalizeEndpoint(
	serverAddress: string,
	endpoint: string
): string {
	const normalizedAddress = serverAddress.trim().replace(/\/+$/, "");
	if (normalizedAddress.endsWith("/api") && endpoint.startsWith("/api/")) {
		return `${normalizedAddress}${endpoint.substring(4)}`;
	}
	return `${normalizedAddress}${endpoint}`;
}

function buildRequestOptions(
	url: string,
	accessToken: string,
	body: string
): IRequestOptions {
	return {
		type: "POST",
		url,
		data: body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		timeout: 60_000,
	};
}

async function readErrorMessage(
	context: Awaited<ReturnType<IRequestService["request"]>>,
	logService?: ILogService
): Promise<string> {
	try {
		const buffer = await streamToBuffer(context.stream);
		const responseText = buffer.toString();
		const message = await parseJsonError(responseText, context.res?.statusCode);
		logService?.error(
			`[ChunkVectorClient] Request failed (${
				context.res?.statusCode ?? "unknown"
			}): ${message}`
		);
		return message;
	} catch (error) {
		const fallback =
			error instanceof Error ? error.message : "Unknown request failure";
		logService?.error(
			`[ChunkVectorClient] Failed to read error stream: ${fallback}`
		);
		return fallback;
	}
}

async function parseJsonError(
	responseText: string,
	statusCode?: number
): Promise<string> {
	if (responseText) {
		try {
			const parsed = JSON.parse(responseText);
			const message =
				(isString(parsed?.message) && parsed.message) ||
				(isString(parsed?.error?.message) && parsed.error.message);
			if (message) {
				return message;
			}
		} catch {
			// fall through to default
		}
	}

	const statusLabel = statusCode ? ` (${statusCode})` : "";
	return `Vector service request failed${statusLabel}`;
}
