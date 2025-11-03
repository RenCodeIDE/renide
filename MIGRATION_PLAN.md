# Migration Plan: IDE Always Sends IDE Format, Remove OpenAI Format Support

## Goal
Ensure the IDE **always** sends IDE format messages to the server, and remove all OpenAI format handling/normalization from the server.

## Current State Analysis

### IDE Code Flow
1. **Internal Format (OpenAIMessage)**: Used internally for conversation management
   - `role: "assistant" | "user" | "system"` (string)
   - `content: string | null`
   - `tool_calls?: OpenAIToolCall[]` at message level
   - `arguments: string` (JSON stringified)

2. **Conversion Point**: `convertOpenAIMessagesToIDE()` (Line 1443)
   - Called in `performRequest()` before `sendChatGPTRequest()`
   - Converts to IDE format

3. **Server Format (IChatMessage)**: What should be sent
   - `role: ChatMessageRole` (number: 0, 1, 2)
   - `content: IChatMessagePart[]` (array, minimum 1 when tool_calls exist)
   - `tool_use` parts in content array (NOT tool_calls at message level)
   - `parameters: object` (NOT JSON string)

### Problem
- Conversion may not be enforced in all code paths
- No validation that messages are in IDE format before sending
- Server may still accept OpenAI format and normalize it

---

## Phase 1: IDE Hardening (IDE Repository)

### Step 1.1: Add Runtime Validation Function
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: After `convertOpenAIMessagesToIDE()` function

**Action**: Create validation function to ensure messages are in IDE format:

```typescript
/**
 * Validates that messages are in IDE format (not OpenAI format).
 * Throws error if OpenAI format detected.
 */
private validateIDEFormat(messages: IChatMessage[]): void {
	for (const msg of messages) {
		// 1. Role must be number (ChatMessageRole enum)
		if (typeof msg.role !== 'number') {
			throw new Error(
				`Invalid message format: role must be number (0, 1, 2), got ${typeof msg.role}: ${msg.role}`
			);
		}
		if (msg.role < 0 || msg.role > 2) {
			throw new Error(`Invalid message format: role must be 0-2, got ${msg.role}`);
		}

		// 2. Content must be array (not null, not string)
		if (!Array.isArray(msg.content)) {
			throw new Error(
				`Invalid message format: content must be array, got ${typeof msg.content}. ` +
				`This suggests OpenAI format (content: null) was not converted.`
			);
		}

		// 3. Content array must have at least 1 item
		if (msg.content.length === 0) {
			throw new Error(
				`Invalid message format: content array must have minimum 1 item, got empty array`
			);
		}

		// 4. Check for OpenAI format indicators (should not exist)
		const hasToolCalls = (msg as any).tool_calls !== undefined;
		if (hasToolCalls) {
			throw new Error(
				`Invalid message format: tool_calls at message level detected. ` +
				`Should be converted to tool_use parts in content array.`
			);
		}

		// 5. Validate content parts
		for (const part of msg.content) {
			if (part.type === 'tool_use') {
				// Parameters must be object, not string
				if (typeof part.parameters !== 'object' || part.parameters === null) {
					throw new Error(
						`Invalid message format: tool_use.parameters must be object, got ${typeof part.parameters}`
					);
				}
				if (Array.isArray(part.parameters)) {
					throw new Error(
						`Invalid message format: tool_use.parameters must be object, got array`
					);
				}
			}
		}
	}
}
```

**Validation Points**:
- ✅ Role is number (0, 1, 2)
- ✅ Content is array (not null, not string)
- ✅ Content array has minimum 1 item
- ✅ No `tool_calls` at message level
- ✅ `tool_use.parameters` is object (not string)

---

### Step 1.2: Add Validation Call Before Sending
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: `performRequest()` method, after line 1443

**Action**: Add validation call immediately after conversion:

```typescript
// Convert messages to IDE format
const ideMessages = this.convertOpenAIMessagesToIDE(messages);

// CRITICAL: Validate format before sending (fail fast if conversion missed something)
this.validateIDEFormat(ideMessages);

// Log validation success
this.logService.debug(
	`[chatgpt-server] Message format validation passed: ${ideMessages.length} messages in IDE format`
);
```

