# Tool Calls Retrieval - Exact Files

This document shows the exact files and methods where tool calls are retrieved for the ChatGPT agent.

## Flow Overview

```
Tool Registration → Tool Storage → Tool Retrieval → Tool Filtering → Tool Declaration
```

---

## 1. Tool Storage (Central Repository)

**File**: `src/vs/workbench/contrib/chat/browser/languageModelToolsService.ts`

**Storage Location**: Line 89
```typescript
private _tools = new Map<string, IToolEntry>();
```

**Method to Get ALL Tools**: Lines 205-214
```typescript
getTools(includeDisabled?: boolean): Iterable<Readonly<IToolData>> {
    const toolDatas = Iterable.map(this._tools.values(), i => i.data);
    const extensionToolsEnabled = this._configurationService.getValue<boolean>(ChatConfiguration.ExtensionToolsEnabled);
    return Iterable.filter(
        toolDatas,
        toolData => {
            const satisfiesWhenClause = includeDisabled || !toolData.when || this._contextKeyService.contextMatchesRules(toolData.when);
            const satisfiesExternalToolCheck = toolData.source.type !== 'extension' || !!extensionToolsEnabled;
            return satisfiesWhenClause && satisfiesExternalToolCheck;
        });
}
```

**What it does**:
- Returns all registered tools from the `_tools` Map
- Filters by context key rules (`when` clauses)
- Filters by extension tools enabled setting

---

## 2. Tool Filtering (Which Tools Are Allowed)

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`

**Method**: `getAllowedToolData()` - Lines 461-485
```typescript
private getAllowedToolData(requestId: string): IToolData[] {
    const selected = this.requestTools.get(requestId);
    if (!selected) {
        const allTools = Array.from(this.languageModelToolsService.getTools());
        this.logService.debug(`[chatgpt] no tools selected for request ${requestId}, using all ${allTools.length} registered tools`);
        return allTools;
    }
    const allowedIds = Object.keys(selected).filter((id) => selected[id] === true);
    if (!allowedIds.length) {
        const allTools = Array.from(this.languageModelToolsService.getTools());
        this.logService.debug(`[chatgpt] tool selection for request ${requestId} contained no enabled entries, using all ${allTools.length} registered tools`);
        return allTools;
    }
    const allowedSet = new Set(allowedIds);
    const allowedTools: IToolData[] = [];
    for (const tool of this.languageModelToolsService.getTools()) {
        if (allowedSet.has(tool.id)) {
            allowedTools.push(tool);
        }
    }
    this.logService.debug(
        `[chatgpt] resolved ${allowedTools.length} tools for request ${requestId}: ${allowedTools.map((tool) => tool.id).join(', ')}`,
    );
    return allowedTools;
}
```

**What it does**:
1. Checks if user selected specific tools for this request
2. If no selection → returns ALL tools from `languageModelToolsService.getTools()`
3. If selection exists → filters to only enabled tools
4. Returns the filtered list

**Called from**: Line 491 in `buildChatGPTToolDeclarations()`

---

## 3. Tool Declaration Building

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`

**Method**: `buildChatGPTToolDeclarations()` - Lines 487-531
```typescript
private buildChatGPTToolDeclarations(requestId: string): {
    tools: OpenAIFunction[];
    nameToToolId: Map<string, string>;
} {
    const allowedTools = this.getAllowedToolData(requestId);  // ← Gets tools here
    if (!allowedTools.length) {
        return { tools: [], nameToToolId: new Map() };
    }

    const usedNames = new Set<string>();
    const nameToToolId = new Map<string, string>();
    const functions: OpenAIFunction[] = [];

    for (let index = 0; index < allowedTools.length; index++) {
        const tool = allowedTools[index];
        const functionName = this.sanitizeToolName(tool, index, usedNames);
        usedNames.add(functionName);
        nameToToolId.set(functionName, tool.id);

        const descriptionParts: string[] = [];
        if (tool.displayName && tool.displayName !== tool.toolReferenceName) {
            descriptionParts.push(tool.displayName);
        }
        if (tool.modelDescription) {
            descriptionParts.push(tool.modelDescription);
        }
        if (tool.userDescription) {
            descriptionParts.push(tool.userDescription);
        }

        const description = descriptionParts.length ? descriptionParts.join(' ') : undefined;
        const parameters = tool.inputSchema ?? { type: 'object', properties: {} };

        functions.push({
            type: 'function',
            function: {
                name: functionName,
                description,
                parameters,
            },
        });
    }

    return { tools: functions, nameToToolId };
}
```

