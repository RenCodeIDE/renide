/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplicationService } from '../application';
import { z } from 'zod';

/**
 * Terminal Management Tools
 */
export function applyTerminalTools(server: McpServer, appService: ApplicationService): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	tools.push(server.tool(
		'vscode_automation_terminal_create',
		'Create a new terminal',
		{
			expectedLocation: z.enum(['editor', 'panel']).optional().describe('Expected location of terminal (editor or panel)')
		},
		async (args) => {
			const { expectedLocation } = args;
			const app = await appService.getOrCreateApplication();
			await app.workbench.terminal.createTerminal(expectedLocation);
			return {
				content: [{
					type: 'text' as const,
					text: `Created new terminal${expectedLocation ? ` in ${expectedLocation}` : ''}`
				}]
			};
		}
	));

	tools.push(server.tool(
		'vscode_automation_terminal_run_command',
		'Run a command in the terminal',
		{
			command: z.string().describe('Command to run in the terminal'),
			skipEnter: z.boolean().optional().describe('Skip pressing enter after typing command')
		},
		async (args) => {
			const { command, skipEnter } = args;
			const app = await appService.getOrCreateApplication();
			await app.workbench.terminal.runCommandInTerminal(command, skipEnter);
			return {
				content: [{
					type: 'text' as const,
					text: `Ran command in terminal: "${command}"`
				}]
			};
		}
	));

	tools.push(server.tool(
		'vscode_automation_terminal_get_groups',
		'Get current terminal groups information',
		async () => {
			const app = await appService.getOrCreateApplication();
			const groups = await app.workbench.terminal.getTerminalGroups();
			return {
				content: [{
					type: 'text' as const,
					text: `Terminal groups:\n${JSON.stringify(groups, null, 2)}`
				}]
			};
		}
	));

	return tools;
}