**Why**: Fail fast if conversion didn't work or was bypassed.

---

### Step 1.3: Add Validation in sendChatGPTRequest
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: `sendChatGPTRequest()` function, after line 329

**Action**: Add validation as a safety net:

```typescript
async function sendChatGPTRequest(
	requestService: IRequestService,
	accessToken: string | undefined,
	serverAddress: string,
	endpoint: "/api/agent/tools",
	messages: IChatMessage[],  // Should already be IDE format
	token: CancellationToken,
	options?: ServerRequestOptions,
	logService?: ILogService,
): Promise<ChatGPTStreamingResponse> {
	// Safety check: validate IDE format before sending
	validateIDEFormatStatic(messages, logService);

	const payload: Record<string, unknown> = {
		model: "openai",
		messages: messages,
	};
	// ... rest of function
}

// Helper function (can be exported from class or defined here)
function validateIDEFormatStatic(messages: IChatMessage[], logService?: ILogService): void {
	// Same validation logic as class method
	// ... (copy from Step 1.1)
}
```

**Why**: Double-check even if `performRequest()` already validated.

---

### Step 1.4: Add Type Assertions
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: `sendChatGPTRequest()` function signature

**Action**: Ensure type system enforces IDE format:

```typescript
// Change parameter type to be more explicit
async function sendChatGPTRequest(
	// ... other params
	messages: IChatMessage[],  // Already IDE format - no OpenAI format allowed
	// ... rest
)
```

**Note**: TypeScript won't catch runtime issues, but this documents intent.

---

### Step 1.5: Add Logging for Debugging
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: `convertOpenAIMessagesToIDE()` function

**Action**: Add detailed logging:

```typescript
private convertOpenAIMessagesToIDE(messages: OpenAIMessage[]): IChatMessage[] {
	this.logService.debug(
		`[chatgpt-server] Converting ${messages.length} messages from OpenAI format to IDE format`
	);

	const ideMessages: IChatMessage[] = [];
	for (const msg of messages) {
		// ... existing conversion logic ...

		// Log conversion details
		if (msg.tool_calls && msg.tool_calls.length > 0) {
			this.logService.debug(
				`[chatgpt-server] Converting ${msg.tool_calls.length} tool_calls to tool_use parts`
			);
		}
	}

	this.logService.debug(
		`[chatgpt-server] Conversion complete: ${ideMessages.length} messages in IDE format`
	);

	return ideMessages;
}
```

---

### Step 1.6: Remove Any Direct OpenAI Format Sending
**File**: `src/vs/workbench/contrib/chat/browser/chatgpt.contribution.ts`
**Location**: Search entire file for any direct `OpenAIMessage[]` being sent

**Action**:
- Search for: `sendChatGPTRequest(.*OpenAIMessage`
- Ensure all paths go through `convertOpenAIMessagesToIDE()`
- If any bypass found, fix it

---

## Phase 2: Server-Side Changes (Server Repository)

### Step 2.1: Update Request Schema Validation
**File**: `src/routes/agent.ts` or wherever Zod schemas are defined

**Action**: Update schema to ONLY accept IDE format:

```typescript
// BEFORE (accepts both formats):
const agentToolRequestSchema = z.object({
	model: z.string(),
	messages: z.array(
		z.union([
			// OpenAI format
			z.object({
				role: z.enum(['system', 'user', 'assistant']),
				content: z.string().nullable(),
				tool_calls: z.array(...).optional(),
			}),
			// IDE format
			z.object({
				role: z.number().int().min(0).max(2),
				content: z.array(...),
			}),
		])
	),
	// ...
});

// AFTER (IDE format only):
const agentToolRequestSchema = z.object({
	model: z.string(),
	messages: z.array(
		z.object({
			role: z.number().int().min(0).max(2),  // 0=System, 1=User, 2=Assistant
			content: z.array(
				z.union([
					z.object({
						type: z.literal('text'),
						value: z.string(),
					}),
					z.object({
						type: z.literal('tool_use'),
						name: z.string(),
						toolCallId: z.string(),
						parameters: z.record(z.unknown()),  // Object, not string
					}),
				])
			).min(1),  // Minimum 1 item required
		})
	).min(1),
	tools: z.array(...).optional(),
	toolResults: z.array(...).optional(),
	// ...
});
```

