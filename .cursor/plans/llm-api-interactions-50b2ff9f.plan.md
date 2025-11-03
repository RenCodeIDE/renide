<!-- 50b2ff9f-e5bb-4b42-b077-1f4e6a1c78f2 716d51ac-4f4f-46fc-8dba-c35f3a5edc68 -->
# LLM API Payloads - Request & Response Deep Dive

## 1. OpenAI/ChatGPT API Payloads

### A. Basic Chat Request (No Tools)

#### REQUEST PAYLOAD

**Endpoint**: `POST https://api.openai.com/v1/chat/completions`

**Headers**:

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer sk-...",
  "Accept": "text/event-stream"
}
```

**Body** (from `chatgpt.contribution.ts:203-213`):

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful coding assistant."
    },
    {
      "role": "user",
      "content": "How do I create a React component?"
    }
  ],
  "stream": true
}
```

#### RESPONSE PAYLOAD (Streaming SSE)

**Format**: Server-Sent Events (text/event-stream)

Each chunk looks like:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-5-nano-2025-08-07","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-5-nano-2025-08-07","choices":[{"index":0,"delta":{"content":"To"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-5-nano-2025-08-07","choices":[{"index":0,"delta":{"content":" create"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-5-nano-2025-08-07","choices":[{"index":0,"delta":{"content":" a"},"finish_reason":null}]}

...

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-5-nano-2025-08-07","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":25,"completion_tokens":150,"total_tokens":175}}

data: [DONE]
```

**Parsed Chunk Structure** (from `chatgpt.contribution.ts:113-145`):

```typescript
{
  "id": "chatcmpl-123",
  "object": "chat.completion.chunk",
  "created": 1677652288,
  "model": "gpt-5-nano-2025-08-07",
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",      // only in first chunk
      "content": "text here"    // incremental text
    },
    "finish_reason": null | "stop" | "length" | "tool_calls"
  }],
  "usage": {                    // only in final chunk
    "prompt_tokens": 25,
    "completion_tokens": 150,
    "total_tokens": 175
  },
  "error": {                    // only if error
    "message": "error message",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

---

### B. Chat Request WITH Context/History

#### REQUEST PAYLOAD

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {
      "role": "user",
      "content": "You have access to the following context:\n\n<context>\n<file path=\"/workspace/app.ts\" language=\"typescript\">\nimport React from 'react';\n\nexport function App() {\n  return <div>Hello</div>;\n}\n</file>\n</context>\n\nUse this context to help answer the user's question."
    },
    {
      "role": "user",
      "content": "What does the previous message say?"
    },
    {
      "role": "assistant",
      "content": "The previous message asked about React components."
    },
    {
      "role": "user",
      "content": "Now explain how to add state to the App component"
    }
  ],
  "stream": true
}
```

**Note**: Context is built in `chatgpt.contribution.ts:1017-1072`, history added in `buildMessages():987-1015`

---

### C. Chat Request WITH Tools

#### REQUEST PAYLOAD (from `chatgpt.contribution.ts:208-211`)

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {
      "role": "user",
      "content": "Create a new file called hello.ts with a greeting function"
    }
  ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "vscode_editFile",
        "description": "Edit or create a file with the specified content",
        "parameters": {
          "type": "object",
          "properties": {
            "uri": {
              "type": "string",
              "description": "The URI of the file to edit"
            },
            "explanation": {
              "type": "string",
              "description": "Explanation of what changes are being made"
            }
          },
          "required": ["uri"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "vscode_readFile",
        "description": "Read the contents of a file",
        "parameters": {
          "type": "object",
          "properties": {
            "uri": {
              "type": "string",
              "description": "The URI of the file to read"
            }
          },
          "required": ["uri"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

#### RESPONSE PAYLOAD WITH TOOL CALLS (Streaming)

```
data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":"I'll"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":" create"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":" that"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":" file"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":" for"},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"content":" you."},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"vscode_editFile","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"uri"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\":\""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"file"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":///workspace/hello.ts\",\"explanation\":\"Creating a new TypeScript file with a greeting function\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-456","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

**Accumulated Tool Call** (from `chatgpt.contribution.ts:383-440`):

```json
{
  "id": "call_abc123",
  "type": "function",
  "function": {
    "name": "vscode_editFile",
    "arguments": "{\"uri\":\"file:///workspace/hello.ts\",\"explanation\":\"Creating a new TypeScript file with a greeting function\"}"
  }
}
```

---

### D. Sending Tool Results Back to LLM

#### REQUEST PAYLOAD (Next iteration, from `chatgpt.contribution.ts:703-707`)

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {
      "role": "user",
      "content": "Create a new file called hello.ts with a greeting function"
    },
    {
      "role": "assistant",
      "content": "I'll create that file for you.",
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "vscode_editFile",
            "arguments": "{\"uri\":\"file:///workspace/hello.ts\",\"explanation\":\"Creating a new TypeScript file with a greeting function\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"success\":true,\"message\":\"File created successfully with 10 lines of code\"}"
    }
  ],
  "stream": true,
  "tools": [...],
  "tool_choice": "auto"
}
```

**Note**: Tool result message has `role: "tool"` and references the `tool_call_id`

#### RESPONSE PAYLOAD (Confirmation)

```
data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":"I've"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":" successfully"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":" created"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":" the"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":" hello.ts"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{"content":" file"},"finish_reason":null}]}