**What it does**:
1. Calls `getAllowedToolData()` to get filtered tools
2. Converts each tool to OpenAI function format
3. Sanitizes tool names
4. Creates name-to-ID mapping
5. Returns formatted tool declarations

**Called from**: Line 132 in `invoke()` method

---

## 4. Tool Usage in System Prompt

**File**: `src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`

**Location**: Lines 132-150

```typescript
const { tools: toolConfigs, nameToToolId } = this.buildChatGPTToolDeclarations(request.requestId);

// ... later ...

if (toolConfigs.length > 0) {
    const toolSummaries = Array.from(nameToToolId.keys())
        .map((name) => {
            const toolId = nameToToolId.get(name);
            const toolsArray = Array.from(this.languageModelToolsService.getTools());  // ← Gets tools again here
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

**What it does**:
- Uses `buildChatGPTToolDeclarations()` to get tool configs
- Creates system prompt with tool summaries
- Calls `languageModelToolsService.getTools()` again to get tool details for descriptions

---

## 5. Where Tools Come From (Registration Sources)

### A. Built-in Tools
**File**: `src/vs/workbench/contrib/chat/common/tools/tools.ts`
- Registers: `EditTool`, `ManageTodoListTool`, `ConfirmationTool`
- Uses: `toolsService.registerTool(toolData, tool)`

### B. MCP Tools
**File**: `src/vs/workbench/contrib/mcp/common/mcpLanguageModelToolContribution.ts`
- Registers: All tools from MCP servers
- Syncs tools from MCP servers automatically
- Uses: `toolsService.registerTool(toolData, tool)` (lines 128, 133)

### C. Extension Tools
**File**: `src/vs/workbench/api/common/extHostLanguageModelTools.ts`
- Registers: Tools from VS Code extensions
- Uses: Extension API to register tools

### D. Tool Sets
**File**: `src/vs/workbench/contrib/chat/browser/tools/toolSetsContribution.ts`
- Registers: User-defined tool sets
- Groups multiple tools together

---

## Complete Call Chain

```
1. languageModelToolsService.getTools()
   ↓
   File: languageModelToolsService.ts, Line 205
   Returns: All tools from _tools Map (filtered by context)

2. getAllowedToolData(requestId)
   ↓
   File: chatgpt/agent.ts, Line 461
   Calls: languageModelToolsService.getTools()
   Returns: Filtered tools based on user selection

3. buildChatGPTToolDeclarations(requestId)
   ↓
   File: chatgpt/agent.ts, Line 487
   Calls: getAllowedToolData(requestId)
   Returns: OpenAI-formatted tool declarations

4. invoke() method
   ↓
   File: chatgpt/agent.ts, Line 132
   Calls: buildChatGPTToolDeclarations(request.requestId)
   Uses: toolConfigs to send to server
```

---

## Summary Table

| Action | File | Method/Line | What It Does |
|--------|------|-------------|--------------|
| **Store Tools** | `languageModelToolsService.ts` | `_tools` Map (line 89) | Central storage for all tools |
| **Get All Tools** | `languageModelToolsService.ts` | `getTools()` (line 205) | Returns all registered tools |
| **Filter Tools** | `chatgpt/agent.ts` | `getAllowedToolData()` (line 461) | Filters by user selection |
| **Build Declarations** | `chatgpt/agent.ts` | `buildChatGPTToolDeclarations()` (line 487) | Converts to OpenAI format |
| **Use in Request** | `chatgpt/agent.ts` | `invoke()` (line 132) | Sends tools to server |

---

## Key Points

1. **All tools are stored** in `LanguageModelToolsService._tools` Map
2. **Tools are retrieved** via `languageModelToolsService.getTools()`
3. **Tools are filtered** in `getAllowedToolData()` based on user selection
4. **If no selection**, ALL tools are used
5. **Tools come from**: Built-in, MCP servers, Extensions, and Tool Sets

