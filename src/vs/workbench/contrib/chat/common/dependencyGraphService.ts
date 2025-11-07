/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck

import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IMerkleTreeService } from "../../../../platform/merkleTree/common/merkleTreeService.js";
import { IRenWorkspaceStore } from "../../renViews/common/renWorkspaceStore.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { FileChunk } from "../../../../platform/merkleTree/common/merkleTreeTypes.js";
import { joinPath } from "../../../../base/common/resources.js";

export const IDependencyGraphService = createDecorator<IDependencyGraphService>(
	"dependencyGraphService"
);

export interface FileDependencyGraph {
	readonly fileUri: string;
	readonly merkleHash: string;
	readonly imports: readonly ImportEdge[];
	readonly exports: readonly ExportEdge[];
	readonly timestamp: number;
	readonly chunks?: readonly FileChunk[];
}

export interface ImportEdge {
	readonly targetUri: string;
	readonly specifier: string;
	readonly symbols: readonly string[];
	readonly isTypeOnly: boolean;
	readonly isSideEffect: boolean;
}

export interface ExportEdge {
	readonly symbol: string;
	readonly isTypeOnly: boolean;
	readonly isDefault: boolean;
}

export interface IDependencyGraphService {
	readonly _serviceBrand: undefined;

	/**
	 * Get or compute the dependency graph for a file, using Merkle hash for caching
	 */
	getDependencyGraph(fileUri: URI): Promise<FileDependencyGraph | undefined>;

	/**
	 * Get dependency graphs for multiple files in batch
	 */
	getDependencyGraphs(
		fileUris: URI[]
	): Promise<Map<string, FileDependencyGraph>>;

	/**
	 * Invalidate cached graph for a file (when file changes)
	 */
	invalidateGraph(fileUri: URI): void;
}

