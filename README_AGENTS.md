# VS Code Agents System - Complete Guide

This repository contains a sophisticated AI agents system that allows you to create custom AI-powered assistants for VS Code. This guide will walk you through everything you need to know about agents, how they work, and how to create your own custom agents.

## Table of Contents

1. [What Are Agents?](#what-are-agents)
2. [Types of Agents](#types-of-agents)
3. [Agent Architecture](#agent-architecture)
4. [Creating Custom Agents](#creating-custom-agents)
5. [Agent File Format](#agent-file-format)
6. [Tools and Capabilities](#tools-and-capabilities)
7. [Extension Development](#extension-development)
8. [Configuration and Settings](#configuration-and-settings)
9. [Examples and Templates](#examples-and-templates)
10. [Advanced Features](#advanced-features)
11. [Best Practices](#best-practices)

## What Are Agents?

Agents in VS Code are AI-powered assistants that can perform specific tasks, answer questions, and interact with your codebase. They're designed to be specialized, context-aware, and capable of using various tools to accomplish their goals.

### Key Characteristics:

- **Specialized**: Each agent has a specific purpose and domain expertise
- **Tool-enabled**: Agents can use various tools to interact with VS Code, files, terminals, and external services
- **Context-aware**: Agents understand your workspace, file structure, and current context
- **Extensible**: You can create custom agents for your specific needs

## Types of Agents

### 1. Built-in Agents

These come with VS Code and provide core functionality:

- **VS Code Agent** (`setup.vscode`): Answers questions about VS Code features and capabilities
- **Workspace Agent** (`setup.workspace`): Helps with workspace-specific questions and tasks
- **Terminal Agent** (`setup.terminal.agent`): Assists with terminal operations and commands

### 2. Custom Agents

User-defined agents created using `.agent.md` files:

- **File-based**: Defined in `.github/agents/` directory
- **Configurable**: Can specify tools, behavior, and capabilities
- **Reusable**: Can be shared across projects

### 3. Extension Agents

Agents contributed by VS Code extensions:

- **Dynamic**: Registered programmatically by extensions
- **Integrated**: Deep integration with extension functionality
- **Distributed**: Available through the extension marketplace

### 4. Remote Coding Agents

External agents that integrate with VS Code:

- **Command-based**: Execute external commands
- **Follow-up capable**: Can respond to patterns in chat history
- **Conditional**: Can be shown/hidden based on context

## Agent Architecture

### Core Components

#### 1. Chat Agent Service (`IChatAgentService`)

The central service that manages all agents:

```typescript
interface IChatAgentService {
  registerAgent(id: string, data: IChatAgentData): IDisposable;
  registerAgentImplementation(id: string, agent: IChatAgentImplementation): IDisposable;
  invokeAgent(agent: string, request: IChatAgentRequest, ...): Promise<IChatAgentResult>;
  getAgents(): IChatAgentData[];
}
```

#### 2. Agent Data Structure

Each agent is defined by:

```typescript
interface IChatAgentData {
	id: string; // Unique identifier
	name: string; // Display name
	description?: string; // What the agent does
	when?: string; // Context conditions
	extensionId: ExtensionIdentifier;
	metadata: IChatAgentMetadata;
	slashCommands: IChatAgentCommand[];
	locations: ChatAgentLocation[];
	modes: ChatModeKind[];
	capabilities?: IChatAgentAttachmentCapabilities;
}
```

#### 3. Agent Implementation

The actual behavior is defined by:

```typescript
interface IChatAgentImplementation {
	invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatAgentResult>;
	setRequestTools?(requestId: string, tools: UserSelectedTools): void;
	provideFollowups?(
		request: IChatAgentRequest,
		result: IChatAgentResult,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatFollowup[]>;
}
```

### Agent Locations

Agents can be available in different parts of VS Code:

- **Chat Panel**: Main chat interface
- **Inline Chat**: Within editor context
- **Terminal**: Terminal-specific interactions

### Agent Modes

Different interaction modes:

- **Ask**: Question-answering mode
- **Edit**: Code editing and modification
- **Agent**: Full agent capabilities with tools

## Creating Custom Agents

### Method 1: File-based Agents (Recommended)

Create agent files in the `.github/agents/` directory:

```bash
mkdir -p .github/agents
touch .github/agents/my-agent.agent.md
```

### Method 2: Extension-based Agents

Create a VS Code extension that contributes agents:

```json
{
	"contributes": {
		"chatParticipants": [
			{
				"id": "myAgent",
				"name": "My Custom Agent",
				"description": "A custom agent for specific tasks"
			}
		]
	}
}
```

### Method 3: Remote Coding Agents

For external integrations:

```json
{
	"contributes": {
		"remoteCodingAgents": [
			{
				"id": "externalAgent",
				"command": "myExtension.externalCommand",
				"displayName": "External Agent",
				"description": "Integrates with external service"
			}
		]
	}
}
```

## Agent File Format

### Basic Structure

```markdown
---
name: Agent Name
description: What this agent does
tools: ["tool1", "tool2", "tool3"]
target: github-copilot
---

# Agent Instructions

Define what this agent accomplishes, when to use it, and how it behaves.
```

### Header Fields

#### Required Fields

- **`name`**: Display name for the agent
- **`description`**: Brief description of the agent's purpose

#### Optional Fields

- **`tools`**: Array of tool names the agent can use
- **`target`**: Target platform (e.g., `github-copilot`)
- **`model`**: Specific AI model to use
- **`argumentHint`**: Description of expected inputs
- **`when`**: Context conditions for when agent is available

### Content Sections

#### Overview Section

```markdown
<overview>
Your goal is to [specific task]. The agent should [behavior description].
</overview>
```

#### Workflow Section

```markdown
<workflow>
1. First step
2. Second step
3. Final step
</workflow>
```

#### Instructions Section

```markdown
<instructions>
- Specific guidance
- Behavioral rules
- Output format requirements
</instructions>
```

### Example Agent File

```markdown
---
name: Code Reviewer
description: Reviews code changes and provides feedback
tools: ["edit", "search", "usages", "fetch"]
---

<overview>
You are a code review agent. Your goal is to analyze code changes, identify potential issues, and provide constructive feedback to improve code quality.
</overview>

<workflow>
1. Analyze the provided code changes
2. Check for common issues (bugs, performance, security)
3. Suggest improvements
4. Provide specific, actionable feedback
</workflow>

<instructions>
- Focus on code quality, not style preferences
- Provide specific examples of improvements
- Be constructive and educational
- Consider the context of the codebase
</instructions>
```

## Tools and Capabilities

### Built-in Tools

#### File Operations

- **`edit`**: Modify files and code
- **`search`**: Search through codebase
- **`usages`**: Find symbol usages
- **`fetch`**: Retrieve file contents

#### VS Code Integration

- **`vscodeAPI`**: Access VS Code APIs
- **`extensions`**: Manage extensions
- **`runCommands/runInTerminal`**: Execute commands

#### External Services

- **`githubRepo`**: GitHub repository operations
- **`Azure MCP/kusto_query`**: Azure Data Explorer queries
- **`vscode-playwright-mcp/*`**: UI automation tools

### Tool Sets

Tools can be grouped into sets for easier management:

```typescript
interface ToolSet {
	id: string;
	referenceName: string;
	description?: string;
	getTools(): IToolData[];
}
```

### Custom Tools

You can create custom tools for your agents:

```typescript
interface IToolData {
	id: string;
	displayName: string;
	description: string;
	canBeReferencedInPrompt: boolean;
	toolReferenceName: string;
}
```

## Extension Development

### Creating an Agent Extension

#### 1. Package.json Configuration

```json
{
	"name": "my-agent-extension",
	"displayName": "My Agent Extension",
	"version": "1.0.0",
	"engines": {
		"vscode": "^1.20.0"
	},
	"contributes": {
		"chatParticipants": [
			{
				"id": "myAgent",
				"name": "My Agent",
				"description": "Custom agent for specific tasks",
				"isDefault": false,
				"locations": ["chat"],
				"modes": ["agent", "ask", "edit"],
				"commands": [
					{
						"name": "analyze",
						"description": "Analyze current code"
					}
				]
			}
		]
	},
	"activationEvents": ["onCommand:myAgent.analyze"]
}
```

#### 2. Extension Implementation

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
	// Register agent implementation
	const agentImpl: vscode.ChatAgentImplementation = {
		invoke(request, progress, history, token) {
			// Implement agent logic
			return Promise.resolve({
				content: "Agent response",
				followups: [],
			});
		},
	};

	context.subscriptions.push(
		vscode.chat.registerChatAgent("myAgent", agentImpl)
	);
}
```

### Remote Coding Agents

For external integrations:

```json
{
	"contributes": {
		"remoteCodingAgents": [
			{
				"id": "externalAgent",
				"command": "myExtension.externalCommand",
				"displayName": "External Agent",
				"description": "Integrates with external service",
				"when": "workspaceHasTypeScript"
			}
		]
	}
}
```

## Configuration and Settings

### Agent Settings

#### Enable/Disable Agent Instructions

```json
{
	"chat.useAgentMd": true,
	"chat.useCopilotInstructionFiles": true
}
```

#### Agent File Locations

```json
{
	"chat.mode.config.locations": {
		".github/agents": true,
		"/custom/path": true
	}
}
```

### Context Conditions

Agents can be conditionally available based on:

- **File types**: `workspaceHasTypeScript`
- **Extensions**: `extensionInstalled:ms-python.python`
- **Workspace**: `workspaceFolderCount > 1`
- **Custom**: Define your own context keys

## Examples and Templates

### 1. Component Analysis Agent

```markdown
---
name: Component Analyzer
description: Analyzes React components and provides architectural insights
tools: ["edit", "search", "usages", "fetch"]
---

<overview>
You are a component analysis agent specializing in React components. Your goal is to analyze component structure, identify patterns, and provide architectural recommendations.
</overview>

<workflow>
1. Examine the component file structure
2. Analyze props, state, and lifecycle methods
3. Identify dependencies and relationships
4. Check for common patterns and anti-patterns
5. Provide improvement suggestions
</workflow>

<instructions>
- Focus on component architecture and design patterns
- Identify potential performance issues
- Suggest better separation of concerns
- Consider accessibility and usability
</instructions>
```

### 2. Documentation Generator

```markdown
---
name: Documentation Generator
description: Generates comprehensive documentation for code
tools: ["edit", "search", "usages", "fetch"]
---

<overview>
You are a documentation generation agent. Your goal is to create clear, comprehensive documentation for code, including API references, usage examples, and architectural overviews.
</overview>

<workflow>
1. Analyze the code structure and functionality
2. Identify public APIs and interfaces
3. Generate comprehensive documentation
4. Include usage examples and best practices
5. Create architectural diagrams where helpful
</workflow>

<instructions>
- Use clear, concise language
- Include practical examples
- Follow established documentation standards
- Consider the target audience
</instructions>
```

### 3. Testing Agent

```markdown
---
name: Test Generator
description: Generates comprehensive test suites for code
tools: ["edit", "search", "usages", "fetch"]
---

<overview>
You are a test generation agent. Your goal is to create comprehensive test suites that cover functionality, edge cases, and integration scenarios.
</overview>

<workflow>
1. Analyze the code to be tested
2. Identify testable units and scenarios
3. Generate unit tests for individual functions
4. Create integration tests for component interactions
5. Add edge case and error handling tests
</workflow>

<instructions>
- Aim for high test coverage
- Include both positive and negative test cases
- Use appropriate testing frameworks
- Follow testing best practices
</instructions>
```

## Advanced Features

### Hand-offs Between Agents

Agents can transfer control to other agents:

```markdown
<handOffs>
- target: "specialist-agent"
  condition: "when complex analysis is needed"
  description: "Transfer to specialist for detailed analysis"
</handOffs>
```

### Dynamic Tool Selection

Agents can dynamically select tools based on context:

```typescript
setRequestTools(requestId: string, tools: UserSelectedTools): void {
  // Select tools based on request context
  const selectedTools = this.selectToolsForRequest(request);
  this.toolsService.setRequestTools(requestId, selectedTools);
}
```

### Custom Context Keys

Create custom context conditions:

```typescript
const customContextKey = "myExtension.customCondition";
contextKeyService.createKey(customContextKey, false);
```

### Agent Completion Providers

Provide intelligent completions:

```typescript
interface IChatAgentCompletionProvider {
	provideCompletions(
		query: string,
		token: CancellationToken
	): Promise<IChatAgentCompletionItem[]>;
}
```

## Best Practices

### 1. Agent Design

- **Single Responsibility**: Each agent should have a clear, focused purpose
- **Clear Boundaries**: Define what the agent will and won't do
- **Consistent Interface**: Use standard patterns for similar agents
- **Error Handling**: Gracefully handle failures and edge cases

### 2. Tool Selection

- **Minimal Tool Set**: Only include tools the agent actually needs
- **Tool Documentation**: Clearly document what each tool does
- **Tool Validation**: Validate tool inputs and outputs
- **Tool Fallbacks**: Provide alternatives when tools fail

### 3. Performance

- **Efficient Queries**: Use specific, targeted searches
- **Caching**: Cache frequently accessed data
- **Parallel Operations**: Use parallel tool calls when possible
- **Resource Management**: Clean up resources properly

### 4. User Experience

- **Clear Instructions**: Provide clear guidance on how to use the agent
- **Progress Feedback**: Show progress for long-running operations
- **Error Messages**: Provide helpful error messages and suggestions
- **Follow-ups**: Offer relevant follow-up actions

### 5. Security

- **Input Validation**: Validate all inputs from users
- **Tool Permissions**: Limit tool access to necessary operations
- **Data Privacy**: Handle sensitive data appropriately
- **Audit Logging**: Log important operations for debugging

## Getting Started

### Quick Start

1. **Create your first agent**:

   ```bash
   mkdir -p .github/agents
   touch .github/agents/my-first-agent.agent.md
   ```

2. **Add basic content**:

   ```markdown
   ---
   name: My First Agent
   description: A simple agent to get started
   tools: ["search", "fetch"]
   ---

   # My First Agent

   This agent helps with basic tasks in your workspace.
   ```

3. **Test your agent**:
   - Open VS Code
   - Go to Chat panel
   - Select your agent
   - Start chatting!

### Next Steps

1. **Explore existing agents** in `.github/agents/` and `.github/prompts/`
2. **Study the examples** provided in this repository
3. **Create specialized agents** for your specific use cases
4. **Share your agents** with the community

## Troubleshooting

### Common Issues

#### Agent Not Appearing

- Check file location (`.github/agents/`)
- Verify file extension (`.agent.md`)
- Check syntax in agent file header

#### Tools Not Working

- Verify tool names in `tools` array
- Check tool availability in your environment
- Review tool permissions

#### Performance Issues

- Limit tool usage to necessary operations
- Use specific search queries
- Implement proper error handling

### Debug Tips

1. **Check VS Code Developer Console** for error messages
2. **Use Chat History** to review agent interactions
3. **Test with Simple Cases** before complex scenarios
4. **Review Agent Logs** for detailed debugging information

## Contributing

### Adding New Agents

1. Create agent file in `.github/agents/`
2. Follow the established format and conventions
3. Test thoroughly with various scenarios
4. Document the agent's purpose and usage
5. Submit a pull request

### Improving Existing Agents

1. Identify areas for improvement
2. Test changes thoroughly
3. Maintain backward compatibility
4. Update documentation as needed
5. Submit improvements via pull request

## Resources

- [VS Code Extension API Documentation](https://code.visualstudio.com/api)
- [Chat Agent API Reference](https://code.visualstudio.com/api/extension-guides/chat-agent)
- [Tool Development Guide](https://code.visualstudio.com/api/extension-guides/language-model-tools)
- [Community Examples](https://github.com/microsoft/vscode/tree/main/.github/agents)

---

This guide provides a comprehensive overview of the VS Code agents system. Start with simple agents and gradually build more sophisticated ones as you become familiar with the system. The agents system is designed to be flexible and extensible, allowing you to create powerful AI assistants tailored to your specific needs.
