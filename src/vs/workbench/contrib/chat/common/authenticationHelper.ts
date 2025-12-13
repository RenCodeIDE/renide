/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from "../../../../platform/log/common/log.js";
import { ISecretStorageService } from "../../../../platform/secrets/common/secrets.js";

/**
 * Storage keys for authentication tokens
 */
const AUTH_STORAGE_KEYS = {
	accessToken: "ren.auth.accessToken",
	refreshToken: "ren.auth.refreshToken",
} as const;

/**
 * Centralized authentication helper for chat agents.
 * Provides consistent token retrieval, caching, and error handling.
 */
export class AuthenticationHelper {
	private tokenCache: string | undefined;
	private tokenCacheTime: number = 0;
	private readonly cacheTTLMs = 60000; // 1 minute cache

	constructor(
		private readonly secretStorageService: ISecretStorageService,
		private readonly logService: ILogService,
		private readonly agentContext: string
	) { }

	/**
	 * Get the access token for API requests.
	 * Includes caching to reduce secret storage lookups.
	 */
	async getAccessToken(): Promise<string | undefined> {
		// Check cache first
		const now = Date.now();
		if (this.tokenCache && now - this.tokenCacheTime < this.cacheTTLMs) {
			return this.tokenCache;
		}

		try {
			const token = await this.secretStorageService.get(AUTH_STORAGE_KEYS.accessToken);

			if (token) {
				this.logService.debug(
					`[${this.agentContext}] Access token retrieved successfully (length: ${token.length})`
				);
				// Update cache
				this.tokenCache = token;
				this.tokenCacheTime = now;
			} else {
				this.logService.warn(
					`[${this.agentContext}] No access token found in secret storage. User needs to authenticate.`
				);
				// Clear cache
				this.tokenCache = undefined;
			}

			return token ?? undefined;
		} catch (error) {
			this.logService.error(
				`[${this.agentContext}] Error retrieving access token: ${error instanceof Error ? error.message : String(error)
				}`
			);
			// Clear cache on error
			this.tokenCache = undefined;
			return undefined;
		}
	}

	/**
	 * Check if the user has a valid access token without returning it.
	 * Useful for UI state checks.
	 */
	async hasAccessToken(): Promise<boolean> {
		const token = await this.getAccessToken();
		return token !== undefined && token.length > 0;
	}

	/**
	 * Clear the token cache.
	 * Should be called when authentication state changes.
	 */
	clearCache(): void {
		this.tokenCache = undefined;
		this.tokenCacheTime = 0;
		this.logService.debug(`[${this.agentContext}] Token cache cleared`);
	}

	/**
	 * Get the refresh token if available.
	 */
	async getRefreshToken(): Promise<string | undefined> {
		try {
			return (await this.secretStorageService.get(AUTH_STORAGE_KEYS.refreshToken)) ?? undefined;
		} catch (error) {
			this.logService.error(
				`[${this.agentContext}] Error retrieving refresh token: ${error instanceof Error ? error.message : String(error)
				}`
			);
			return undefined;
		}
	}
}

/**
 * Factory function to create an AuthenticationHelper for a specific agent
 */
export function createAuthenticationHelper(
	secretStorageService: ISecretStorageService,
	logService: ILogService,
	agentContext: string
): AuthenticationHelper {
	return new AuthenticationHelper(secretStorageService, logService, agentContext);
}

/**
 * Export storage keys for external use if needed
 */
export { AUTH_STORAGE_KEYS };
