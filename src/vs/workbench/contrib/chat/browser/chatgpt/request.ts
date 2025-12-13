/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../../base/common/cancellation.js";
import { CancellationError } from "../../../../../base/common/errors.js";
import {
	AsyncIterableSource,
	DeferredPromise,
} from "../../../../../base/common/async.js";
import { IDisposable } from "../../../../../base/common/lifecycle.js";
import { localize } from "../../../../../nls.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { SSEParser } from "../../../../../base/common/sseParser.js";
import { IChatMessage } from "../../common/languageModels.js";
import { validateIDEFormatStatic } from "./validation.js";
import type {
	ChatGPTStreamingResponse,
	ChatGPTResponse,
	ChatGPTContentPart,
	IDEStreamPart,
	ServerRequestOptions,
} from "./types.js";

export async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: "/api/agent/tools" | "/api/agent/ask",
	messages: IChatMessage[],
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
	modelType: "openai" | "gemini" = "openai"
): Promise<ChatGPTStreamingResponse> {
	// Normalize serverAddress (remove trailing slashes)
	const normalizedServerAddress = serverAddress.trim().replace(/\/+$/, "");

	// If serverAddress already ends with /api and endpoint starts with /api/, remove the duplicate /api
	let normalizedEndpoint: string;
	if (
		normalizedServerAddress.endsWith("/api") &&
		endpoint.startsWith("/api/")
	) {
		normalizedEndpoint = endpoint.substring(4); // Remove '/api' from the beginning of endpoint
	} else {
		normalizedEndpoint = endpoint;
	}

	const url = `${normalizedServerAddress}${normalizedEndpoint}`;

	if (!accessToken) {
		throw new Error(
			localize(
				"chatgpt.noAuthToken",
				"Authentication token is missing. Please sign in to use ChatGPT."
			)
		);
	}

	validateIDEFormatStatic(messages, logService);
	logService?.debug(
		`[chatgpt-server] sendChatGPTRequest: Message format validation passed (${messages.length} messages)`
	);

	const payload: Record<string, unknown> = {
		model: modelType,
		messages: messages,
	};

	if (options?.context) {
		payload["context"] = options.context;
	}
	if (options?.modelName) {
		payload["modelName"] = options.modelName;
	}
	if (options?.mode) {
		payload["mode"] = options.mode;
	}
	if (options?.tools !== undefined) {
		payload["tools"] = options.tools;
	}
	if (options?.toolResults && options.toolResults.length > 0) {
		payload["toolResults"] = options.toolResults;
		const toolResultIds = options.toolResults
			.map((tr) => tr.toolCallId)
			.join(", ");
		logService?.info(
			`[chatgpt-server] Request payload includes ${options.toolResults.length} tool result(s): ${toolResultIds}`
		);
	}

	const body = JSON.stringify(payload);

	if (options?.tools && options.tools.length > 0) {
		const toolNames = options.tools
			.map((t) => t.name || "<unnamed>")
			.join(", ");
		logService?.debug(
			`[chatgpt-server] Sending ${options.tools.length} tool(s): ${toolNames}`
		);
	} else {
		logService?.debug(`[chatgpt-server] No tools being sent`);
	}

	logService?.info(`[chatgpt-server] Sending request to ${url}`);
	logService?.info(
		`[chatgpt-server] Request payload: model="${payload.model}", modelName="${
			payload.modelName || "undefined"
		}", messages=${messages.length}, tools=${
			options?.tools?.length || 0
		}, toolResults=${options?.toolResults?.length || 0}`
	);
	logService?.debug(
		`[chatgpt-server] Full request payload details: ${JSON.stringify({
			model: payload.model,
			modelName: payload.modelName,
			messagesCount: messages.length,
			toolsCount: options?.tools?.length || 0,
			toolResultsCount: options?.toolResults?.length || 0,
		})}`
	);

	const stream = new AsyncIterableSource<ChatGPTContentPart[]>();
	const deferred = new DeferredPromise<ChatGPTResponse>();
	const aggregatedParts: ChatGPTContentPart[] = [];
	const textAccumulator: string[] = [];
	let finishReason: string | null | undefined;
	let usage: unknown;
	let streamCompleted = false;
	let cancellationListener: IDisposable | undefined;
	let abortController: AbortController | undefined;

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
			if (!aggregatedParts.length && textAccumulator.length === 0) {
				const err = new Error(
					localize(
						"chatgpt.invalidResponse",
						"Model returned an empty response."
					)
				);
				deferred.error(err);
				stream.reject(err);
				return;
			}
			if (textAccumulator.length > 0) {
				const accumulatedText = textAccumulator.join("");
				if (accumulatedText.trim().length) {
					aggregatedParts.push({ text: accumulatedText });
				}
				textAccumulator.length = 0;
			}
			deferred.complete({ parts: aggregatedParts, finishReason, usage });
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

	const parser = new SSEParser((event: any) => {
		const timestamp = Date.now();

		// Validate event structure
		if (!event || typeof event !== "object") {
			logService?.warn(
				`[Stream] [${timestamp}] Received invalid SSE event (not an object)`
			);
			return;
		}

		if (event.type !== "message") {
			logService?.debug(
				`[Stream] [${timestamp}] Received SSE event type: ${event.type} (ignoring)`
			);
			return;
		}

		// Validate event data exists
		if (!event.data || typeof event.data !== "string") {
			logService?.warn(
				`[Stream] [${timestamp}] Received SSE message with invalid data`
			);
			return;
		}

		const rawData = event.data.trim();
		if (!rawData) {
			logService?.debug(
				`[Stream] [${timestamp}] Received empty SSE data, skipping`
			);
			return;
		}

		logService?.debug(
			`[Stream] [${timestamp}] Received SSE message: ${rawData.substring(
				0,
				100
			)}${rawData.length > 100 ? "..." : ""}`
		);

		if (rawData === "[DONE]") {
			logService?.debug(
				`[Stream] [${timestamp}] Received [DONE] marker, finalizing stream`
			);
			finalizeSuccess();
			return;
		}

		let parsedParts: IDEStreamPart[];
		try {
			parsedParts = JSON.parse(rawData) as IDEStreamPart[];
			if (!Array.isArray(parsedParts)) {
				parsedParts = [parsedParts as IDEStreamPart];
			}
			logService?.debug(
				`[Stream] [${timestamp}] Parsed ${parsedParts.length} part(s) from SSE`
			);
		} catch (error) {
			logService?.error(
				`[Stream] [${timestamp}] SSE chunk parse failure: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			const err = new Error(
				`Streaming chunk parse failure: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			finalizeError(err);
			return;
		}

		const newParts: ChatGPTContentPart[] = [];

		for (const part of parsedParts) {
			switch (part.type) {
				case "text":
					if (part.value !== undefined && part.value.length > 0) {
						textAccumulator.push(part.value);
						newParts.push({ text: part.value });
					}
					break;

				case "finish":
					if (part.finishReason !== undefined) {
						finishReason = finishReason ?? part.finishReason;
					}
					break;

				case "tool_use":
					if (part.name && part.toolCallId && part.parameters !== undefined) {
						newParts.push({
							toolCall: {
								id: part.toolCallId,
								name: part.name,
								args: part.parameters as Record<string, unknown>,
							},
						});
						logService?.info(
							`[chatgpt-server] Received tool_use part: ${part.name} (id: ${part.toolCallId})`
						);
					}
					break;

				case "error": {
					logService?.error(
						`[chatgpt-server] Received error part: ${
							part.message || "Unknown error"
						}`
					);
					const err = new Error(part.message || "Streaming error");
					finalizeError(err);
					return;
				}

				default:
					logService?.warn(
						`[chatgpt-server] Unknown part type: ${
							(part as IDEStreamPart).type
						}`
					);
					break;
			}
		}

		if (newParts.length) {
			const emitTimestamp = Date.now();
			logService?.debug(
				`[Stream] [${emitTimestamp}] Emitting ${newParts.length} part(s) to async iterable`
			);
			aggregatedParts.push(...newParts);
			stream.emitOne(newParts);
		}
	});

	// Use native fetch for streaming
	abortController = new AbortController();
	cancellationListener = token.onCancellationRequested(() => {
		abortController?.abort();
	});

	(async () => {
		try {
			logService?.info(
				`[chatgpt-server] Starting fetch request, beginning SSE stream parsing`
			);

			// Build headers with optional metrics tracking
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				Accept: "text/event-stream",
			};
			if (options?.sessionId) {
				headers["x-session-id"] = options.sessionId;
			}
			if (options?.projectId) {
				headers["x-project-id"] = options.projectId;
			}

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: body,
				signal: abortController.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				let errorMessage = `Server error: ${response.status}`;
				try {
					const errorJson = JSON.parse(errorText);
					if (errorJson.error?.message) {
						errorMessage = errorJson.error.message;
					} else if (errorJson.message) {
						errorMessage = errorJson.message;
					}
				} catch {
					if (errorText) {
						errorMessage += ` - ${errorText}`;
					}
				}
				logService?.error(
					`[chatgpt-server] Request failed with status ${response.status}`
				);
				logService?.error(`[chatgpt-server] Error details: ${errorMessage}`);
				throw new Error(errorMessage);
			}

			if (!response.body) {
				throw new Error("Response body is null");
			}

			const reader = response.body.getReader();

			try {
				while (true) {
					if (token.isCancellationRequested) {
						break;
					}

					const { done, value } = await reader.read();

					if (done) {
						logService?.debug(`[Stream] Reader finished, finalizing stream`);
						finalizeSuccess();
						break;
					}

					if (value) {
						const dataTimestamp = Date.now();
						logService?.debug(
							`[Stream] [${dataTimestamp}] Received raw chunk from fetch stream (${value.length} bytes)`
						);
						parser.feed(value);
					}
				}
			} catch (readError) {
				if (readError instanceof Error && readError.name === "AbortError") {
					logService?.debug(`[Stream] Request aborted`);
					if (!streamCompleted) {
						finalizeError(new CancellationError());
					}
				} else {
					const err =
						readError instanceof Error
							? readError
							: new Error(String(readError));
					logService?.error(`[Stream] Error reading stream: ${err.message}`);
					finalizeError(err);
				}
			} finally {
				reader.releaseLock();
			}
		} catch (fetchError) {
			if (fetchError instanceof Error && fetchError.name === "AbortError") {
				logService?.debug(`[Stream] Fetch aborted`);
				if (!streamCompleted) {
					finalizeError(new CancellationError());
				}
			} else {
				const err =
					fetchError instanceof Error
						? fetchError
						: new Error(String(fetchError));
				logService?.error(`[chatgpt-server] Fetch error: ${err.message}`);
				finalizeError(err);
			}
		}
	})();

	return {
		stream: stream.asyncIterable,
		result: deferred.p,
	};
}
