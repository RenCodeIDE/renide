/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as Proto from '../tsServer/protocol/protocol';
import { API } from '../tsServer/api';
import * as typeConverters from '../typeConverters';
import { ClientCapability, ITypeScriptServiceClient } from '../typescriptService';
import FileConfigurationManager from './fileConfigurationManager';
import { conditionalRegistration, requireMinVersion, requireSomeCapability } from './util/dependentRegistration';

interface ICodeBlockGroup {
	readonly resource: vscode.Uri;
	readonly snippets: readonly string[];
}

class TypeScriptCodeMapperProvider implements vscode.MappedEditsProvider2 {

	constructor(
		private readonly client: ITypeScriptServiceClient,
		private readonly fileConfigurationManager: FileConfigurationManager,
	) { }

	async provideMappedEdits(request: vscode.MappedEditsRequest, stream: vscode.MappedEditsResponseStream, token: vscode.CancellationToken): Promise<vscode.MappedEditsResult | undefined> {
		try {
			for (const group of this.groupByResource(request.codeBlocks)) {
				if (token.isCancellationRequested) {
					break;
				}

				await this.processGroup(group, stream, token);
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			const message = error instanceof Error ? error.message : String(error);
			return { errorMessage: message };
		}

		return undefined;
	}

	private groupByResource(codeBlocks: readonly { code: string; resource: vscode.Uri }[]): ICodeBlockGroup[] {
		const grouped = new Map<string, { resource: vscode.Uri; snippets: string[] }>();

		for (const block of codeBlocks) {
			const key = block.resource.toString();
			let entry = grouped.get(key);
			if (!entry) {
				entry = { resource: block.resource, snippets: [] };
				grouped.set(key, entry);
			}
			entry.snippets.push(block.code);
		}

		return Array.from(grouped.values());
	}

	private async processGroup(group: ICodeBlockGroup, stream: vscode.MappedEditsResponseStream, token: vscode.CancellationToken): Promise<void> {
		if (!group.snippets.length) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(group.resource);
		if (token.isCancellationRequested) {
			return;
		}

		if (!this.client.bufferSyncSupport.openTextDocument(document)) {
			throw new Error(vscode.l10n.t("The file '{0}' is not handled by the TypeScript language service.", group.resource.toString(true)));
		}

		await this.fileConfigurationManager.ensureConfigurationForDocument(document, token);
		if (token.isCancellationRequested) {
			return;
		}

		const file = this.client.toOpenTsFilePath(document);
		if (!file) {
			throw new Error(vscode.l10n.t("Could not resolve a TypeScript file path for '{0}'.", group.resource.toString(true)));
		}

		const args: Proto.MapCodeRequestArgs = {
			file,
			mapping: {
				contents: [...group.snippets],
			},
		};

		const response = await this.client.execute('mapCode', args, token);
		if (response.type !== 'response') {
			if (response.type !== 'cancelled') {
				throw new Error(vscode.l10n.t("The TypeScript server could not complete the refactoring request."));
			}
			return;
		}

		if (!response.success) {
			throw new Error(response.message ?? vscode.l10n.t("The TypeScript server reported an error while mapping edits."));
		}

		const edits = response.body ?? [];
		for (const edit of edits) {
			if (token.isCancellationRequested) {
				return;
			}

			const target = this.client.toResource(edit.fileName);
			const textEdits = edit.textChanges.map(typeConverters.TextEdit.fromCodeEdit);
			if (textEdits.length) {
				stream.textEdit(target, textEdits);
			}
		}
	}
}

export function register(
	client: ITypeScriptServiceClient,
	fileConfigurationManager: FileConfigurationManager,
): vscode.Disposable {
	return conditionalRegistration([
		requireMinVersion(client, API.v590),
		requireSomeCapability(client, ClientCapability.Semantic),
	], () => {
		if (!vscode.chat || typeof vscode.chat.registerMappedEditsProvider2 !== 'function') {
			return new vscode.Disposable(() => { /* noop */ });
		}

		const provider = new TypeScriptCodeMapperProvider(client, fileConfigurationManager);
		return vscode.chat.registerMappedEditsProvider2(provider);
	});
}


