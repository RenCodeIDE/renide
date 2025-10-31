/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { IGitHeatmapService, REN_GIT_HEATMAP_CHANNEL } from '../common/gitHeatmapService.js';

registerMainProcessRemoteService(IGitHeatmapService, REN_GIT_HEATMAP_CHANNEL);

