/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../../../../../base/common/uri.js";
import { ILogService } from "../../../../../../platform/log/common/log.js";
import { IFileService } from "../../../../../../platform/files/common/files.js";
import { ILanguageFeaturesService } from "../../../../../../editor/common/services/languageFeatures.js";
import { IModelService } from "../../../../../../editor/common/services/model.js";
import { Range } from "../../../../../../editor/common/core/range.js";
import { Position } from "../../../../../../editor/common/core/position.js";
import { CancellationTokenSource } from "../../../../../../base/common/cancellation.js";
import { isCancellationError } from "../../../../../../base/common/errors.js";
import {
	FunctionDefinition,
	FunctionCall,
	DataFlowGraphOptions,
} from "./graphTypes.js";

interface CallGraphResult {
	nodes: Map<string, FunctionDefinition>;
	edges: FunctionCall[];
}

export class FunctionCallAnalyzer {
	constructor(
		private readonly languageFeaturesService: ILanguageFeaturesService,
		private readonly fileService: IFileService,
		private readonly modelService: IModelService,
		private readonly logService: ILogService
	) {}

	/**
	 * Get all function definitions in a file
	 */
	async getFunctionDefinitions(file: URI): Promise<FunctionDefinition[]> {
		const functions: FunctionDefinition[] = [];
		let model = this.modelService.getModel(file);

		if (!model) {
			try {
				const buffer = await this.fileService.readFile(file);
				const content = buffer.value.toString();
				model = this.modelService.createModel(content, null, file, false);
			} catch (error) {
				this.logService.error(
					"[FunctionCallAnalyzer] Failed to read file",
					error
				);
				return functions;
			}
		}

		const cancellationToken = new CancellationTokenSource();
		try {
			const providers =
				this.languageFeaturesService.documentSymbolProvider.all(model);
			for (const provider of providers) {
				try {
					const symbols = await provider.provideDocumentSymbols(
						model,
						cancellationToken.token
					);
					if (!symbols) continue;

					const flattenSymbols = (symbols: any[]): any[] => {
						const result: any[] = [];
						for (const symbol of symbols) {
							result.push(symbol);
							if (symbol.children && symbol.children.length > 0) {
								result.push(...flattenSymbols(symbol.children));
							}
						}
						return result;
					};

					const flatSymbols = flattenSymbols(
						Array.isArray(symbols) ? symbols : [symbols]
					);

					for (const symbol of flatSymbols) {
						if (
							symbol.kind === 11 || // SymbolKind.Function
							symbol.kind === 6 || // SymbolKind.Method
							symbol.kind === 9 // SymbolKind.Constructor
						) {
							const range = symbol.range || symbol.selectionRange;
							if (!range) continue;

							let funcKind: FunctionDefinition["kind"] = "function";
							if (symbol.kind === 6) funcKind = "method";
							else if (symbol.kind === 9) funcKind = "constructor";

							const name = symbol.name || "anonymous";
							const funcId = `${file.toString()}:${name}:${
								range.startLineNumber
							}:${range.startColumn}`;

							functions.push({
								id: funcId,
								name,
								fileUri: file,
								range: new Range(
									range.startLineNumber,
									range.startColumn,
									range.endLineNumber,
									range.endColumn
								),
								signature: symbol.detail || symbol.name,
								isExported: symbol.containerName?.includes("export") || false,
								kind: funcKind,
							});
						}
					}
				} catch (error) {
					if (!isCancellationError(error)) {
						this.logService.debug(
							"[FunctionCallAnalyzer] Error getting symbols",
							error
						);
					}
				}
			}
		} finally {
			cancellationToken.dispose();
		}

		return functions;
	}

	/**
	 * Find all call sites of a function (who calls this function)
	 */
	async findCallers(functionDef: FunctionDefinition): Promise<FunctionCall[]> {
		const calls: FunctionCall[] = [];
		const cancellationToken = new CancellationTokenSource();

		try {
			const position = new Position(
				functionDef.range.startLineNumber,
				functionDef.range.startColumn
			);

			let model = this.modelService.getModel(functionDef.fileUri);
			if (!model) {
				try {
					const buffer = await this.fileService.readFile(functionDef.fileUri);
					const content = buffer.value.toString();
					model = this.modelService.createModel(
						content,
						null,
						functionDef.fileUri,
						false
					);
				} catch (error) {
					this.logService.error(
						"[FunctionCallAnalyzer] Failed to read file for callers",
						error
					);
					return calls;
				}
			}

			const providers =
				this.languageFeaturesService.referenceProvider.all(model);
			for (const provider of providers) {
				try {
					const references = await provider.provideReferences(
						model,
						position,
						{ includeDeclaration: false },
						cancellationToken.token
					);

					if (!references) continue;

					for (const ref of references) {
						// Skip the definition itself
						if (
							ref.uri.toString() === functionDef.fileUri.toString() &&
							ref.range.startLineNumber === functionDef.range.startLineNumber
						) {
							continue;
						}

						// Find the function that contains this reference
						const position = new Position(
							ref.range.startLineNumber,
							ref.range.startColumn
						);
						const caller = await this.findContainingFunction(ref.uri, position);
						if (caller) {
							const callSiteRange = new Range(
								ref.range.startLineNumber,
								ref.range.startColumn,
								ref.range.endLineNumber,
								ref.range.endColumn
							);
							calls.push({
								caller,
								callee: functionDef,
								callSite: callSiteRange,
								callType: "direct",
							});
						}
					}
				} catch (error) {
					if (!isCancellationError(error)) {
						this.logService.debug(
							"[FunctionCallAnalyzer] Error finding callers",
							error
						);
					}
				}
			}
		} catch (error) {
			if (!isCancellationError(error)) {
				this.logService.error(
					"[FunctionCallAnalyzer] Error finding callers",
					error
				);
			}
		} finally {
			cancellationToken.dispose();
		}

		return calls;
	}

