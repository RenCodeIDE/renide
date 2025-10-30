/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkspaceContextService, IWorkspace, IWorkspaceFolder } from '../../../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../../../base/common/uri.js';

export class GraphWorkspaceContext {
	public readonly extUri = this.uriIdentityService.extUri;

	constructor(
		private readonly workspaceService: IWorkspaceContextService,
		private readonly uriIdentityService: IUriIdentityService
	) { }

	getWorkspace(): IWorkspace {
		return this.workspaceService.getWorkspace();
	}

	getWorkspaceFolders(): readonly IWorkspaceFolder[] {
		return this.getWorkspace().folders;
	}

	getDefaultWorkspaceRoot(): URI | undefined {
		return this.getWorkspace().folders[0]?.uri;
	}

	formatNodeLabel(resource: URI): string {
		for (const folder of this.getWorkspaceFolders()) {
			const relative = this.extUri.relativePath(folder.uri, resource);
			if (relative) {
				return relative;
			}
		}
		return this.extUri.basename(resource);
	}

	getUriKey(uri: URI): string {
		return this.extUri.getComparisonKey(uri, true);
	}

	isWithinWorkspace(uri: URI): boolean {
		for (const folder of this.getWorkspaceFolders()) {
			if (this.extUri.isEqualOrParent(uri, folder.uri)) {
				return true;
			}
		}
		return false;
	}
}

