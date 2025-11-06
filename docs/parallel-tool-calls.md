# Parallel Tool Calls

This IDE runs multiple tool calls in bounded-parallel to reduce latency and guarantee protocol correctness with LLM tool-calling APIs.

Key guarantees:
- For every assistant message containing `tool_calls`, the IDE will produce one tool message per `tool_call_id` (including on error/timeout).
- Tool messages are emitted in the same order as the `tool_calls` array.
- Per-call cancellation and timeouts are enforced.

Configuration:
- `chat.toolCalls.maxConcurrency` (number): Maximum concurrent tool calls. Default: 10 (increased from 3 for better performance).
- `chat.toolCalls.timeoutMs` (number): Per-call timeout in milliseconds. Default: 30000.
- `chat.agent.maxIterations` (number): Maximum number of tool call iterations per request. Default: unlimited (Number.MAX_SAFE_INTEGER).

Implementation notes:
- OpenAI agent: `renide/src/vs/workbench/contrib/chat/browser/chatgpt/agent.ts`
- Gemini agent: `renide/src/vs/workbench/contrib/chat/browser/gemini/agent.ts`
- Tool service timeout/cancellation: `renide/src/vs/workbench/contrib/chat/browser/languageModelToolsService.ts`

Logging:
- Agents log tool_call ids received and results produced.
- Timeouts and failures are surfaced as error tool messages.


