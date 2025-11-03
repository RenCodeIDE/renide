/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService, asJson, asText, isSuccess } from '../../../../platform/request/common/request.js';
import { IRenUser } from './renAuth.js';

export class RenApiClient {
	private readonly serverAddress: string | undefined;

	constructor(
		private readonly requestService: IRequestService,
		private readonly productService: IProductService,
		private readonly logService: ILogService,
		serverAddress?: string
	) {
		this.serverAddress = serverAddress;
	}

	async login(email: string, password: string): Promise<ILoginResponse> {
		const url = this.getEndpoint('/api/auth/login');
		try {
			const response = await this.requestService.request({
				type: 'POST',
				url,
				data: JSON.stringify({ email, password }),
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				}
			}, CancellationToken.None);

			if (isSuccess(response)) {
				const result = await asJson<ILoginResponse>(response);
				if (!result) {
					throw new Error('Login failed: Empty response from server');
				}
				// Validate and normalize user object structure
				if (!result.user || typeof result.user !== 'object') {
					throw new Error('Login failed: Invalid user object in response');
				}
				// API returns different structure, so we need to normalize it
				// API response structure: { id: number, name: string, email: string, createdAt: string }
				const apiUser = result.user as { id?: number | string; name?: string; displayName?: string; username?: string; email?: string; createdAt?: number | string; avatarUrl?: string };

				// Normalize API response to match IRenUser structure
				// API returns: id (number), name (string), email (string), createdAt (ISO string)
				// We need: id (string), username (string), email (string), displayName (string), createdAt (number)

				// Convert id to string (API returns number)
				const id = apiUser.id !== null && apiUser.id !== undefined ? String(apiUser.id) : null;
				if (!id) {
					throw new Error('Login failed: Missing or invalid user.id');
				}

				// Validate email
				if (typeof apiUser.email !== 'string' || !apiUser.email) {
					throw new Error('Login failed: Missing or invalid user.email');
				}

				// Map 'name' to 'displayName' (API uses 'name' field)
				const displayName = typeof apiUser.name === 'string' ? apiUser.name : (typeof apiUser.displayName === 'string' ? apiUser.displayName : '');

				// Derive username from email if not provided (extract part before @)
				const username = typeof apiUser.username === 'string' && apiUser.username ? apiUser.username : apiUser.email.split('@')[0];

				// Convert createdAt from ISO string to timestamp number
				let createdAt: number;
				if (typeof apiUser.createdAt === 'number') {
					createdAt = apiUser.createdAt;
				} else if (typeof apiUser.createdAt === 'string') {
					const parsed = Date.parse(apiUser.createdAt);
					if (isNaN(parsed)) {
						throw new Error('Login failed: Invalid user.createdAt format');
					}
					createdAt = parsed;
				} else {
					throw new Error('Login failed: Missing or invalid user.createdAt');
				}

				// Normalize avatarUrl (optional)
				const avatarUrl = typeof apiUser.avatarUrl === 'string' ? apiUser.avatarUrl : undefined;

				// Create normalized user object
				const normalizedUser: IRenUser = {
					id,
					username,
					email: apiUser.email,
					displayName,
					avatarUrl,
					createdAt
				};

				// Update result with normalized user
				result.user = normalizedUser;
				return result;
			} else {
				const errorText = await asText(response).catch(() => null);
				let errorMessage = 'Unknown error';
				try {
					if (errorText) {
						const parsed = JSON.parse(errorText);
						errorMessage = parsed.error || errorMessage;
					}
				} catch {
					// Not JSON, use raw text
				}
				throw new Error(`Login failed: ${errorMessage}`);
			}
		} catch (error) {
			this.logService.error('[RenAuth] Login error:', error);
			throw error;
		}
	}

	async refreshToken(refreshToken: string): Promise<IRefreshResponse> {
		const url = this.getEndpoint('/api/auth/refresh');
		try {
			const response = await this.requestService.request({
				type: 'POST',
				url,
				data: JSON.stringify({ refreshToken }),
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				}
			}, CancellationToken.None);

			if (isSuccess(response)) {
				const result = await asJson<IRefreshResponse>(response);
				if (!result) {
					throw new Error('Token refresh failed: Empty response from server');
				}
				return result;
			} else {
				const errorText = await asText(response).catch(() => null);
				let errorMessage = 'Unknown error';
				try {
					if (errorText) {
						const parsed = JSON.parse(errorText);
						errorMessage = parsed.error || errorMessage;
					}
				} catch {
					// Not JSON, use raw text
				}
				throw new Error(`Token refresh failed: ${errorMessage}`);
			}
		} catch (error) {
			this.logService.error('[RenAuth] Token refresh error:', error);
			throw error;
		}
	}

	async getUserProfile(accessToken: string): Promise<IRenUser> {
		const url = this.getEndpoint('/api/user/profile');
		try {
			const response = await this.requestService.request({
				type: 'GET',
				url,
				headers: {
					'Authorization': `Bearer ${accessToken}`,
					'Accept': 'application/json'
				}
			}, CancellationToken.None);

			if (isSuccess(response)) {
				const apiUser = await asJson<{ id?: number | string; name?: string; displayName?: string; username?: string; email?: string; createdAt?: number | string; avatarUrl?: string }>(response);
				if (!apiUser || typeof apiUser !== 'object') {
					throw new Error('Get profile failed: Empty or invalid response from server');
				}

				// Normalize API response to match IRenUser structure
				// DB schema: id (serial/number), name (text), email (text), createdAt (timestamp/ISO string)
				// We need: id (string), username (string), email (string), displayName (string), createdAt (number)

				// Convert id to string (DB returns number from serial)
				const id = apiUser.id !== null && apiUser.id !== undefined ? String(apiUser.id) : null;
				if (!id) {
					throw new Error('Get profile failed: Missing or invalid id');
				}

				// Validate email
				if (typeof apiUser.email !== 'string' || !apiUser.email) {
					throw new Error('Get profile failed: Missing or invalid email');
				}

				// Map 'name' to 'displayName' (DB uses 'name' field)
				const displayName = typeof apiUser.name === 'string' ? apiUser.name : (typeof apiUser.displayName === 'string' ? apiUser.displayName : '');

				// Derive username from email if not provided (extract part before @)
				const username = typeof apiUser.username === 'string' && apiUser.username ? apiUser.username : apiUser.email.split('@')[0];

				// Convert createdAt from ISO string to timestamp number
				let createdAt: number;
				if (typeof apiUser.createdAt === 'number') {
					createdAt = apiUser.createdAt;
				} else if (typeof apiUser.createdAt === 'string') {
					const parsed = Date.parse(apiUser.createdAt);
					if (isNaN(parsed)) {
						throw new Error('Get profile failed: Invalid createdAt format');
					}
					createdAt = parsed;
				} else {
					throw new Error('Get profile failed: Missing or invalid createdAt');
				}

				// Normalize avatarUrl (optional, not in DB schema)
				const avatarUrl = typeof apiUser.avatarUrl === 'string' ? apiUser.avatarUrl : undefined;

				// Create normalized user object matching IRenUser interface
				const normalizedUser: IRenUser = {
					id,
					username,
					email: apiUser.email,
					displayName,
					avatarUrl,
					createdAt
				};

				return normalizedUser;
			} else {
				const errorText = await asText(response).catch(() => null);
				let errorMessage = 'Unknown error';
				try {
					if (errorText) {
						const parsed = JSON.parse(errorText);
						errorMessage = parsed.error || errorMessage;
					}
				} catch {
					// Not JSON, use raw text
				}
				throw new Error(`Get profile failed: ${errorMessage}`);
			}
		} catch (error) {
			this.logService.error('[RenAuth] Get profile error:', error);
			throw error;
		}
	}

	private getEndpoint(path: string): string {
		// Prefer SERVER_ADDRESS from environment if available, otherwise fall back to product.json
		let baseUrl = this.serverAddress;

		if (!baseUrl) {
			baseUrl = this.productService.renAccount?.apiBaseUrl;
		}

		if (!baseUrl) {
			throw new Error('Ren API base URL not configured. Set SERVER_ADDRESS environment variable or configure apiBaseUrl in product.json');
		}

		// Normalize the URL (ensure it doesn't end with a slash)
		baseUrl = baseUrl.trim().replace(/\/+$/, '');

		return `${baseUrl}${path}`;
	}
}

export interface ILoginResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number; // seconds
	user: IRenUser;
}

export interface IRefreshResponse {
	accessToken: string;
	expiresIn: number;
}

