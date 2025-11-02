/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const RenAccountDashboardIcon = registerIcon('ren-account-dashboard-editor-label-icon', Codicon.account, localize('renAccountDashboardEditorLabelIcon', 'Icon of the Ren account dashboard editor label.'));

export class RenAccountDashboardInput extends EditorInput {
	static readonly ID: string = 'workbench.input.renAccountDashboard';

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return RenAccountDashboardInput.ID;
	}

	readonly resource: URI = URI.from({
		scheme: Schemas.vscodeRenAccount,
		path: `renAccountDashboard`
	});

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof RenAccountDashboardInput;
	}

	override getName(): string {
		return localize('renAccountDashboardEditorInputName', "Ren Account");
	}

	override getIcon(): ThemeIcon {
		return RenAccountDashboardIcon;
	}
}