export class DependencyGraphService
	extends Disposable
	implements IDependencyGraphService
{
	declare readonly _serviceBrand: undefined;

	private readonly cache = new Map<string, FileDependencyGraph>();
	private static readonly CACHE_PREFIX = "agent.dependencyGraph.";

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IMerkleTreeService private readonly merkleTreeService: IMerkleTreeService,
		@IRenWorkspaceStore private readonly workspaceStore: IRenWorkspaceStore,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService
	) {
		super();
	}

	async getDependencyGraph(
		fileUri: URI
	): Promise<FileDependencyGraph | undefined> {
		const fileKey = this.getFileKey(fileUri);

		// Check in-memory cache first
		const cached = this.cache.get(fileKey);
		if (cached) {
			// Verify hash hasn't changed
			const currentHash = await this.getFileHash(fileUri);
			if (currentHash === cached.merkleHash) {
				return cached;
			}
			// Hash changed, invalidate
			this.cache.delete(fileKey);
		}

		// Check workspace store cache
		const storedKey = `${DependencyGraphService.CACHE_PREFIX}${fileKey}`;
		const stored =
			this.workspaceStore.getObject<FileDependencyGraph>(storedKey);
		if (stored) {
			const currentHash = await this.getFileHash(fileUri);
			if (currentHash === stored.merkleHash) {
				const hydrated: FileDependencyGraph = {
					...stored,
					chunks: stored.chunks ?? undefined,
				};
				this.cache.set(fileKey, hydrated);
				return hydrated;
			}
			// Hash changed, remove from store
			this.workspaceStore.remove(storedKey);
		}

		// Compute new graph
		try {
			const graph = await this.computeDependencyGraph(fileUri);
			if (graph) {
				// Cache in memory and workspace store
				this.cache.set(fileKey, graph);
				this.workspaceStore.setObject(storedKey, graph);
			}
			return graph;
		} catch (error) {
			this.logService.warn(
				`[DependencyGraphService] Failed to compute graph for ${fileUri.toString()}: ${error}`
			);
			return undefined;
		}
	}

	async getDependencyGraphs(
		fileUris: URI[]
	): Promise<Map<string, FileDependencyGraph>> {
		const results = new Map<string, FileDependencyGraph>();
		await Promise.all(
			fileUris.map(async (uri) => {
				const graph = await this.getDependencyGraph(uri);
				if (graph) {
					results.set(this.getFileKey(uri), graph);
				}
			})
		);
		return results;
	}

	invalidateGraph(fileUri: URI): void {
		const fileKey = this.getFileKey(fileUri);
		this.cache.delete(fileKey);
		const storedKey = `${DependencyGraphService.CACHE_PREFIX}${fileKey}`;
		this.workspaceStore.remove(storedKey);
	}

	private async computeDependencyGraph(
		fileUri: URI
	): Promise<FileDependencyGraph | undefined> {
		try {
			// Get file hash
			const merkleHash = await this.getFileHash(fileUri);
			if (!merkleHash) {
				return undefined;
			}

			let chunks: FileChunk[] | undefined;
			try {
				const workspaceFolders = this.workspaceService.getWorkspace().folders;
				if (workspaceFolders.length > 0) {
					const relativePath = this.getRelativePath(
						fileUri,
						workspaceFolders[0].uri
					);
					chunks =
						(await this.merkleTreeService.getFileChunks(relativePath)) ??
						undefined;
				}
			} catch (error) {
				this.logService.debug(
					`[DependencyGraphService] Failed to resolve file chunks for ${fileUri.toString()}: ${error}`
				);
			}

			// Read file content
			const buffer = await this.fileService.readFile(fileUri);
			const content = buffer.value.toString();

			// Extract imports and exports
			const imports = this.extractImports(content, fileUri);
			const exports = this.extractExports(content);

			return {
				fileUri: fileUri.toString(),
				merkleHash,
				imports,
				exports,
				timestamp: Date.now(),
				chunks,
			};
		} catch (error) {
			this.logService.warn(
				`[DependencyGraphService] Error computing graph: ${error}`
			);
			return undefined;
		}
	}

	private extractImports(content: string, sourceUri: URI): ImportEdge[] {
		const imports: ImportEdge[] = [];

		// Match import statements
		const importRegex =
			/import\s+(?:(?:(?:\*\s+as\s+(\w+))|(?:\{([^}]+)\})|(\w+))\s+from\s+)?['"]([^'"]+)['"]/g;
		const typeImportRegex =
			/import\s+type\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
		const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;

		// Regular imports
		let match;
		while ((match = importRegex.exec(content)) !== null) {
			const namespace = match[1];
			const named = match[2];
			const defaultImport = match[3];
			const specifier = match[4];

			if (specifier && !this.isIgnoredSpecifier(specifier)) {
				const symbols: string[] = [];
				if (namespace) {
					symbols.push(`* as ${namespace}`);
				}
				if (named) {
					symbols.push(
						...named.split(",").map((s) => s.trim().split(/\s+as\s+/)[0])
					);
				}
				if (defaultImport) {
					symbols.push("default");
				}

				imports.push({
					targetUri:
						this.resolveImportUri(sourceUri, specifier)?.toString() || "",
					specifier,
					symbols,
					isTypeOnly: false,
					isSideEffect: false,
				});
			}
		}

		// Type-only imports
		while ((match = typeImportRegex.exec(content)) !== null) {
			const named = match[1];
			const defaultImport = match[2];
			const specifier = match[3];

			if (specifier && !this.isIgnoredSpecifier(specifier)) {
				const symbols: string[] = [];
				if (named) {
					symbols.push(
						...named.split(",").map((s) => s.trim().split(/\s+as\s+/)[0])
					);
				}
				if (defaultImport) {
					symbols.push("default");
				}

				imports.push({
					targetUri:
						this.resolveImportUri(sourceUri, specifier)?.toString() || "",
					specifier,
					symbols,
					isTypeOnly: true,
					isSideEffect: false,
				});
			}
		}

		// Side-effect imports
		while ((match = sideEffectRegex.exec(content)) !== null) {
			const specifier = match[1];
			if (specifier && !this.isIgnoredSpecifier(specifier)) {
				imports.push({
					targetUri:
						this.resolveImportUri(sourceUri, specifier)?.toString() || "",
					specifier,
					symbols: [],
					isTypeOnly: false,
					isSideEffect: true,
				});
			}
		}

		return imports;
	}

	private extractExports(content: string): ExportEdge[] {
		const exports: ExportEdge[] = [];

		// Named exports: export { ... }
		const namedExportRegex = /export\s+(?:type\s+)?\{([^}]+)\}/g;
		let match;
		while ((match = namedExportRegex.exec(content)) !== null) {
			const symbols = match[1]
				.split(",")
				.map((s) => s.trim().split(/\s+as\s+/)[0]);
			const isTypeOnly = match[0].includes("type");
			for (const symbol of symbols) {
				exports.push({
					symbol,
					isTypeOnly,
					isDefault: false,
				});
			}
		}

		// Default export: export default ...
		const defaultExportRegex = /export\s+default\s+(\w+)/g;
		while ((match = defaultExportRegex.exec(content)) !== null) {
			exports.push({
				symbol: match[1] || "default",
				isTypeOnly: false,
				isDefault: true,
			});
		}

		// Export declarations: export class/function/const
		const declarationExportRegex =
			/export\s+(?:type\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g;
		while ((match = declarationExportRegex.exec(content)) !== null) {
			exports.push({
				symbol: match[1],
				isTypeOnly:
					match[0].includes("type") ||
					match[0].includes("interface") ||
					match[0].includes("enum"),
				isDefault: false,
			});
		}

		return exports;
	}

	private resolveImportUri(sourceUri: URI, specifier: string): URI | undefined {
		if (specifier.startsWith(".")) {
			const dirSegments = sourceUri.path
				.split("/")
				.slice(0, -1)
				.filter(Boolean);
			const relativeSegments = specifier
				.split("/")
				.filter((segment) => segment.length > 0)
				.map((segment) => (segment === "." ? "" : segment))
				.filter((segment) => segment.length > 0);
			const targetUri = joinPath(
				URI.from({
					scheme: sourceUri.scheme,
					authority: sourceUri.authority,
					path: "/" + dirSegments.join("/"),
				}),
				...relativeSegments
			);
			return targetUri;
		}
		return undefined;
	}

	private isIgnoredSpecifier(specifier: string): boolean {
		// Ignore common non-code imports
		return (
			specifier.endsWith(".css") ||
			specifier.endsWith(".scss") ||
			specifier.endsWith(".json") ||
			specifier.startsWith("@types/")
		);
	}

	private async getFileHash(fileUri: URI): Promise<string | undefined> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			if (workspaceFolders.length === 0) {
				return undefined;
			}

			const relativePath = this.getRelativePath(
				fileUri,
				workspaceFolders[0].uri
			);
			let hash = await this.merkleTreeService.getPathHash(relativePath);
			if (!hash) {
				await this.merkleTreeService.ensureTracked(fileUri);
				hash = await this.merkleTreeService.getPathHash(relativePath);
			}
			return hash || undefined;
		} catch {
			return undefined;
		}
	}

	private getRelativePath(fileUri: URI, workspaceRoot: URI): string {
		const filePath = fileUri.path;
		const rootPath = workspaceRoot.path;
		if (filePath.startsWith(rootPath)) {
			return filePath.substring(rootPath.length).replace(/^\//, "");
		}
		return filePath;
	}

	private getFileKey(fileUri: URI): string {
		return fileUri.toString();
	}
}
