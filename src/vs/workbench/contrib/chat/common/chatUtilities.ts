/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat Utilities Index
 *
 * Re-exports commonly used utilities for chat agents.
 * Import from this file for cleaner imports across agent implementations.
 */

// Error handling
export {
	ChatErrorHandler,
	createChatErrorHandler,
	type ServerToolResult,
} from "./chatErrorHandler.js";

// Configuration
export {
	ChatConfigurationService,
	createChatConfigurationService,
	CHAT_DEFAULT_CONFIG,
	type IChatConfiguration,
} from "./chatConfigurationService.js";

// Authentication
export {
	AuthenticationHelper,
	createAuthenticationHelper,
	AUTH_STORAGE_KEYS,
} from "./authenticationHelper.js";
