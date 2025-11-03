# Complete Schemas and ChatGPT Code Reference

This document contains all schemas and key ChatGPT code sections.

---

## 📋 Table of Contents

1. [Type Definitions](#type-definitions)
2. [Message Format Schemas](#message-format-schemas)
3. [Request Payload Schemas](#request-payload-schemas)
4. [Core Code Functions](#core-code-functions)
5. [Validation Functions](#validation-functions)

---

## Type Definitions

### ChatMessageRole Enum

```typescript
// src/vs/workbench/contrib/chat/common/languageModels.ts
export const enum ChatMessageRole {
	System,    // 0
	User,      // 1
	Assistant, // 2
}
```

### IChatMessage Interface

```typescript
// src/vs/workbench/contrib/chat/common/languageModels.ts
export interface IChatMessage {
	readonly name?: string | undefined;
	readonly role: ChatMessageRole;  // Number: 0, 1, or 2
	readonly content: IChatMessagePart[];
}
```

### IChatMessagePart Types

```typescript
// src/vs/workbench/contrib/chat/common/languageModels.ts
export interface IChatMessageTextPart {
	type: 'text';
	value: string;
	audience?: LanguageModelPartAudience[];
}

export interface IChatResponseToolUsePart {
	type: 'tool_use';
	name: string;
	toolCallId: string;
	parameters: any;  // Object, not JSON string
}

export type IChatMessagePart =
	| IChatMessageTextPart
	| IChatMessageToolResultPart
	| IChatResponseToolUsePart
	| IChatMessageImagePart
	| IChatMessageDataPart
	| IChatMessageThinkingPart;
```

### Internal OpenAI Format (Not Sent to Server)

```typescript
// src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts
type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool';

interface OpenAIMessage {
	readonly role: OpenAIRole;  // String, not number
	readonly content: string | null;  // Can be null when tool_calls exist
	readonly tool_calls?: OpenAIToolCall[];  // At message level
	readonly tool_call_id?: string;
	readonly name?: string;
}

interface OpenAIToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;  // JSON stringified
	};
}
```

### Server Request/Response Types

```typescript
// src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts
interface ServerToolResult {
	readonly toolCallId: string;
	readonly content: Array<{ type: 'text'; value: string }>;
}

interface ServerRequestOptions {
	readonly context?: string;
	readonly modelName?: string;
	readonly tools?: Array<{
		name: string;
		description?: string;
		parameters?: unknown;
	}>;
	readonly toolResults?: ServerToolResult[];
}

interface IDEStreamPart {
	readonly type: 'text' | 'finish' | 'tool_use' | 'error';
	readonly value?: string;
	readonly finishReason?: string;
	readonly name?: string;
	readonly toolCallId?: string;
	readonly parameters?: Record<string, unknown>;
	readonly message?: string;
}
```

---

## Message Format Schemas

### ✅ IDE Format (What Server Expects)

```typescript
{
	role: 2,  // ChatMessageRole.Assistant (NUMBER, not string)
	content: [  // ARRAY (minimum 1 item), not null
		{
			type: 'tool_use',
			name: 'read_file',
			toolCallId: 'call_abc123',
			parameters: {  // OBJECT, not JSON string
				path: 'config.json'
			}
		}
	]
}
```

### ❌ OpenAI Format (Internal Only, Not Sent)

```typescript
{
	role: 'assistant',  // String, not number
	content: null,  // Null when tool_calls exist
	tool_calls: [  // At message level, not in content
		{
			id: 'call_abc123',
			type: 'function',
			function: {
				name: 'read_file',
				arguments: '{"path":"config.json"}'  // JSON string, not object
			}
		}
	]
}
```

---

## Request Payload Schemas

### Before Tool Call (Initial Request)

```json
{
	"model": "openai",
	"messages": [
		{
			"role": 0,
			"content": [
				{
					"type": "text",
					"value": "You can call the following tools..."
				}
			]
		},
		{
			"role": 1,
			"content": [
				{
					"type": "text",
					"value": "User's question here"
				}
			]
		}
	],
	"modelName": "gpt-5-nano-2025-08-07",
	"tools": [
		{
			"name": "read_file",
			"description": "Reads a file from the filesystem",
			"parameters": {
				"type": "object",
				"properties": {
					"path": {
						"type": "string",
						"description": "Path to the file"
					}
				},
				"required": ["path"]
			}
		}
	]
}
```

### After Tool Call (Subsequent Request)

```json
{
	"model": "openai",
	"messages": [
		{
			"role": 0,
			"content": [
				{
					"type": "text",
					"value": "You can call the following tools..."
				}
			]
		},
		{
			"role": 1,
			"content": [
				{
					"type": "text",
					"value": "Read the file config.json"
				}
			]
		},
		{
			"role": 2,
			"content": [
				{
					"type": "tool_use",
					"name": "read_file",
					"toolCallId": "call_abc123",
					"parameters": {
						"path": "config.json"
					}
				}
			]
		}
	],
	"modelName": "gpt-5-nano-2025-08-07",
	"tools": [...],
	"toolResults": [
		{
			"toolCallId": "call_abc123",
			"content": [
				{
					"type": "text",
					"value": "{\n  \"version\": \"1.0\"\n}"
				}
			]
		}
	]
}
```

---

## Core Code Functions

### 1. convertOpenAIMessagesToIDE() - Format Conversion

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 1434-1519)

```typescript
private convertOpenAIMessagesToIDE(messages: OpenAIMessage[]): IChatMessage[] {
	this.logService.debug(
		`[chatgpt-server] Converting ${messages.length} messages from OpenAI format to IDE format`,
	);

	const ideMessages: IChatMessage[] = [];
	for (const msg of messages) {
		let role: ChatMessageRole;
		switch (msg.role) {
			case 'system':
				role = ChatMessageRole.System;
				break;
			case 'user':
				role = ChatMessageRole.User;
				break;
			case 'assistant':
				role = ChatMessageRole.Assistant;
				break;
			case 'tool':
				continue;  // Skip tool messages
			default:
				continue;
		}

		const content: IChatMessagePart[] = [];

		// Add text content if present
		if (msg.content !== null && msg.content !== undefined && msg.content.trim().length > 0) {
			content.push({ type: 'text', value: msg.content });
		}

		// Convert tool_calls to tool_use parts in content array
		if (msg.tool_calls && msg.tool_calls.length > 0) {
			this.logService.debug(
				`[chatgpt-server] Converting ${msg.tool_calls.length} tool_calls to tool_use parts for role=${msg.role}`,
			);
			for (const toolCall of msg.tool_calls) {
				try {
					// Parse arguments JSON string to object
					const args = JSON.parse(toolCall.function.arguments || '{}');
					content.push({
						type: 'tool_use',
						name: toolCall.function.name,
						toolCallId: toolCall.id,
						parameters: args,  // Object, not JSON string
					});
				} catch (error) {
					this.logService.warn(
						`[chatgpt-server] Failed to parse tool call arguments for ${toolCall.function.name}: ${error instanceof Error ? error.message : String(error)}`,
					);
					content.push({
						type: 'tool_use',
						name: toolCall.function.name,
						toolCallId: toolCall.id,
						parameters: {},
					});
				}
			}
		}

		// Include message if it has content
		if (content.length > 0) {
			ideMessages.push({ role, content });
		}
	}

	this.logService.debug(
		`[chatgpt-server] Conversion complete: ${ideMessages.length} messages in IDE format`,
	);

	return ideMessages;
}
```

### 2. performRequest() - Main Request Handler

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 1598-1690)

```typescript
private async performRequest(
	messages: OpenAIMessage[],
	tools: OpenAIFunction[],
	token: CancellationToken,
	model: string,
	context?: string,
	toolResults?: ServerToolResult[],
): Promise<ChatGPTStreamingResponse> {
	// Convert messages to IDE format
	const ideMessages = this.convertOpenAIMessagesToIDE(messages);

	// CRITICAL: Validate format before sending
	this.validateIDEFormat(ideMessages);
	this.logService.debug(
		`[chatgpt-server] Message format validation passed: ${ideMessages.length} messages in IDE format`,
	);

	// Convert tools to server format
	const serverTools = tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	}));

	// Always use /api/agent/tools endpoint
	const endpoint: '/api/agent/tools' = '/api/agent/tools';

	const response = await sendChatGPTRequest(
		this.requestService,
		accessToken,
		this.serverAddress,
		endpoint,
		ideMessages,  // IDE format messages
		token,
		{
			context,
			modelName: model,
			tools: serverTools,
			toolResults: toolResults && toolResults.length > 0 ? toolResults : undefined,
		},
		this.logService,
	);

	return response;
}
```

### 3. sendChatGPTRequest() - HTTP Request

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 390-490)

```typescript
async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: '/api/agent/tools',
	messages: IChatMessage[],  // Should already be IDE format
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
): Promise<ChatGPTStreamingResponse> {
	const url = `${serverAddress}${endpoint}`;

	if (!accessToken) {
		throw new Error('Authentication token is missing');
	}

	// Safety check: validate IDE format before sending
	validateIDEFormatStatic(messages, logService);
	logService?.debug(
		`[chatgpt-server] sendChatGPTRequest: Message format validation passed (${messages.length} messages)`,
	);

	// Build payload
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

	// Send HTTP request
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

	// ... handle response stream ...
}
```

### 4. Tool Call Message Addition (Before Conversion)

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 920-980)

```typescript
// Handle tool calls
if (toolCallParts.length > 0) {
	// Add assistant message with tool calls (OpenAI format, internal)
	const toolCalls: OpenAIToolCall[] = toolCallParts.map((part) => ({
		id: part.toolCall!.id,
		type: 'function',
		function: {
			name: part.toolCall!.name,
			arguments: JSON.stringify(part.toolCall!.args),  // JSON string
		},
	}));

	messages.push({
		role: 'assistant',  // String
		content: null,  // Null when tool_calls exist
		tool_calls: toolCalls,  // At message level
	});

	// Execute tool calls...

	// Build tool results for next request
	const toolResultsForNextRequest: ServerToolResult[] = [];
	for (const callPart of toolCallParts) {
		// ... execute tool ...
		toolResultsForNextRequest.push({
			toolCallId: callId,
			content: [{ type: 'text', value: textOutput }],
		});
	}

	toolResults = toolResultsForNextRequest;
}
```

**Note**: This OpenAI format message is then converted to IDE format by `convertOpenAIMessagesToIDE()` before sending.

### 5. Tool Result Construction

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 1044-1047)