**Validation Rules**:
- ✅ `role` must be number (0, 1, 2)
- ✅ `content` must be array (not null, not string)
- ✅ `content` array minimum 1 item
- ✅ No `tool_calls` at message level
- ✅ `tool_use.parameters` must be object (not string)

---

### Step 2.2: Remove OpenAI Format Normalization
**File**: `src/utils/agent-helpers/openai.ts` or wherever normalization happens

**Action**: Remove any code that converts OpenAI format to IDE format:

```typescript
// DELETE any functions like:
// - convertOpenAIMessagesFromClient()
// - normalizeMessageFormat()
// - handleOpenAIFormat()
// - Any code checking for `tool_calls` at message level
// - Any code checking for `role` as string
// - Any code checking for `content: null`

// If server receives OpenAI format, return 400 error instead of normalizing
```

**Search for**:
- `tool_calls` (at message level)
- `content: null`
- `role: "assistant"` (string)
- `arguments: string` (JSON string in tool calls)

---

### Step 2.3: Update Error Messages
**File**: `src/routes/agent.ts` or error handling

**Action**: Return clear error if OpenAI format detected:

```typescript
// In request validation
if (detectOpenAIFormat(messages)) {
	return res.status(400).json({
		error: 'Invalid message format',
		message: 'Server only accepts IDE format. ' +
			'IDE must convert OpenAI format to IDE format before sending. ' +
			'Received: OpenAI format (role as string, tool_calls at message level). ' +
			'Expected: IDE format (role as number, tool_use in content array).',
		details: {
			expected: {
				role: 'number (0, 1, 2)',
				content: 'array with minimum 1 item',
				toolFormat: 'tool_use parts in content array',
			},
			received: {
				role: typeof firstMessage.role,
				content: typeof firstMessage.content,
				hasToolCalls: !!(firstMessage as any).tool_calls,
			},
		},
	});
}

function detectOpenAIFormat(messages: any[]): boolean {
	if (messages.length === 0) return false;
	const first = messages[0];

	// Check for OpenAI format indicators
	if (typeof first.role === 'string') return true;  // Should be number
	if (first.content === null) return true;  // Should be array
	if (!Array.isArray(first.content)) return true;
	if ((first as any).tool_calls !== undefined) return true;  // Should be in content

	return false;
}
```

---

### Step 2.4: Update Documentation/Comments
**File**: All server files that mention message format

**Action**: Update comments/docs to state "IDE format only":

```typescript
/**
 * Handles OpenAI agent tool requests.
 *
 * IMPORTANT: Server ONLY accepts IDE format messages:
 * - role: number (0=System, 1=User, 2=Assistant)
 * - content: array (minimum 1 item)
 * - tool_use parts in content array (NOT tool_calls at message level)
 * - parameters: object (NOT JSON string)
 *
 * The IDE is responsible for converting from OpenAI format to IDE format
 * before sending. Server will reject OpenAI format with 400 error.
 */
```

---

### Step 2.5: Remove Type Definitions for OpenAI Format
**File**: Server type definition files

**Action**: Remove or deprecate OpenAI format types:

```typescript
// DELETE or mark as deprecated:
// interface OpenAIMessageFormat { ... }
// type MessageFormat = OpenAIFormat | IDEFormat;
// function normalizeToIDEFormat(msg: OpenAIFormat): IDEFormat { ... }

// Keep only IDE format types:
interface IDEFormatMessage {
	role: 0 | 1 | 2;
	content: Array<IDETextPart | IDEToolUsePart>;
}
```

---

## Phase 3: Testing & Validation

### Step 3.1: IDE Unit Tests
**File**: Test files for `chatgpt.contribution.ts`

**Action**: Add tests:

