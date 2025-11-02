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

	constructor(
		private readonly requestService: IRequestService,
		private readonly productService: IProductService,
		private readonly logService: ILogService
	) { }

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
				const result = await asJson<IRenUser>(response);
				if (!result) {
					throw new Error('Get profile failed: Empty response from server');
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
				throw new Error(`Get profile failed: ${errorMessage}`);
			}
		} catch (error) {
			this.logService.error('[RenAuth] Get profile error:', error);
			throw error;
		}
	}

	private getEndpoint(path: string): string {
		const baseUrl = this.productService.renAccount?.apiBaseUrl;
		if (!baseUrl) {
			throw new Error('Ren API base URL not configured in product.json');
		}
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