data: {"id":"chatcmpl-789","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## 2. Google Gemini API Payloads

### A. Basic Chat Request

#### REQUEST PAYLOAD

**Endpoint**: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=AIza...`

**Headers**:

```json
{
  "Content-Type": "application/json",
  "Accept": "text/event-stream"
}
```

**Body** (from `deepseek.contribution.ts:159-168`):

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "How do I create a React component?"
        }
      ]
    }
  ]
}
```

**Note**: Gemini uses `"role": "model"` instead of `"assistant"`

#### RESPONSE PAYLOAD (Streaming SSE)

```
data: {"candidates":[{"content":{"parts":[{"text":"To"}],"role":"model"},"finishReason":"STOP"}]}

data: {"candidates":[{"content":{"parts":[{"text":" create"}],"role":"model"}}]}

data: {"candidates":[{"content":{"parts":[{"text":" a"}],"role":"model"}}]}

data: {"candidates":[{"content":{"parts":[{"text":" React"}],"role":"model"}}]}

...

data: {"candidates":[{"content":{"parts":[{"text":" component"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":150,"totalTokenCount":160}}

data: [DONE]
```

**Parsed Chunk Structure** (from `deepseek.contribution.ts:84-103`):

```typescript
{
  "candidates": [{
    "content": {
      "parts": [
        {
          "text": "incremental text here"
        }
      ],
      "role": "model"
    },
    "finishReason": "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER"
  }],
  "usageMetadata": {
    "promptTokenCount": 10,
    "candidatesTokenCount": 150,
    "totalTokenCount": 160
  },
  "error": {
    "message": "error message"
  }
}
```

---

### B. Chat Request WITH History

#### REQUEST PAYLOAD

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "You have access to the following context:\n\n<context>\n<file path=\"/workspace/app.ts\" language=\"typescript\">\nimport React from 'react';\n\nexport function App() {\n  return <div>Hello</div>;\n}\n</file>\n</context>\n\nUse this context to help answer the user's question."
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "text": "What is in the App component?"
        }
      ]
    },
    {
      "role": "model",
      "parts": [
        {
          "text": "The App component returns a div with 'Hello' text."
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "text": "Now add a button to it"
        }
      ]
    }
  ]
}
```

---

### C. Chat Request WITH Tools (Function Calling)

#### REQUEST PAYLOAD (from `deepseek.contribution.ts:165-168`)

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Create a new file called hello.ts with a greeting function"
        }
      ]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "vscode_editFile",
          "description": "Edit or create a file with the specified content",
          "parameters": {
            "type": "object",
            "properties": {
              "uri": {
                "type": "string",
                "description": "The URI of the file to edit"
              },
              "explanation": {
                "type": "string",
                "description": "Explanation of what changes are being made"
              }
            },
            "required": ["uri"]
          }
        },
        {
          "name": "vscode_readFile",
          "description": "Read the contents of a file",
          "parameters": {
            "type": "object",
            "properties": {
              "uri": {
                "type": "string",
                "description": "The URI of the file to read"
              }
            },
            "required": ["uri"]
          }
        }
      ]
    }
  ]
}
```

#### RESPONSE PAYLOAD WITH FUNCTION CALLS

```
data: {"candidates":[{"content":{"parts":[{"text":"I'll create that file for you."}],"role":"model"}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"vscode_editFile","args":{"uri":"file:///workspace/hello.ts","explanation":"Creating a new TypeScript file with a greeting function"}}}],"role":"model"},"finishReason":"STOP"}]}

data: [DONE]
```

**Parsed Function Call** (from `deepseek.contribution.ts:370-376`):

```json
{
  "functionCall": {
    "name": "vscode_editFile",
    "args": {
      "uri": "file:///workspace/hello.ts",
      "explanation": "Creating a new TypeScript file with a greeting function"
    }
  }
}
```

---

### D. Sending Function Results Back

#### REQUEST PAYLOAD (Next iteration)

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Create a new file called hello.ts with a greeting function"
        }
      ]
    },
    {
      "role": "model",
      "parts": [
        {
          "text": "I'll create that file for you."
        },
        {
          "functionCall": {
            "name": "vscode_editFile",
            "args": {
              "uri": "file:///workspace/hello.ts",
              "explanation": "Creating a new TypeScript file with a greeting function"
            }
          }
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "functionResponse": {
            "name": "vscode_editFile",
            "response": {
              "success": true,
              "message": "File created successfully with 10 lines of code"
            }
          }
        }
      ]
    }
  ],
  "tools": [...]
}
```

**Note**: Function response goes in a user message with `functionResponse` part

---

## 3. Internal Message Conversion

### From UI to Internal Format

**User Input** → **IChatMessage[]** (from `languageModels.ts:106-110`)

```typescript
// User sends: "Fix the bug in app.ts"
// With attached file: app.ts