```typescript
describe('convertOpenAIMessagesToIDE', () => {
	it('should convert OpenAI format to IDE format', () => {
		const openaiMsg: OpenAIMessage = {
			role: 'assistant',
			content: null,
			tool_calls: [{
				id: 'call_123',
				type: 'function',
				function: {
					name: 'test_tool',
					arguments: '{"param": "value"}',
				},
			}],
		};

		const result = convertOpenAIMessagesToIDE([openaiMsg]);

		expect(result[0].role).toBe(2);  // ChatMessageRole.Assistant
		expect(Array.isArray(result[0].content)).toBe(true);
		expect(result[0].content.length).toBeGreaterThan(0);
		expect(result[0].content[0].type).toBe('tool_use');
		expect(typeof result[0].content[0].parameters).toBe('object');
	});

	it('should throw if OpenAI format detected after conversion', () => {
		// Test validation function
	});
});
```

---

### Step 3.2: Server Integration Tests
**File**: Server test files

**Action**: Add tests:

```typescript
describe('POST /api/agent/tools', () => {
	it('should accept IDE format messages', async () => {
		const response = await request(app)
			.post('/api/agent/tools')
			.send({
				model: 'openai',
				messages: [{
					role: 2,
					content: [{
						type: 'tool_use',
						name: 'test_tool',
						toolCallId: 'call_123',
						parameters: { param: 'value' },
					}],
				}],
			});

		expect(response.status).toBe(200);
	});

	it('should reject OpenAI format messages with 400', async () => {
		const response = await request(app)
			.post('/api/agent/tools')
			.send({
				model: 'openai',
				messages: [{
					role: 'assistant',  // String instead of number
					content: null,  // Null instead of array
					tool_calls: [...],  // At message level
				}],
			});

		expect(response.status).toBe(400);
		expect(response.body.error).toContain('Invalid message format');
	});
});
```

---

### Step 3.3: End-to-End Test
**Action**: Manual test flow:

1. IDE sends message with tool call
2. Verify network request shows IDE format (role: 2, content: array with tool_use)
3. Server receives and processes correctly
4. Tool results sent back
5. Next request includes tool results and IDE format messages

---

## Phase 4: Deployment & Rollout

### Step 4.1: IDE Deployment
1. Deploy IDE changes with validation
2. Monitor logs for validation errors
3. If errors occur, fix conversion bugs

### Step 4.2: Server Deployment
1. Deploy server changes (reject OpenAI format)
2. Monitor for 400 errors
3. If errors occur, check if IDE is sending OpenAI format (shouldn't happen if Phase 1 worked)

### Step 4.3: Rollback Plan
- If issues: Revert server changes first (allow both formats temporarily)
- Fix IDE issues
- Redeploy server changes

---

## Checklist

### IDE (Phase 1)
- [ ] Add `validateIDEFormat()` function
- [ ] Call validation in `performRequest()` after conversion
- [ ] Call validation in `sendChatGPTRequest()` as safety net
- [ ] Add logging in `convertOpenAIMessagesToIDE()`
- [ ] Verify no code paths bypass conversion
- [ ] Add unit tests for conversion and validation

### Server (Phase 2)
- [ ] Update Zod schema to only accept IDE format
- [ ] Remove OpenAI format normalization code
- [ ] Add error handling for OpenAI format (return 400)
- [ ] Update documentation/comments
- [ ] Remove OpenAI format type definitions
- [ ] Add integration tests

### Testing (Phase 3)
- [ ] IDE unit tests pass
- [ ] Server integration tests pass
- [ ] End-to-end test passes
- [ ] Manual verification

---

## Success Criteria

1. ✅ IDE always sends IDE format (validated before sending)
2. ✅ Server rejects OpenAI format with clear 400 error
3. ✅ Server has no normalization code (removed)
4. ✅ All tests pass
5. ✅ No runtime errors in production

---

## Timeline Estimate

- **Phase 1 (IDE)**: 2-3 hours
- **Phase 2 (Server)**: 2-3 hours
- **Phase 3 (Testing)**: 2-3 hours
- **Phase 4 (Deployment)**: 1 hour

**Total**: ~8-10 hours

---

## Notes

- This is a breaking change for server (if it currently accepts OpenAI format)
- IDE changes are non-breaking (just adds validation)
- Deploy IDE first, then server (to avoid breaking existing clients if any)
- Monitor logs closely during rollout

