/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IGitHeatmapService = createDecorator<IGitHeatmapService>('gitHeatmapService');
export const REN_GIT_HEATMAP_CHANNEL = 'renGitHeatmap';

export interface IGitHeatmapService {
	readonly _serviceBrand: undefined;
	readGitLog(cwd: string, windowDays: number): Promise<string>;
}

export class NullGitHeatmapService implements IGitHeatmapService {
	declare readonly _serviceBrand: undefined;

	async readGitLog(): Promise<string> {
		throw new Error('Git heatmap is not supported in this environment.');
	}
}

