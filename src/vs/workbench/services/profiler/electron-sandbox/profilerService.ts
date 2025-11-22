/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProfilerService, ProfilerIpcChannels } from '../../../../platform/profiler/common/profiler.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(IProfilerService, ProfilerIpcChannels.Profiler);