```typescript
// Convert to server-format tool result
const textOutput = (result.content ?? [])
	.filter((part): part is IToolResultTextPart => part.kind === 'text')
	.map((part) => part.value)
	.join('\n');

toolResultsForNextRequest.push({
	toolCallId: callId,
	content: [{ type: 'text', value: textOutput }],
});
```

---

## Validation Functions

### validateIDEFormat() - Class Method

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 1532-1596)

```typescript
/**
 * Validates that messages are in IDE format (not OpenAI format).
 * Throws error if OpenAI format detected.
 */
private validateIDEFormat(messages: IChatMessage[]): void {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// 1. Role must be number (0, 1, 2)
		if (typeof msg.role !== 'number') {
			throw new Error(
				`[chatgpt-server] Invalid message format at index ${i}: role must be number (0, 1, 2), got ${typeof msg.role}: ${msg.role}. ` +
				`This suggests OpenAI format (role as string) was not converted.`,
			);
		}
		if (msg.role < 0 || msg.role > 2) {
			throw new Error(
				`[chatgpt-server] Invalid message format at index ${i}: role must be 0-2, got ${msg.role}`,
			);
		}

		// 2. Content must be array (not null, not string)
		if (!Array.isArray(msg.content)) {
			throw new Error(
				`[chatgpt-server] Invalid message format at index ${i}: content must be array, got ${typeof msg.content}. ` +
				`This suggests OpenAI format (content: null) was not converted.`,
			);
		}

		// 3. Content array must have at least 1 item
		if (msg.content.length === 0) {
			throw new Error(
				`[chatgpt-server] Invalid message format at index ${i}: content array must have minimum 1 item, got empty array. ` +
				`Server requires content array with minimum 1 item.`,
			);
		}

		// 4. Check for OpenAI format indicators (should not exist)
		const msgWithToolCalls = msg as IChatMessage & { tool_calls?: unknown };
		if (Object.prototype.hasOwnProperty.call(msgWithToolCalls, 'tool_calls') && msgWithToolCalls.tool_calls !== undefined) {
			throw new Error(
				`[chatgpt-server] Invalid message format at index ${i}: tool_calls at message level detected. ` +
				`Should be converted to tool_use parts in content array. ` +
				`Received OpenAI format instead of IDE format.`,
			);
		}

		// 5. Validate content parts
		for (let j = 0; j < msg.content.length; j++) {
			const part = msg.content[j];
			if (part.type === 'tool_use') {
				// Parameters must be object, not string
				if (typeof part.parameters !== 'object' || part.parameters === null) {
					throw new Error(
						`[chatgpt-server] Invalid message format at index ${i}, content part ${j}: ` +
						`tool_use.parameters must be object, got ${typeof part.parameters}. ` +
						`This suggests OpenAI format (arguments as JSON string) was not converted.`,
					);
				}
				if (Array.isArray(part.parameters)) {
					throw new Error(
						`[chatgpt-server] Invalid message format at index ${i}, content part ${j}: ` +
						`tool_use.parameters must be object, got array`,
					);
				}
			}
		}
	}
}
```

