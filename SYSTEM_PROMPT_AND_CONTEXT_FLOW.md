# System Prompt and Context Flow Documentation

This document explains where the system prompt is set, where context is attached to tools, and where that context comes from in the ChatGPT agent implementation.

## Overview

The ChatGPT agent flow involves:
1. **System Prompt**: Instructions about available tools
2. **Context Building**: Converting attached files/code into a context string
3. **Context Attachment**: Sending context to the server
4. **Tool Context**: Providing session/request IDs to tools when invoked

---

## 1. System Prompt Location

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`
**Lines**: 147-150

The system prompt is added when tools are available:

```typescript
if (toolConfigs.length > 0) {
    const toolSummaries = Array.from(nameToToolId.keys())
        .map((name) => {
            const toolId = nameToToolId.get(name);
            const toolsArray = Array.from(this.languageModelToolsService.getTools());
            const tool = toolsArray.find((t: IToolData) => t.id === toolId);
            const desc = tool?.modelDescription || tool?.displayName || name;
            return `- ${name}: ${desc}`;
        })
        .join('\n');
    messages.unshift({
        role: 'system',
        content: `You can call the following tools when they would help:\n${toolSummaries}\nOnly call a tool if it is necessary; otherwise respond normally.`,
    });
}
```

**What it does**: Creates a system message listing all available tools and their descriptions, instructing the AI to only use tools when necessary.

---

## 2. Context Building and Attachment

### Step 1: Build Context Prompt

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/context.ts`
**Method**: `buildContextPrompt()` (lines 26-84)

This method:
1. Reads `request.variables?.variables` (line 30)
2. Processes each variable entry (files, pasted code, etc.)
3. Loads file contents and formats them as code blocks
4. Returns a formatted prompt string

**Key Code**:
```typescript
async buildContextPrompt(
    request: IChatAgentRequest,
    token: CancellationToken,
): Promise<IContextPromptResult | undefined> {
    const variables = request.variables?.variables ?? [];
    // ... processes variables into code blocks ...
    const prompt = [
        'You are an expert coding assistant embedded in the IDE. The code blocks below are the exact context the user means -- even if they refer to them with vague terms like \'this\', \'the file\', or \'the function\'.',
        'Ground every response in those blocks: explain behaviour, data structures, and error cases using only the provided code. Mention the relevant file or block when helpful, and if the answer cannot be derived from this context, say so explicitly before offering any speculation.',
        ...blocks,
    ].join('\n\n');
    return { prompt, entries: metadata };
}
```

### Step 2: Use Context in Agent

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`
**Lines**: 134-170

The context is built and passed to the request:

```typescript
const contextPrompt = await this.contextBuilder.buildContextPrompt(request, token);
const contextString = contextPrompt?.prompt;

// ... later ...

const streamingResponse = await this.performRequest(
    messages,
    toolConfigs,
    token,
    modelToUse,
    contextString,  // ← Context passed here
    toolResults,
);
```

### Step 3: Send Context to Server

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`
**Lines**: 676-690

The context is included in the server request:

```typescript
const response = await sendChatGPTRequest(
    this.requestService,
    accessToken,
    this.serverAddress,
    endpoint,
    ideMessages,
    token,
    {
        context,  // ← Context attached here
        modelName: model,
        tools: serverTools,
        toolResults: hasToolResults ? toolResults : undefined,
    },
    this.logService,
);
```

---

## 3. Where Context Comes From

### The Flow Chain

1. **User attaches files** → Stored in `attachedContext`
2. **ChatService prepares context** → Converts to `variables`
3. **ContextBuilder builds prompt** → Creates formatted string
4. **Agent attaches to request** → Sends to server

### Step 1: Context Preparation

**File**: `src/vs/workbench/contrib/chat/common/chatServiceImpl.ts`
**Lines**: 768-784

The `attachedContext` is converted to `variables`:

