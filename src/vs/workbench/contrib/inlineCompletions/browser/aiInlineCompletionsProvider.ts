/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from "../../../../base/common/cancellation.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletionTriggerKind,
	InlineCompletions,
	InlineCompletionsProvider,
} from "../../../../editor/common/languages.js";
import { ITextModel } from "../../../../editor/common/model.js";
import { env } from "../../../../base/common/process.js";
import { IRequestService } from "../../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../../platform/secrets/common/secrets.js";
import { IProductService } from "../../../../platform/product/common/productService.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { SSEParser } from "../../../../base/common/sseParser.js";
import { streamToBuffer, VSBuffer } from "../../../../base/common/buffer.js";

export class AIInlineCompletionsProvider
	extends Disposable
	implements InlineCompletionsProvider
{
	displayName = "Ren AI Autocomplete";
	debounceDelayMs = 150;

	private cachedServerAddress: string | undefined;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@ISecretStorageService
		private readonly _secretStorageService: ISecretStorageService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<InlineCompletions | undefined> {
		// Only provide completions for automatic triggers (as user types)
		if (context.triggerKind === InlineCompletionTriggerKind.Explicit) {
			return undefined;
		}

		// Get context window: prefix (last 50-100 lines) and suffix (next 20-50 lines)
		const prefixLines = 75;
		const suffixLines = 25;

		const startLine = Math.max(1, position.lineNumber - prefixLines);
		const endLine = Math.min(
			model.getLineCount(),
			position.lineNumber + suffixLines
		);

		const prefixRange = new Range(
			startLine,
			1,
			position.lineNumber,
			position.column
		);
		const suffixRange = new Range(
			position.lineNumber,
			position.column,
			endLine,
			model.getLineMaxColumn(endLine)
		);

		const prefix = model.getValueInRange(prefixRange);
		const suffix = model.getValueInRange(suffixRange);

		// Get server address and access token
		const serverAddress = await this.resolveServerAddress();
		if (!serverAddress) {
			this._logService.trace(
				"[AIInlineCompletions] Server address not configured"
			);
			return undefined;
		}

		const accessToken = await this._secretStorageService.get(
			"ren.auth.accessToken"
		);
		if (!accessToken) {
			this._logService.trace(
				"[AIInlineCompletions] Authentication token is missing"
			);
			return undefined;
		}

		// Construct FIM (Fill-In-Middle) prompt
		const languageId = model.getLanguageId();
		const prompt = `You are a code completion assistant. Complete the code at the cursor position.
Do not repeat the prefix or suffix. Only output the missing code that should be inserted.

Language: ${languageId}

Prefix code:
\`\`\`${languageId}
${prefix}
\`\`\`

Suffix code:
\`\`\`${languageId}
${suffix}
\`\`\`

Complete the code between the prefix and suffix. Output only the code to insert, nothing else:`;

		// Declare completionText outside try block so it's accessible in catch block
		let completionText = "";

		try {
			const url = this.normalizeEndpoint(
				serverAddress,
				"/api/agent/completion"
			);
			const body = JSON.stringify({
				model: "openai",
				prompt: prompt,
				modelName: "gpt-4o-mini",
				stream: true,
			});

			this._logService.trace(
				`[AIInlineCompletions] Sending completion request to ${url}`
			);

			const response = await this._requestService.request(
				{
					type: "POST",
					url,
					data: body,
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessToken}`,
					},
					timeout: 30000,
				},
				token
			);

			if (response.res?.statusCode !== 200) {
				const buffer = await streamToBuffer(response.stream);
				const errorText = buffer.toString();
				this._logService.debug(
					`[AIInlineCompletions] Request failed with status ${response.res?.statusCode}: ${errorText}`
				);
				return undefined;
			}

			// Parse SSE stream using SSEParser
			let streamCompleted = false;
			const deferred = new Promise<void>((resolve, reject) => {
				const parser = new SSEParser((event: any) => {
					if (streamCompleted) {
						return;
					}

					if (token.isCancellationRequested) {
						streamCompleted = true;
						reject(new CancellationError());
						return;
					}

					if (event.type !== "message") {
						return;
					}

					const rawData = event.data?.trim();
					if (!rawData || rawData === "[DONE]") {
						if (rawData === "[DONE]") {
							streamCompleted = true;
							resolve();
						}
						return;
					}

					try {
						const parts = JSON.parse(rawData);
						const partsArray = Array.isArray(parts) ? parts : [parts];
						for (const part of partsArray) {
							if (part.type === "text" && part.value) {
								completionText += part.value;
							} else if (part.type === "finish") {
								// Finish event received - stream is complete
								// According to OpenAI API spec, finish_reason appears in final chunk
								// We can resolve now as all data has been received
								if (!streamCompleted) {
									streamCompleted = true;
									resolve();
								}
							}
						}
					} catch (e) {
						this._logService.debug(
							`[AIInlineCompletions] Failed to parse SSE chunk: ${e}`
						);
					}
				});

				// Feed the stream to the parser
				const listener = {
					onData: (chunk: VSBuffer) => {
						if (token.isCancellationRequested) {
							streamCompleted = true;
							reject(new CancellationError());
							return;
						}
						parser.feed(chunk.buffer);
					},
					onError: (error: Error) => {
						if (!streamCompleted) {
							streamCompleted = true;
							reject(error);
						}
					},
					onEnd: () => {
						if (!streamCompleted) {
							streamCompleted = true;
							resolve();
						}
					},
				};

				response.stream.on("data", listener.onData);
				response.stream.on("error", listener.onError);
				response.stream.on("end", listener.onEnd);
			});

			// Wait for stream to complete
			await deferred;

			// Clean up the completion text (remove any markdown code blocks if present)
			const originalLength = completionText.length;
			completionText = this.cleanCompletionText(completionText);

			if (!completionText || completionText.trim().length === 0) {
				this._logService.debug(
					`[AIInlineCompletions] Completion text is empty after cleaning (original length: ${originalLength})`
				);
				return undefined;
			}

			const item: InlineCompletion = {
				insertText: completionText,
				range: new Range(
					position.lineNumber,
					position.column,
					position.lineNumber,
					position.column
				),
			};

			this._logService.trace(
				`[AIInlineCompletions] Generated completion (${completionText.length} chars): ${completionText.substring(
					0,
					100
				)}${completionText.length > 100 ? "..." : ""}`
			);

			return {
				items: [item],
				enableForwardStability: true,
			};
		} catch (e) {
			// If cancellation was requested, don't try to recover
			if (token.isCancellationRequested) {
				return undefined;
			}

			// Try to recover partial completion text if stream was interrupted
			if (completionText) {
				completionText = this.cleanCompletionText(completionText);
				if (completionText) {
					this._logService.warn(
						`[AIInlineCompletions] Stream error occurred, but recovered partial completion (${
							completionText.length
						} chars): ${e instanceof Error ? e.message : String(e)}`
					);

					const item: InlineCompletion = {
						insertText: completionText,
						range: new Range(
							position.lineNumber,
							position.column,
							position.lineNumber,
							position.column
						),
					};

					return {
						items: [item],
						enableForwardStability: true,
					};
				}
			}

			// Log error if we couldn't recover
			this._logService.debug(
				`[AIInlineCompletions] Error generating completion: ${e}`
			);
			return undefined;
		}
	}

	private async resolveServerAddress(): Promise<string | undefined> {
		if (this.cachedServerAddress) {
			return this.cachedServerAddress;
		}

		const envAddress = env["SERVER_ADDRESS"];
		if (envAddress && typeof envAddress === "string") {
			const trimmed = envAddress.trim();
			if (trimmed) {
				let normalized = trimmed;
				if (
					!normalized.startsWith("http://") &&
					!normalized.startsWith("https://")
				) {
					normalized = `https://${normalized}`;
				}
				this.cachedServerAddress = normalized.replace(/\/+$/, "");
				return this.cachedServerAddress;
			}
		}

		const apiBaseUrl = this._productService.renAccount?.apiBaseUrl;
		if (apiBaseUrl && typeof apiBaseUrl === "string") {
			const trimmed = apiBaseUrl.trim();
			if (trimmed) {
				this.cachedServerAddress = trimmed.replace(/\/+$/, "");
				return this.cachedServerAddress;
			}
		}

		return undefined;
	}

	private normalizeEndpoint(serverAddress: string, endpoint: string): string {
		const normalizedAddress = serverAddress.trim().replace(/\/+$/, "");
		if (normalizedAddress.endsWith("/api") && endpoint.startsWith("/api/")) {
			return `${normalizedAddress}${endpoint.substring(4)}`;
		}
		return `${normalizedAddress}${endpoint}`;
	}

	/**
	 * Clean completion text by removing markdown code blocks if present.
	 * Handles various edge cases like whitespace, different newline formats, and partial blocks.
	 */
	private cleanCompletionText(text: string): string {
		if (!text) {
			return "";
		}

		let cleaned = text.trim();
		if (!cleaned) {
			return "";
		}

		// Check if text starts with a code block fence
		if (cleaned.startsWith("```")) {
			const lines = cleaned.split(/\r?\n/);

			// Remove opening fence (first line that starts with ```)
			if (lines.length > 0 && lines[0].trim().startsWith("```")) {
				lines.shift();
			}

			// Remove closing fence (last line that is exactly ``` or starts with ``` and has no other content)
			if (lines.length > 0) {
				const lastLine = lines[lines.length - 1].trim();
				// Only remove if it's exactly ``` or starts with ``` and has no meaningful content after
				if (lastLine === "```" || (lastLine.startsWith("```") && lastLine.length <= 3)) {
					lines.pop();
				}
			}

			cleaned = lines.join("\n").trim();
		}

		return cleaned;
	}

	disposeInlineCompletions(completions: InlineCompletions, reason: any): void {
		// No cleanup needed
	}
}