### validateIDEFormatStatic() - Static Function

**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` (Lines 310-388)

```typescript
/**
 * Static validation function for IDE format (used as safety net in sendChatGPTRequest).
 * Same validation logic as class method validateIDEFormat.
 */
function validateIDEFormatStatic(messages: IChatMessage[], logService?: ILogService): void {
	// Same validation logic as validateIDEFormat()
	// ... (see above)
}
```

---

## Key Differences Summary

| Aspect | OpenAI Format (Internal) | IDE Format (Server) |
|--------|-------------------------|---------------------|
| **Role** | String: `"assistant"` | Number: `2` |
| **Content** | `null` when tool_calls exist | Array (minimum 1 item) |
| **Tool Calls** | `tool_calls` at message level | `tool_use` parts in `content` array |
| **Parameters** | JSON string: `"{\"path\":\"file.json\"}"` | Object: `{path: "file.json"}` |
| **Usage** | Internal conversation management | Sent to server |

---

## Data Flow

```
1. Internal (OpenAIMessage format)
   ↓
2. convertOpenAIMessagesToIDE()
   ↓
3. validateIDEFormat() - First check
   ↓
4. performRequest()
   ↓
5. sendChatGPTRequest()
   ↓
6. validateIDEFormatStatic() - Second check
   ↓
7. HTTP POST to server (IDE format only)
```

---

## Endpoint

```
POST {serverAddress}/api/agent/tools
Headers: {
	"Content-Type": "application/json",
	"Authorization": "Bearer <accessToken>",
	"Accept": "text/event-stream"
}
```

---

## Notes

1. **Conversion is Mandatory**: All OpenAI format messages MUST be converted before sending
2. **Validation is Double-Checked**: Both `performRequest()` and `sendChatGPTRequest()` validate
3. **Server Only Accepts IDE Format**: Server will reject OpenAI format with 400 error
4. **Tool Calls Converted**: `tool_calls` → `tool_use` parts in `content` array
5. **Parameters Parsed**: JSON string → Object before sending

