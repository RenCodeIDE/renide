/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IRenAuthService, IRenLoginResult, IRenUser } from '../common/renAuth.js';
import { RenApiClient } from '../common/renApiClient.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

const REN_AUTH_STORAGE_KEYS = {
	ACCESS_TOKEN: 'ren.auth.accessToken',
	REFRESH_TOKEN: 'ren.auth.refreshToken',
	TOKEN_EXPIRY: 'ren.auth.tokenExpiry',
	REMEMBERED_EMAIL: 'ren.auth.rememberedEmail',
	USER_PROFILE: 'ren.auth.userProfile'
};

export class RenAuthService extends Disposable implements IRenAuthService {

	declare readonly _serviceBrand: undefined;

	private _isAuthenticated: boolean = false;
	private _currentUser: IRenUser | undefined = undefined;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<boolean>());
	readonly onDidChangeAuthStatus: Event<boolean> = this._onDidChangeAuthStatus.event;

	private readonly _onDidChangeUser = this._register(new Emitter<IRenUser | undefined>());
	readonly onDidChangeUser: Event<IRenUser | undefined> = this._onDidChangeUser.event;

	private _refreshTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private readonly apiClient: RenApiClient;
	private _isCheckingAuthStatus: boolean = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.apiClient = new RenApiClient(this.requestService, this.productService, this.logService);
		this._register(this.secretStorageService.onDidChangeSecret((key) => {
			if (key === REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN || key === REN_AUTH_STORAGE_KEYS.REFRESH_TOKEN) {
				// If tokens change externally and we're not already checking, recheck auth status
				if (!this._isCheckingAuthStatus) {
					void this.checkAuthStatus();
				}
			}
		}));
	}

	get isAuthenticated(): boolean {
		return this._isAuthenticated;
	}

	get currentUser(): IRenUser | undefined {
		return this._currentUser;
	}

	async login(email: string, password: string, rememberMe: boolean): Promise<IRenLoginResult> {
		try {
			this.logService.info('[RenAuth] Attempting login for:', email);

			const response = await this.apiClient.login(email, password);
			const expiresAt = Date.now() + (response.expiresIn * 1000);

			// Store tokens securely
			await this.secretStorageService.set(REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN, response.accessToken);
			await this.secretStorageService.set(REN_AUTH_STORAGE_KEYS.REFRESH_TOKEN, response.refreshToken);

			// Store token expiry and user profile
			this.storageService.store(REN_AUTH_STORAGE_KEYS.TOKEN_EXPIRY, expiresAt, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.storageService.store(REN_AUTH_STORAGE_KEYS.USER_PROFILE, JSON.stringify(response.user), StorageScope.APPLICATION, StorageTarget.MACHINE);

			// Store email if remember me checked
			if (rememberMe) {
				this.storageService.store(REN_AUTH_STORAGE_KEYS.REMEMBERED_EMAIL, email, StorageScope.APPLICATION, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(REN_AUTH_STORAGE_KEYS.REMEMBERED_EMAIL, StorageScope.APPLICATION);
			}

			this._isAuthenticated = true;
			this._currentUser = response.user;

			this._onDidChangeAuthStatus.fire(true);
			this._onDidChangeUser.fire(response.user);

			// Schedule token refresh
			this._scheduleTokenRefresh(expiresAt);

			this.logService.info('[RenAuth] Login successful for:', email);

			return {
				success: true,
				user: response.user
			};
		} catch (error) {
			this.logService.error('[RenAuth] Login failed:', error);

			let errorCode: 'INVALID_CREDENTIALS' | 'NETWORK_ERROR' | 'SERVER_ERROR' = 'SERVER_ERROR';
			if (error instanceof Error) {
				if (error.message.includes('401') || error.message.includes('403')) {
					errorCode = 'INVALID_CREDENTIALS';
				} else if (error.message.includes('Network') || error.message.includes('fetch')) {
					errorCode = 'NETWORK_ERROR';
				}
			}

			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
				errorCode
			};
		}
	}

	async logout(): Promise<void> {
		this.logService.info('[RenAuth] Logging out');

		// Clear tokens
		await this.secretStorageService.delete(REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN);
		await this.secretStorageService.delete(REN_AUTH_STORAGE_KEYS.REFRESH_TOKEN);

		// Clear other storage
		this.storageService.remove(REN_AUTH_STORAGE_KEYS.TOKEN_EXPIRY, StorageScope.APPLICATION);
		this.storageService.remove(REN_AUTH_STORAGE_KEYS.USER_PROFILE, StorageScope.APPLICATION);

		// Stop refresh timer
		this._clearRefreshTimer();

		this._isAuthenticated = false;
		this._currentUser = undefined;

		this._onDidChangeAuthStatus.fire(false);
		this._onDidChangeUser.fire(undefined);
	}

	async refreshToken(): Promise<boolean> {
		try {
			const refreshToken = await this.secretStorageService.get(REN_AUTH_STORAGE_KEYS.REFRESH_TOKEN);
			if (!refreshToken) {
				this.logService.warn('[RenAuth] No refresh token available');
				return false;
			}

			this.logService.info('[RenAuth] Refreshing token');

			const response = await this.apiClient.refreshToken(refreshToken);
			const newExpiresAt = Date.now() + (response.expiresIn * 1000);

			// Update access token
			await this.secretStorageService.set(REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN, response.accessToken);
			this.storageService.store(REN_AUTH_STORAGE_KEYS.TOKEN_EXPIRY, newExpiresAt, StorageScope.APPLICATION, StorageTarget.MACHINE);

			// Schedule next refresh
			this._scheduleTokenRefresh(newExpiresAt);

			this.logService.info('[RenAuth] Token refreshed successfully');

			return true;
		} catch (error) {
			this.logService.error('[RenAuth] Token refresh failed:', error);

			// If refresh fails, logout
			await this.logout();

			return false;
		}
	}

	async checkAuthStatus(): Promise<boolean> {
		// Prevent recursion if called from onDidChangeSecret handler
		if (this._isCheckingAuthStatus) {
			this.logService.trace('[RenAuth] Already checking auth status, skipping');
			return this._isAuthenticated;
		}

		this._isCheckingAuthStatus = true;
		try {
			const accessToken = await this.secretStorageService.get(REN_AUTH_STORAGE_KEYS.ACCESS_TOKEN);
			if (!accessToken) {
				this.logService.info('[RenAuth] No access token found');
				return false;
			}

			const expiryStr = this.storageService.get(REN_AUTH_STORAGE_KEYS.TOKEN_EXPIRY, StorageScope.APPLICATION);
			const profileStr = this.storageService.get(REN_AUTH_STORAGE_KEYS.USER_PROFILE, StorageScope.APPLICATION);

			if (!expiryStr || !profileStr) {
				this.logService.warn('[RenAuth] Incomplete auth data found');
				return false;
			}

			const expiry = parseInt(expiryStr, 10);
			const now = Date.now();

			// Check if expiry is valid
			if (isNaN(expiry)) {
				this.logService.warn('[RenAuth] Invalid expiry time');
				return false;
			}

			// Check if token is expired or about to expire (within 5 minutes)
			if (now >= expiry - (5 * 60 * 1000)) {
				this.logService.info('[RenAuth] Token expired or about to expire, attempting refresh');
				const refreshed = await this.refreshToken();
				if (!refreshed) {
					return false;
				}
				// After refresh, re-read the updated data
				return this.checkAuthStatus();
			}

			// Load user profile
			try {
				const user = JSON.parse(profileStr) as IRenUser;
				this._currentUser = user;
				this._isAuthenticated = true;

				this._onDidChangeAuthStatus.fire(true);
				this._onDidChangeUser.fire(user);

				// Schedule token refresh
				this._scheduleTokenRefresh(expiry);

				this.logService.info('[RenAuth] Auth status check successful');

				return true;
			} catch (error) {
				this.logService.error('[RenAuth] Failed to parse user profile:', error);
				return false;
			}
		} catch (error) {
			this.logService.error('[RenAuth] Auth status check failed:', error);
			return false;
		} finally {
			this._isCheckingAuthStatus = false;
		}
	}

	private _scheduleTokenRefresh(expiresAt: number): void {
		this._clearRefreshTimer();

		const now = Date.now();
		const timeUntilExpiry = expiresAt - now;
		// Schedule refresh 5 minutes before expiry
		const refreshTime = Math.max(0, timeUntilExpiry - (5 * 60 * 1000));

		this.logService.info(`[RenAuth] Scheduling token refresh in ${Math.round(refreshTime / 1000 / 60)} minutes`);

		if (refreshTime > 0) {
			this._refreshTimer = setTimeout(async () => {
				try {
					await this.refreshToken();
				} catch (error) {
					this.logService.error('[RenAuth] Failed to refresh token in scheduled callback:', error);
				}
			}, refreshTime);
		} else {
			// Token expires soon, refresh immediately
			this.refreshToken().catch(error => {
				this.logService.error('[RenAuth] Failed to refresh token immediately:', error);
			});
		}
	}

	private _clearRefreshTimer(): void {
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}

	override dispose(): void {
		this._clearRefreshTimer();
		super.dispose();
	}
}

registerSingleton(IRenAuthService, RenAuthService, InstantiationType.Delayed);

