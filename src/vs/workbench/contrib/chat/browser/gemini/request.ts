/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { SSEParser } from '../../../../../base/common/sseParser.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import type { GeminiContent, GeminiContentPart, GeminiApiChunk, GeminiRequestOptions, GeminiResponse, GeminiStreamingResponse } from './types.js';
import { normalizeFunctionCallArgs } from './conversion.js';

/**
 * Sends a request to the Gemini API (used for language model provider, not agent mode).
 * For agent mode, the implementation uses the server endpoint instead.
 */
export async function sendGeminiRequest(
	requestService: IRequestService,
	apiKey: string,
	model: string,
	messages: GeminiContent[],
	token: CancellationToken,
	options?: GeminiRequestOptions
): Promise<GeminiStreamingResponse> {
	const contents = messages.map(msg => ({
		role: msg.role,
		parts: msg.parts
	}));

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`;
	const payload: Record<string, unknown> = { contents };
	if (options?.tools && options.tools.length) {
		payload['tools'] = options.tools;
	}

	const toolCount = options?.tools?.flatMap(t => t.functionDeclarations ?? []).length ?? 0;
	const payloadInfo = {
		hasContents: !!payload.contents,
		contentsCount: Array.isArray(payload.contents) ? (payload.contents as unknown[]).length : 0,
		hasTools: !!payload.tools,
		toolCount,
		functionNames: options?.tools?.flatMap(t => t.functionDeclarations?.map(d => d.name) ?? []) ?? []
	};
	console.debug(`[gemini] request payload structure:`, payloadInfo);

	const body = JSON.stringify(payload);

	// Use native fetch for streaming
	const abortController = new AbortController();
	token.onCancellationRequested(() => {
		abortController.abort();
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream'
			},
			body: body,
			signal: abortController.signal,
		});
	} catch (fetchError) {
		if (fetchError instanceof Error && fetchError.name === 'AbortError') {
			throw new CancellationError();
		}
		throw fetchError;
	}

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Gemini API error: ${response.status} - ${errorText || 'Unknown error'}`);
	}

	const contentTypeHeader = response.headers.get('content-type');
	const contentType = contentTypeHeader ?? '';
	const isSse = typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');

	if (!isSse) {
		const responseText = await response.text();
		let parsedValue: unknown;
		try {
			parsedValue = responseText ? JSON.parse(responseText) : undefined;
		} catch (error) {
			throw new Error(`Gemini API error: Unable to parse response: ${error instanceof Error ? error.message : String(error)}`);
		}

		const chunks: GeminiApiChunk[] = Array.isArray(parsedValue)
			? (parsedValue as GeminiApiChunk[])
			: parsedValue
				? [parsedValue as GeminiApiChunk]
				: [];

		const aggregatedParts: GeminiContentPart[] = [];
		let finishReason: string | undefined;
		let usageMetadata: unknown;

		for (const chunk of chunks) {
			const candidate = chunk.candidates?.[0];
			const partsSource = candidate?.content?.parts ?? [];
			for (const part of partsSource) {
				if (typeof part?.text === 'string') {
					aggregatedParts.push({ text: part.text });
				} else if (part?.functionCall) {
					const args = normalizeFunctionCallArgs(part.functionCall.args);
					aggregatedParts.push({ functionCall: { name: part.functionCall.name, args } });
				} else if (part?.functionResponse) {
					aggregatedParts.push({ functionResponse: { name: part.functionResponse.name, response: part.functionResponse.response } });
				}
			}
			finishReason = finishReason ?? candidate?.finishReason;
			usageMetadata = chunk.usageMetadata ?? usageMetadata;
		}

		if (!aggregatedParts.length) {
			throw new Error(localize('gemini.invalidResponse', "Model returned an empty response."));
		}

		const stream = new AsyncIterableSource<GeminiContentPart[]>();
		const deferred = new DeferredPromise<GeminiResponse>();
		stream.emitOne(aggregatedParts);
		stream.resolve();
		deferred.complete({
			parts: aggregatedParts,
			finishReason,
			usageMetadata
		});

		return {
			stream: stream.asyncIterable,
			result: deferred.p
		};
	}

	const stream = new AsyncIterableSource<GeminiContentPart[]>();
	const deferred = new DeferredPromise<GeminiResponse>();
	const aggregatedParts: GeminiContentPart[] = [];
	const textAccumulators: string[] = [];
	const emittedFunctionCalls = new Set<string>();
	const emittedFunctionResponses = new Set<string>();
	let finishReason: string | undefined;
	let usageMetadata: unknown;
	let streamCompleted = false;
	let cancellationListener: IDisposable | undefined;

	const finalizeSuccess = () => {
		if (streamCompleted) {
			return;
		}
		streamCompleted = true;
		if (cancellationListener) {
			cancellationListener.dispose();
			cancellationListener = undefined;
		}

		if (!deferred.isSettled) {
			if (!aggregatedParts.length) {
				const err = new Error(localize('gemini.invalidResponse', "Model returned an empty response."));
				deferred.error(err);
				stream.reject(err);
				return;
			}
			deferred.complete({ parts: aggregatedParts, finishReason, usageMetadata });
		}
		stream.resolve();
	};

	const finalizeError = (error: Error) => {
		if (streamCompleted) {
			return;
		}
		streamCompleted = true;
		if (cancellationListener) {
			cancellationListener.dispose();
			cancellationListener = undefined;
		}
		if (abortController) {
			abortController.abort();
		}

		if (!deferred.isSettled) {
			deferred.error(error);
		}
		stream.reject(error);
	};

	cancellationListener = token.onCancellationRequested(() => {
		const err = new CancellationError();
		finalizeError(err);
	});

	const parser = new SSEParser(event => {
		if (event.type !== 'message') {
			return;
		}

		const rawData = event.data?.trim();
		if (!rawData) {
			return;
		}
		if (rawData === '[DONE]') {
			finalizeSuccess();
			return;
		}

		let parsed: GeminiApiChunk;
		try {
			parsed = JSON.parse(rawData) as GeminiApiChunk;
		} catch (error) {
			const err = new Error(`Gemini streaming chunk parse failure: ${error instanceof Error ? error.message : String(error)}`);
			finalizeError(err);
			return;
		}

		if (parsed.error) {
			const err = new Error(parsed.error.message ?? 'Gemini streaming error');
			finalizeError(err);
			return;
		}

		const candidate = parsed.candidates?.[0];
		if (!candidate) {
			return;
		}

		if (candidate.finishReason) {
			finishReason = finishReason ?? candidate.finishReason;
		}

		if (parsed.usageMetadata) {
			usageMetadata = parsed.usageMetadata;
		}

		const currentParts = candidate.content?.parts ?? [];
		const newParts: GeminiContentPart[] = [];

		for (let index = 0; index < currentParts.length; index++) {
			const part = currentParts[index];
			if (typeof part?.text === 'string') {
				// Treat part.text as the delta directly (fix for streaming)
				// Update accumulator for tracking, but emit the text directly
				const textDelta = part.text;
				textAccumulators[index] = (textAccumulators[index] ?? '') + textDelta;
				if (textDelta.length) {
					newParts.push({ text: textDelta });
				}
			} else if (part?.functionCall) {
				const args = normalizeFunctionCallArgs(part.functionCall.args);
				const key = `${part.functionCall.name}:${JSON.stringify(args)}`;
				if (!emittedFunctionCalls.has(key)) {
					emittedFunctionCalls.add(key);
					newParts.push({ functionCall: { name: part.functionCall.name, args } });
				}
			} else if (part?.functionResponse) {
				const key = `${part.functionResponse.name}:${JSON.stringify(part.functionResponse.response ?? {})}`;
				if (!emittedFunctionResponses.has(key)) {
					emittedFunctionResponses.add(key);
					newParts.push({ functionResponse: { name: part.functionResponse.name, response: part.functionResponse.response } });
				}
			}
		}

		if (newParts.length) {
			aggregatedParts.push(...newParts);
			stream.emitOne(newParts);
		}
	});

	// Use native fetch reader for streaming
	if (!response.body) {
		throw new Error('Response body is null');
	}

	const reader = response.body.getReader();

	(async () => {
		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();

				if (done) {
					finalizeSuccess();
					break;
				}

				if (value) {
					parser.feed(value);
				}
			}
		} catch (readError) {
			if (readError instanceof Error && readError.name === 'AbortError') {
				if (!streamCompleted) {
					finalizeError(new CancellationError());
				}
			} else {
				const err = readError instanceof Error ? readError : new Error(String(readError));
				finalizeError(err);
			}
		} finally {
			reader.releaseLock();
		}
	})();

	return {
		stream: stream.asyncIterable,
		result: deferred.p
	};
}