```typescript
const prepareChatAgentRequest = (agent: IChatAgentData, ...): IChatAgentRequest => {
    request = chatRequest ?? model.addRequest(
        parsedRequest,
        initVariableData,
        attempt,
        options?.modeInfo,
        agent,
        command,
        options?.confirmation,
        options?.locationData,
        options?.attachedContext,  // ← Source of context
        undefined,
        options?.userSelectedModelId
    );

    // ...

    variableData = { variables: this.prepareContext(request.attachedContext) };
    model.updateRequest(request, variableData);
}
```

### Step 2: Prepare Context Method

**File**: `src/vs/workbench/contrib/chat/common/chatServiceImpl.ts`
**Lines**: 1000-1019

The `prepareContext` method sorts and processes the attached context:

```typescript
private prepareContext(attachedContextVariables: IChatRequestVariableEntry[] | undefined): IChatRequestVariableEntry[] {
    attachedContextVariables ??= [];

    // Sort by range (high index first) for proper replacement
    attachedContextVariables.sort((a, b) => {
        if (!a.range && !b.range) {
            return 0;
        }
        if (!a.range) {
            return 1;
        }
        if (!b.range) {
            return -1;
        }
        return b.range.start - a.range.start;
    });

    return attachedContextVariables;
}
```

### Step 3: Context Source

The `attachedContext` originates from:
- **ChatInputPart**: User attachments via `attachmentModel`
- **Options**: Passed through `options?.attachedContext` in `chatServiceImpl.ts`

---

## 4. Tool Context (sessionId/requestId)

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`
**Method**: `createToolInvocation()` (lines 705-718)

When a tool is invoked, context is created with session and request IDs:

```typescript
private createToolInvocation(
    callId: string,
    toolId: string,
    parameters: Record<string, unknown>,
    request: IChatAgentRequest,
): IToolInvocation {
    return {
        callId,
        toolId,
        parameters,
        context: { sessionId: request.sessionId },  // ← Session ID
        chatRequestId: request.requestId,           // ← Request ID
    };
}
```

**Usage**: Tools use this context to:
- Know which chat session they're part of
- Track which request triggered them
- Access session-specific data

**Example**: MCP tools use this in `src/vs/workbench/contrib/mcp/common/mcpServer.ts`:
```typescript
const meta: Record<string, unknown> = {};
if (context?.chatSessionId) {
    meta['vscode.conversationId'] = context.chatSessionId;
}
if (context?.chatRequestId) {
    meta['vscode.requestId'] = context.chatRequestId;
}
```

---

## Complete Flow Diagram

```
User attaches file/code
    ↓
ChatInputPart.attachmentModel
    ↓
options?.attachedContext (in chatServiceImpl)
    ↓
chatServiceImpl.prepareContext()
    → Converts to IChatRequestVariableEntry[]
    ↓
request.variables.variables
    ↓
contextBuilder.buildContextPrompt()
    → Loads file contents
    → Formats as code blocks
    → Returns context string
    ↓
agent.invoke() → contextString
    ↓
agent.performRequest(contextString)
    ↓
sendChatGPTRequest({ context: contextString, ... })
    → Sends to server
```

---

## Key Files Summary

| Component | File | Key Method/Line |
|-----------|------|-----------------|
| **System Prompt** | `chatgpt/agent.ts` | Lines 147-150 |
| **Context Building** | `chatgpt/context.ts` | `buildContextPrompt()` |
| **Context Attachment** | `chatgpt/agent.ts` | Lines 134, 170, 684 |
| **Context Source** | `chatServiceImpl.ts` | `prepareContext()` line 778 |
| **Tool Context** | `chatgpt/agent.ts` | `createToolInvocation()` line 715 |

---

## Notes

- The system prompt is **only added when tools are available**
- Context is built **asynchronously** (may load file contents)
- Context can be **undefined** if no files/code are attached
- Tool context (`sessionId`/`requestId`) is **always included** when invoking tools
- The context string includes a **preamble** explaining how to use the code blocks