// Becomes:
[
  {
    "role": 1,  // ChatMessageRole.User
    "content": [
      {
        "type": "text",
        "value": "You have access to the following context:\n\n<context>\n<file path=\"/workspace/app.ts\" language=\"typescript\">\n[file content]\n</file>\n</context>"
      }
    ]
  },
  {
    "role": 1,  // ChatMessageRole.User
    "content": [
      {
        "type": "text",
        "value": "Fix the bug in app.ts"
      }
    ]
  }
]
```

### From LLM Response to Internal Format

**OpenAI Streaming Chunks** → **IChatResponsePart[]**

```typescript
// Chunk: {"choices":[{"delta":{"content":"Hello"}}]}
// Becomes:
{
  "type": "text",
  "value": "Hello"
}

// Chunk with tool call (after finish_reason)
// Becomes:
{
  "type": "tool_use",
  "name": "vscode_editFile",
  "toolCallId": "call_abc123",
  "parameters": {
    "uri": "file:///workspace/hello.ts",
    "explanation": "Creating file"
  }
}
```

### Tool Result to LLM Format

**IToolResult** → **OpenAI/Gemini Message**

```typescript
// Tool returns:
{
  "content": [
    {
      "type": "text",
      "value": "File created successfully"
    }
  ]
}

// Converted to OpenAI:
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"text\":\"File created successfully\",\"isError\":false}"
}

// Converted to Gemini:
{
  "role": "user",
  "parts": [
    {
      "functionResponse": {
        "name": "vscode_editFile",
        "response": {
          "text": "File created successfully",
          "isError": false
        }
      }
    }
  ]
}
```

---

## 4. Complete Request/Response Examples

### Example 1: Simple Question

**REQUEST**:

```http
POST https://api.openai.com/v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-...

{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {"role": "user", "content": "What is React?"}
  ],
  "stream": true
}
```

**RESPONSE** (aggregated):

```json
{
  "text": "React is a JavaScript library for building user interfaces...",
  "finish_reason": "stop",
  "usage": {
    "prompt_tokens": 5,
    "completion_tokens": 50,
    "total_tokens": 55
  }
}
```

---

### Example 2: Edit Request with Tool

**REQUEST 1** (Initial):

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {"role": "user", "content": "Add a useState hook to App.tsx"}
  ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "vscode_editFile",
        "description": "Edit a file",
        "parameters": {
          "type": "object",
          "properties": {
            "uri": {"type": "string"}
          }
        }
      }
    }
  ]
}
```

**RESPONSE 1**:

```json
{
  "text": "I'll add a useState hook for you.",
  "tool_calls": [
    {
      "id": "call_xyz",
      "function": {
        "name": "vscode_editFile",
        "arguments": "{\"uri\":\"file:///workspace/App.tsx\"}"
      }
    }
  ],
  "finish_reason": "tool_calls"
}
```

**REQUEST 2** (After tool execution):

```json
{
  "model": "gpt-5-nano-2025-08-07",
  "messages": [
    {"role": "user", "content": "Add a useState hook to App.tsx"},
    {
      "role": "assistant",
      "content": "I'll add a useState hook for you.",
      "tool_calls": [{"id": "call_xyz", "function": {...}}]
    },
    {
      "role": "tool",
      "tool_call_id": "call_xyz",
      "content": "{\"success\":true,\"edits\":5}"
    }
  ],
  "stream": true,
  "tools": [...]
}
```

**RESPONSE 2**:

```json
{
  "text": "I've successfully added the useState hook to App.tsx with 5 edits.",
  "finish_reason": "stop"
}
```

---

## 5. Error Responses

### OpenAI Error

```json
{
  "error": {
    "message": "Invalid API key provided",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

### Gemini Error

```json
{
  "error": {
    "message": "API key not valid. Please pass a valid API key."
  }
}
```

**Handling** (from `chatgpt.contribution.ts:226-238`):

- Parse error from response body
- Extract error message
- Throw Error with message
- Displayed to user in chat

---

## Key Differences: OpenAI vs Gemini

| Aspect | OpenAI | Gemini |

|--------|--------|--------|

| **Assistant Role** | `"assistant"` | `"model"` |

| **Tool Results Role** | `"tool"` (separate message) | `"user"` (with functionResponse) |

| **Tool Declaration** | `tools: [{ type: "function", function: {...} }]` | `tools: [{ functionDeclarations: [...] }]` |

| **Tool Call Format** | `tool_calls: [{ id, type, function }]` | `functionCall: { name, args }` |

| **Tool Result Format** | `{ role: "tool", tool_call_id, content }` | `{ role: "user", parts: [{ functionResponse }] }` |

| **Content Structure** | `content: string` | `parts: [{ text }]` |

| **Streaming End** | `data: [DONE]` | `data: [DONE]` |

| **Finish Reason** | `finish_reason: "stop"` | `finishReason: "STOP"` |