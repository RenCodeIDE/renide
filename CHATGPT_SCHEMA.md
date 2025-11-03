# ChatGPT Agent Request Schemas

This document shows the exact JSON schemas that the ChatGPT agent sends to the server before and after tool calls.

## Schema: Before Tool Call (Initial Request)

**Location:** `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` - Lines 327-345

### Request Payload Structure

```typescript
{
  model: "openai",
  messages: IChatMessage[],
  context?: string,              // Optional context string
  modelName?: string,             // Optional model name (e.g., "gpt-5-nano-2025-08-07")
  tools?: Array<{                 // Optional tools array
    name: string,
    description?: string,
    parameters?: unknown
  }>,
  // toolResults is NOT included in initial request
}
```

### Messages Format (IChatMessage[])

Each message in the `messages` array follows this structure:

```typescript
{
  role: ChatMessageRole,          // 0 = System, 1 = User, 2 = Assistant
  content: Array<{
    type: "text",
    value: string
  }>
}
```

### Tools Format (if provided)

```typescript
tools: [
  {
    name: "sanitized_tool_name",
    description?: "Tool description",
    parameters?: {
      type: "object",
      properties: { ... },
      required?: string[]
    }
  }
]
```

### Complete Example - Before Tool Call

```json
{
	"model": "openai",
	"messages": [
		{
			"role": 0,
			"content": [
				{
					"type": "text",
					"value": "You can call the following tools when they would help:\n- tool_name: Tool description\nOnly call a tool if it is necessary; otherwise respond normally."
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

---

## Schema: After Tool Call (Subsequent Request)

**Location:** `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts` - Lines 327-345, 867-871, 894-984

### Request Payload Structure

```typescript
{
  model: "openai",
  messages: IChatMessage[],
  context?: string,
  modelName?: string,
  tools?: Array<{
    name: string,
    description?: string,
    parameters?: unknown
  }>,
  toolResults: ServerToolResult[]  // ✅ NOW INCLUDED
}
```

### Additional Message in Messages Array

After a tool call, the `messages` array includes an additional assistant message with tool calls converted to IDE format:

**Important:** The IDE converts `tool_calls` at message level to `tool_use` parts in the `content` array before sending to server.

```typescript
{
  role: 2,                         // ChatMessageRole.Assistant (number, not string)
  content: [                       // Array with minimum 1 item (server requirement)
    {
      type: "tool_use",
      name: string,                // Tool name
      toolCallId: string,          // Tool call ID (e.g., "call_123")
      parameters: object           // Parsed arguments object (not JSON string)
    }
  ]
}
```

**Note:** The server expects:

- `content` as an array (minimum 1 item) with `tool_use` parts
- **NOT** `tool_calls` at message level
- `role` as number (2), not string ("assistant")
- `parameters` as object, not JSON string

### Tool Results Format (ServerToolResult[])

```typescript
toolResults: [
	{
		toolCallId: string, // Matches the tool call ID from assistant message
		content: [
			{
				type: "text",
				value: string, // Tool execution result or error message
			},
		],
	},
];
```

### Complete Example - After Tool Call

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
	],
	"toolResults": [
		{
			"toolCallId": "call_abc123",
			"content": [
				{
					"type": "text",
					"value": "{\n  \"version\": \"1.0\",\n  \"settings\": {...}\n}"
				}
			]
		}
	]
}
```

---

## TypeScript Interface Definitions

### ServerRequestOptions (Lines 285-294)

```typescript
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
```

### ServerToolResult (Lines 280-283)

```typescript
interface ServerToolResult {
	readonly toolCallId: string;
	readonly content: Array<{ type: "text"; value: string }>;
}
```

### OpenAIMessage (Lines 139-145)

```typescript
interface OpenAIMessage {
	readonly role: OpenAIRole; // "system" | "user" | "assistant" | "tool"
	readonly content: string | null;
	readonly tool_calls?: OpenAIToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}
```

### OpenAIToolCall (Lines 147-154)

```typescript
interface OpenAIToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly arguments: string; // JSON stringified
	};
}
```

---

## Key Differences Summary