	/**
	 * Find all functions called by a function (what this function calls)
	 */
	async findCallees(functionDef: FunctionDefinition): Promise<FunctionCall[]> {
		const calls: FunctionCall[] = [];

		try {
			let model = this.modelService.getModel(functionDef.fileUri);
			if (!model) {
				try {
					const buffer = await this.fileService.readFile(functionDef.fileUri);
					const content = buffer.value.toString();
					model = this.modelService.createModel(
						content,
						null,
						functionDef.fileUri,
						false
					);
				} catch (error) {
					this.logService.error(
						"[FunctionCallAnalyzer] Failed to read file for callees",
						error
					);
					return calls;
				}
			}

			// Get all function definitions in the same file
			const allFunctions = await this.getFunctionDefinitions(
				functionDef.fileUri
			);

			// Extract function body text
			const functionBody = model.getValueInRange(functionDef.range);

			// For each function in the file, check if it's called within this function's body
			for (const callee of allFunctions) {
				if (callee.id === functionDef.id) {
					continue; // Skip self
				}

				// Check if function name appears in the body (simple check)
				const functionNameRegex = new RegExp(
					`\\b${escapeRegExp(callee.name)}\\s*\\(`,
					"g"
				);
				if (functionNameRegex.test(functionBody)) {
					// Find the call site
					const callSite = this.findCallSiteInRange(
						model,
						callee.name,
						functionDef.range
					);
					if (callSite) {
						calls.push({
							caller: functionDef,
							callee,
							callSite,
							callType: "direct",
						});
					}
				}
			}
		} catch (error) {
			this.logService.error(
				"[FunctionCallAnalyzer] Error finding callees",
				error
			);
		}

		return calls;
	}

	/**
	 * Build complete call graph for a function (recursive)
	 */
	async buildCallGraph(
		rootFunction: FunctionDefinition,
		options: DataFlowGraphOptions
	): Promise<CallGraphResult> {
		const {
			maxDepth = 10,
			includeUpstream = true,
			includeDownstream = true,
			includeExternal = false,
		} = options;

		const nodes = new Map<string, FunctionDefinition>();
		const edges: FunctionCall[] = [];
		const visited = new Set<string>();
		const queue: Array<{
			function: FunctionDefinition;
			depth: number;
			direction: "up" | "down";
		}> = [];

		// Add root function
		nodes.set(rootFunction.id, rootFunction);
		queue.push({ function: rootFunction, depth: 0, direction: "down" });

		while (queue.length > 0) {
			const { function: func, depth, direction } = queue.shift()!;

			if (depth >= maxDepth || visited.has(func.id)) {
				continue;
			}
			visited.add(func.id);

			try {
				if (includeUpstream && (direction === "up" || depth === 0)) {
					// Find callers
					const callers = await this.findCallers(func);
					for (const call of callers) {
						if (
							!includeExternal &&
							!this.isWithinWorkspace(call.caller.fileUri)
						) {
							continue;
						}

						if (!nodes.has(call.caller.id)) {
							nodes.set(call.caller.id, call.caller);
						}
						edges.push(call);
						queue.push({
							function: call.caller,
							depth: depth + 1,
							direction: "up",
						});
					}
				}

				if (includeDownstream && (direction === "down" || depth === 0)) {
					// Find callees
					const callees = await this.findCallees(func);
					for (const call of callees) {
						if (
							!includeExternal &&
							!this.isWithinWorkspace(call.callee.fileUri)
						) {
							continue;
						}

						if (!nodes.has(call.callee.id)) {
							nodes.set(call.callee.id, call.callee);
						}
						edges.push(call);
						queue.push({
							function: call.callee,
							depth: depth + 1,
							direction: "down",
						});
					}
				}
			} catch (error) {
				this.logService.debug(
					"[FunctionCallAnalyzer] Error building call graph",
					error
				);
			}
		}

		return { nodes, edges };
	}

	private async findContainingFunction(
		fileUri: URI,
		position: Position
	): Promise<FunctionDefinition | undefined> {
		try {
			const functions = await this.getFunctionDefinitions(fileUri);
			// Find the function that contains this position
			for (const func of functions) {
				if (func.range.containsPosition(position)) {
					return func;
				}
			}
		} catch (error) {
			this.logService.debug(
				"[FunctionCallAnalyzer] Error finding containing function",
				error
			);
		}
		return undefined;
	}

	private findCallSiteInRange(
		model: any,
		functionName: string,
		range: Range
	): Range | undefined {
		try {
			const text = model.getValueInRange(range);
			const regex = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, "g");
			let match;

			while ((match = regex.exec(text)) !== null) {
				const offset = match.index;
				const position = model.getPositionAt(
					model.getOffsetAt(range.getStartPosition()) + offset
				);
				return new Range(
					position.lineNumber,
					position.column,
					position.lineNumber,
					position.column + functionName.length
				);
			}
		} catch (error) {
			this.logService.debug(
				"[FunctionCallAnalyzer] Error finding call site",
				error
			);
		}
		return undefined;
	}

	private isWithinWorkspace(uri: URI): boolean {
		// Simple check - can be enhanced
		return (
			!uri.toString().includes("node_modules") &&
			!uri.toString().startsWith("vscode:")
		);
	}
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
