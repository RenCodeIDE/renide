/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IProfilerService = createDecorator<IProfilerService>('profilerService');

export interface ProfileRun {
	id: string;
	createdAt: string;
	command: string;
	cwd: string;
	language: "python" | "node" | "unknown";
	durationMs: number;
	samples: number;
	exitCode: number | null;
}

export interface Hotspot {
	runId: string;
	filePath: string;
	functionName: string | null;
	lineStart: number | null;
	lineEnd: number | null;
	cpuPercent: number;      // inclusive
	selfCpuPercent: number;  // leaf-only
	callCount?: number;
	chunkId?: string;
}

export interface IProfilerService {
	readonly _serviceBrand: undefined;

	runProfile(command: string, cwd: string, workspaceId: string): Promise<ProfileRun>;
	getProfileRuns(workspaceId: string): Promise<ProfileRun[]>;
	getHotspots(workspaceId: string, runId: string): Promise<Hotspot[]>;
}

export const ProfilerIpcChannels = {
	Profiler: 'profiler'
} as const;

export const ERROR_UNSUPPORTED_LANGUAGE = 'ERROR_UNSUPPORTED_LANGUAGE';