| Aspect            | Before Tool Call                                          | After Tool Call                                                                      |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `toolResults`     | **Not included**                                          | **Included** (ServerToolResult[])                                                    |
| `messages` array  | Standard user/assistant messages                          | **Includes assistant message with `tool_use` parts in `content`**                    |
| Assistant message | `{ role: 2, content: [{ type: "text", value: string }] }` | `{ role: 2, content: [{ type: "tool_use", name, toolCallId, parameters: object }] }` |
| Tool call format  | N/A                                                       | `tool_use` parts in `content` array (NOT `tool_calls` at message level)              |
| Tool call ID      | N/A                                                       | Present in `tool_use[].toolCallId` and `toolResults[].toolCallId`                    |
| Parameters        | N/A                                                       | Object in `tool_use[].parameters` (NOT JSON string)                                  |

---

## Request Construction Code

### Payload Construction (Lines 327-345)

```typescript
const payload: Record<string, unknown> = {
	model: "openai",
	messages: messages,
};

if (options?.context) {
	payload["context"] = options.context;
}
if (options?.modelName) {
	payload["modelName"] = options.modelName;
}
if (options?.tools !== undefined) {
	payload["tools"] = options.tools;
}
if (options?.toolResults && options.toolResults.length > 0) {
	payload["toolResults"] = options.toolResults; // Only added after tool call
}
```

### Tool Call Message Addition (Lines 859-871)

**Internal Format (OpenAIMessage):**

```typescript
const toolCalls: OpenAIToolCall[] = toolCallParts.map((part) => ({
	id: part.toolCall!.id,
	type: "function",
	function: {
		name: part.toolCall!.name,
		arguments: JSON.stringify(part.toolCall!.args),
	},
}));
messages.push({
	role: "assistant",
	content: null,
	tool_calls: toolCalls,
});
```

**Converted Format (IChatMessage) - Before sending to server:**
The `convertOpenAIMessagesToIDE()` function (Lines 1343-1416) converts this to:

```typescript
{
  role: 2, // ChatMessageRole.Assistant
  content: [
    {
      type: "tool_use",
      name: toolCall.function.name,
      toolCallId: toolCall.id,
      parameters: JSON.parse(toolCall.function.arguments) // Object, not string
    }
  ]
}
```

### Tool Result Construction (Lines 953-956)

```typescript
toolResultsForNextRequest.push({
	toolCallId: callId,
	content: [{ type: "text", value: textOutput }],
});
```

---

## HTTP Request Headers

```typescript
{
  "Content-Type": "application/json",
  "Authorization": "Bearer <accessToken>",
  "Accept": "text/event-stream"
}
```

---

## Endpoint

All requests are sent to:

```
POST {serverAddress}/api/agent/tools
```

---

## Notes

1. **Tool Call Format Conversion**:

   - **Internal (OpenAIMessage)**: `tool_calls` at message level with `arguments` as JSON string
   - **Server (IChatMessage)**: `tool_use` parts in `content` array with `parameters` as object
   - Conversion happens in `convertOpenAIMessagesToIDE()` (Lines 1343-1416)

2. **Tool Call Arguments**:

   - Internally stored as JSON string in `tool_calls[].function.arguments`
   - Converted to object in `tool_use[].parameters` before sending to server
   - Server expects object, not JSON string

3. **Assistant Message Format**:

   - Server expects: `{ role: 2, content: [{ type: "tool_use", ... }] }`
   - Server does NOT expect: `{ role: "assistant", content: null, tool_calls: [...] }`
   - `content` array must have minimum 1 item when tool calls exist

4. **Role Format**:

   - Server expects `role` as number (0 = System, 1 = User, 2 = Assistant)
   - Not string ("system", "user", "assistant")

5. **Tool Results Content**: The `content` array in `toolResults` always contains objects with `type: "text"` and a `value` string. Multiple text parts are joined with `\n` before being sent.

6. **Message Order**: The assistant message with tool calls is added to the messages array **before** the next request is sent, ensuring proper conversation history.

7. **Tool Call ID Matching**: The `toolCallId` in `toolResults` must exactly match the `toolCallId` in the corresponding `tool_use` part from the assistant message.

8. **Empty Tool Results**: If `toolResults` is empty or undefined, it is not included in the payload.
