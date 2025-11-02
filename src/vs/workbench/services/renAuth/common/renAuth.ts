/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IRenAuthService = createDecorator<IRenAuthService>('renAuthService');

export interface IRenAuthService {
	readonly _serviceBrand: undefined;

	// State
	readonly isAuthenticated: boolean;
	readonly currentUser: IRenUser | undefined;

	// Events
	readonly onDidChangeAuthStatus: Event<boolean>;
	readonly onDidChangeUser: Event<IRenUser | undefined>;

	// Methods
	login(email: string, password: string, rememberMe: boolean): Promise<IRenLoginResult>;
	logout(): Promise<void>;
	refreshToken(): Promise<boolean>;
	checkAuthStatus(): Promise<boolean>;
}

export interface IRenUser {
	id: string;
	username: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
	createdAt: number;
}

export interface IRenLoginResult {
	success: boolean;
	user?: IRenUser;
	error?: string;
	errorCode?: 'INVALID_CREDENTIALS' | 'NETWORK_ERROR' | 'SERVER_ERROR';
}

