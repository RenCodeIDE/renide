# ChatGPT Files Overview

## Main File Structure

### 1. **chatgpt.contribution.ts** (2,255 lines)
**Location**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`

This is the main implementation file containing:
- Type definitions
- Format conversion functions
- Validation functions
- HTTP request handling
- Main agent implementation class

---

## Key Sections

### Type Definitions (Lines 137-294)

```typescript
// Internal OpenAI format (used for conversation management)
type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool';

interface OpenAIMessage {
	readonly role: OpenAIRole;
	readonly content: string | null;
	readonly tool_calls?: OpenAIToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}

interface OpenAIToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;  // JSON string
	};
}

// Server request/response types
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
```

### Validation Functions (Lines 271-345)

```typescript
// Static validation function (used in sendChatGPTRequest)
function validateIDEFormatStatic(messages: IChatMessage[], logService?: ILogService): void {
	// Validates:
	// 1. Role is number (0, 1, 2)
	// 2. Content is array (not null)
	// 3. Content array has minimum 1 item
	// 4. No tool_calls at message level
	// 5. tool_use.parameters is object (not string)
}
```

### HTTP Request Function (Lines 347-490)

```typescript
async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: '/api/agent/tools',
	messages: IChatMessage[],  // IDE format
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
): Promise<ChatGPTStreamingResponse> {
	// 1. Validates IDE format
	// 2. Builds payload
	// 3. Sends HTTP POST request
	// 4. Handles SSE stream response
}
```

### Format Conversion (Lines 1374-1457)

```typescript
private convertOpenAIMessagesToIDE(messages: OpenAIMessage[]): IChatMessage[] {
	// Converts:
	// - role: string → number (0, 1, 2)
	// - content: null → array with tool_use parts
	// - tool_calls at message level → tool_use in content array
	// - arguments: JSON string → parameters: object
}
```

### Format Validation (Lines 1470-1534)

```typescript
private validateIDEFormat(messages: IChatMessage[]): void {
	// Validates all messages are in IDE format before sending
	// Throws error if OpenAI format detected
}
```

### Main Request Handler (Lines 1536-1605)

```typescript
private async performRequest(
	messages: OpenAIMessage[],
	tools: OpenAIFunction[],
	token: CancellationToken,
	model: string,
	context?: string,
	toolResults?: ServerToolResult[],
): Promise<ChatGPTStreamingResponse> {
	// 1. Converts messages to IDE format
	// 2. Validates format
	// 3. Converts tools
	// 4. Calls sendChatGPTRequest
}
```

### Tool Call Handling (Lines 947-1079)

```typescript
// When tool calls are received from server:
// 1. Extract tool call parts
// 2. Add assistant message with tool_calls (OpenAI format)
// 3. Execute tools
// 4. Build toolResults for next request
// 5. Continue loop (tool_calls will be converted before sending)
```

### Agent Implementation Class (Lines 742-2255)

```typescript
class ChatGPTAgentImplementation implements IChatAgentImplementation {
	// Main class that implements:
	// - invoke() - Main entry point
	// - setRequestTools() - Tool selection
	// - All conversion and validation methods
	// - Message building
	// - Tool execution
}
```

---

## Schema Documentation

### CHATGPT_SCHEMA.md
**Location**: `CHATGPT_SCHEMA.md` (430 lines)

Contains:
- Request/response schemas
- Before/after tool call examples
- Type definitions
- Code references
- Notes on format conversion

---

## Key Data Flow

```
1. User sends message
   ↓
2. invoke() called
   ↓
3. buildMessages() - Creates OpenAIMessage[] (internal format)
   ↓
4. performRequest()
   ↓
5. convertOpenAIMessagesToIDE() - Converts to IDE format
   ↓
6. validateIDEFormat() - Validates conversion
   ↓
7. sendChatGPTRequest()
   ↓
8. validateIDEFormatStatic() - Double-check validation
   ↓
9. HTTP POST to server (IDE format only)
   ↓
10. Server processes and returns tool calls
   ↓
11. Tool calls added as OpenAIMessage (internal format)
   ↓
12. Tools executed
   ↓
13. Loop back to step 4 (with toolResults)
```

---

## File Locations

- **Main Implementation**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
- **Schema Docs**: `CHATGPT_SCHEMA.md`
- **Schema & Code Reference**: `SCHEMAS_AND_CODE.md`
- **Migration Plan**: `MIGRATION_PLAN.md`

---

## Important Notes

1. **OpenAI Format**: Used internally only, never sent to server
2. **IDE Format**: Only format sent to server
3. **Double Validation**: Both `performRequest()` and `sendChatGPTRequest()` validate
4. **Conversion**: Always happens before sending
5. **Tool Calls**: Converted from `tool_calls` → `tool_use` parts in `content` array

