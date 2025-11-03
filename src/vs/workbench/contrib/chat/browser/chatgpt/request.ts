/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { listenStream } from '../../../../../base/common/stream.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService, isSuccess } from '../../../../../platform/request/common/request.js';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { SSEParser } from '../../../../../base/common/sseParser.js';
import { IChatMessage } from '../../common/languageModels.js';
import { validateIDEFormatStatic } from './validation.js';
import type { ChatGPTStreamingResponse, ChatGPTResponse, ChatGPTContentPart, IDEStreamPart, ServerRequestOptions } from './types.js';

export async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: '/api/agent/tools',
	messages: IChatMessage[],
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
): Promise<ChatGPTStreamingResponse> {
	const url = `${serverAddress}${endpoint}`;

	if (!accessToken) {
		throw new Error(
			localize(
				'chatgpt.noAuthToken',
				'Authentication token is missing. Please sign in to use ChatGPT.',
			),
		);
	}

	validateIDEFormatStatic(messages, logService);
	logService?.debug(
		`[chatgpt-server] sendChatGPTRequest: Message format validation passed (${messages.length} messages)`,
	);

	const payload: Record<string, unknown> = {
		model: 'openai',
		messages: messages,
	};

	if (options?.context) {
		payload['context'] = options.context;
	}
	if (options?.modelName) {
		payload['modelName'] = options.modelName;
	}
	if (options?.tools !== undefined) {
		payload['tools'] = options.tools;
	}
	if (options?.toolResults && options.toolResults.length > 0) {
		payload['toolResults'] = options.toolResults;
	}

	const body = JSON.stringify(payload);

	if (options?.tools && options.tools.length > 0) {
		const toolNames = options.tools.map((t) => t.name || '<unnamed>').join(', ');
		logService?.debug(`[chatgpt-server] Sending ${options.tools.length} tool(s): ${toolNames}`);
	} else {
		logService?.debug(`[chatgpt-server] No tools being sent`);
	}

	logService?.info(`[chatgpt-server] Sending request to ${url}`);
	logService?.debug(
		`[chatgpt-server] Request payload: model=${payload.model}, messages=${messages.length}, tools=${options?.tools?.length || 0}, toolResults=${options?.toolResults?.length || 0}`,
	);

	const context = await requestService.request(
		{
			type: 'POST',
			url,
			data: body,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`,
				Accept: 'text/event-stream',
			},
		},
		token,
	);

	if (!isSuccess(context)) {
		logService?.error(
			`[chatgpt-server] Request failed with status ${context.res.statusCode}`,
		);
		const buffer = await streamToBuffer(context.stream);
		const errorText = buffer.toString();
		let errorMessage = `Server error: ${context.res.statusCode}`;
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
		logService?.error(`[chatgpt-server] Error details: ${errorMessage}`);
		throw new Error(errorMessage);
	}

	logService?.info(`[chatgpt-server] Request successful, starting SSE stream parsing`);

	const stream = new AsyncIterableSource<ChatGPTContentPart[]>();
	const deferred = new DeferredPromise<ChatGPTResponse>();
	const aggregatedParts: ChatGPTContentPart[] = [];
	const textAccumulator: string[] = [];
	let finishReason: string | null | undefined;
	let usage: unknown;
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
			if (!aggregatedParts.length && textAccumulator.length === 0) {
				const err = new Error(
					localize('chatgpt.invalidResponse', 'Model returned an empty response.'),
				);
				deferred.error(err);
				stream.reject(err);
				return;
			}
			if (textAccumulator.length > 0) {
				const accumulatedText = textAccumulator.join('');
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

		if (!deferred.isSettled) {
			deferred.error(error);
		}
		stream.reject(error);
	};

	cancellationListener = token.onCancellationRequested(() => {
		const err = new CancellationError();
		finalizeError(err);
		if (typeof context.stream.destroy === 'function') {
			context.stream.destroy();
		}
	});

	const parser = new SSEParser((event: any) => {
		if (event.type !== 'message') {
			return;
		}

		const rawData = event.data?.trim();
		if (!rawData) {
			return;
		}
		if (rawData === '[DONE]') {
			logService?.debug(`[chatgpt-server] Received [DONE] marker, finalizing stream`);
			finalizeSuccess();
			return;
		}

		let parsedParts: IDEStreamPart[];
		try {
			parsedParts = JSON.parse(rawData) as IDEStreamPart[];
			if (!Array.isArray(parsedParts)) {
				parsedParts = [parsedParts as IDEStreamPart];
			}
		} catch (error) {
			logService?.error(
				`[chatgpt-server] SSE chunk parse failure: ${error instanceof Error ? error.message : String(error)}`,
			);
			const err = new Error(
				`Streaming chunk parse failure: ${error instanceof Error ? error.message : String(error)}`,
			);
			finalizeError(err);
			return;
		}

		const newParts: ChatGPTContentPart[] = [];

		for (const part of parsedParts) {
			switch (part.type) {
				case 'text':
					if (part.value !== undefined && part.value.length > 0) {
						textAccumulator.push(part.value);
						newParts.push({ text: part.value });
					}
					break;

				case 'finish':
					if (part.finishReason !== undefined) {
						finishReason = finishReason ?? part.finishReason;
					}
					break;

				case 'tool_use':
					if (part.name && part.toolCallId && part.parameters !== undefined) {
						newParts.push({
							toolCall: {
								id: part.toolCallId,
								name: part.name,
								args: part.parameters as Record<string, unknown>,
							},
						});
						logService?.info(
							`[chatgpt-server] Received tool_use part: ${part.name} (id: ${part.toolCallId})`,
						);
					}
					break;

				case 'error': {
					logService?.error(
						`[chatgpt-server] Received error part: ${part.message || 'Unknown error'}`,
					);
					const err = new Error(part.message || 'Streaming error');
					finalizeError(err);
					return;
				}

				default:
					logService?.warn(
						`[chatgpt-server] Unknown part type: ${(part as IDEStreamPart).type}`,
					);
					break;
			}
		}

		if (newParts.length) {
			aggregatedParts.push(...newParts);
			stream.emitOne(newParts);
		}
	});

	listenStream(
		context.stream,
		{
			onData: (chunk: any) => {
				try {
					parser.feed(chunk.buffer);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					finalizeError(err);
				}
			},
			onError: (error: any) => {
				const err = error instanceof Error ? error : new Error(String(error));
				finalizeError(err);
			},
			onEnd: () => {
				finalizeSuccess();
			},
		},
		token,
	);

	return {
		stream: stream.asyncIterable,
		result: deferred.p,
	};
}

