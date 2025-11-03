/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, promises } from "fs";
import * as http from "http";
import * as url from "url";
import * as cookie from "cookie";
import * as crypto from "crypto";
import { isEqualOrParent } from "../../base/common/extpath.js";
import { getMediaMime } from "../../base/common/mime.js";
import { isLinux } from "../../base/common/platform.js";
import { ILogService, LogLevel } from "../../platform/log/common/log.js";
import { IServerEnvironmentService } from "./serverEnvironmentService.js";
import {
	extname,
	dirname,
	join,
	normalize,
	posix,
	resolve,
} from "../../base/common/path.js";
import {
	FileAccess,
	connectionTokenCookieName,
	connectionTokenQueryName,
	Schemas,
	builtinExtensionsPath,
} from "../../base/common/network.js";
import { generateUuid } from "../../base/common/uuid.js";
import { IProductService } from "../../platform/product/common/productService.js";
import {
	ServerConnectionToken,
	ServerConnectionTokenType,
} from "./serverConnectionToken.js";
import {
	asTextOrError,
	IRequestService,
} from "../../platform/request/common/request.js";
import { IHeaders } from "../../base/parts/request/common/request.js";
import { CancellationToken } from "../../base/common/cancellation.js";
import { URI } from "../../base/common/uri.js";
import { streamToBuffer } from "../../base/common/buffer.js";
import { IProductConfiguration } from "../../base/common/product.js";
import { isString, Mutable } from "../../base/common/types.js";
import { CharCode } from "../../base/common/charCode.js";
import { IExtensionManifest } from "../../platform/extensions/common/extensions.js";
import { ICSSDevelopmentService } from "../../platform/cssDev/node/cssDevService.js";

const textMimeType: { [ext: string]: string | undefined } = {
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".css": "text/css",
	".svg": "image/svg+xml",
};

/**
 * Return an error to the client.
 */
export async function serveError(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	errorCode: number,
	errorMessage: string,
	extraHeaders: Record<string, string> = Object.create(null)
): Promise<void> {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		...extraHeaders,
	};
	res.writeHead(errorCode, headers);
	res.end(errorMessage);
}

export const enum CacheControl {
	NO_CACHING,
	ETAG,
	NO_EXPIRY,
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(
	filePath: string,
	cacheControl: CacheControl,
	logService: ILogService,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	responseHeaders: Record<string, string>
): Promise<void> {
	try {
		const stat = await promises.stat(filePath); // throws an error if file doesn't exist
		if (cacheControl === CacheControl.ETAG) {
			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join(
				"-"
			)}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304);
				return void res.end();
			}

			responseHeaders["Etag"] = etag;
		} else if (cacheControl === CacheControl.NO_EXPIRY) {
			responseHeaders["Cache-Control"] = "public, max-age=31536000";
		} else if (cacheControl === CacheControl.NO_CACHING) {
			responseHeaders["Cache-Control"] = "no-store";
		}

		responseHeaders["Content-Type"] =
			textMimeType[extname(filePath)] || getMediaMime(filePath) || "text/plain";

		res.writeHead(200, responseHeaders);

		// Data
		createReadStream(filePath).pipe(res);
	} catch (error) {
		if (error.code !== "ENOENT") {
			logService.error(error);
			console.error(error.toString());
		} else {
			console.error(`File not found: ${filePath}`);
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		return void res.end("Not found");
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri("").fsPath);

const STATIC_PATH = `/static`;
const CALLBACK_PATH = `/callback`;
const WEB_EXTENSION_PATH = `/web-extension-resource`;
const OPEN_VSX_PROXY_PATH = `/openvsx`;
const OPEN_VSX_API_BASE_URL = "https://open-vsx.org/api";

export class WebClientServer {
	private readonly _webExtensionResourceUrlTemplate: URI | undefined;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _basePath: string,
		private readonly _productPath: string,
		@IServerEnvironmentService
		private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@ICSSDevelopmentService
		private readonly _cssDevService: ICSSDevelopmentService
	) {
		this._webExtensionResourceUrlTemplate = this._productService
			.extensionsGallery?.resourceUrlTemplate
			? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate)
			: undefined;
	}

	/**
	 * Handle web resources (i.e. only needed by the web client).
	 * **NOTE**: This method is only invoked when the server has web bits.
	 * **NOTE**: This method is only invoked after the connection token has been validated.
	 * @param parsedUrl The URL to handle, including base and product path
	 * @param pathname The pathname of the URL, without base and product path
	 */
	async handle(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery,
		pathname: string
	): Promise<void> {
		try {
			if (
				pathname.startsWith(STATIC_PATH) &&
				pathname.charCodeAt(STATIC_PATH.length) === CharCode.Slash
			) {
				return this._handleStatic(
					req,
					res,
					pathname.substring(STATIC_PATH.length)
				);
			}
			if (pathname === "/") {
				return this._handleRoot(req, res, parsedUrl);
			}
			if (pathname === CALLBACK_PATH) {
				// callback support
				return this._handleCallback(res);
			}
			if (
				pathname.startsWith(WEB_EXTENSION_PATH) &&
				pathname.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash
			) {
				// extension resource support
				return this._handleWebExtensionResource(
					req,
					res,
					pathname.substring(WEB_EXTENSION_PATH.length)
				);
			}
			if (
				pathname.startsWith(OPEN_VSX_PROXY_PATH) &&
				pathname.charCodeAt(OPEN_VSX_PROXY_PATH.length) === CharCode.Slash
			) {
				return this._handleOpenVSXProxy(
					req,
					res,
					pathname.substring(OPEN_VSX_PROXY_PATH.length),
					parsedUrl
				);
			}

			return serveError(req, res, 404, "Not found.");
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, "Internal Server Error.");
		}
	}
	/**
	 * Handle HTTP requests for /static/*
	 * @param resourcePath The path after /static/
	 */
	private async _handleStatic(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		resourcePath: string
	): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		// Strip the this._staticRoute from the path
		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)

		const filePath = join(APP_ROOT, normalizedPathname); // join also normalizes the path
		if (!isEqualOrParent(filePath, APP_ROOT, !isLinux)) {
			return serveError(req, res, 400, `Bad request.`);
		}

		return serveFile(
			filePath,
			this._environmentService.isBuilt
				? CacheControl.NO_EXPIRY
				: CacheControl.ETAG,
			this._logService,
			req,
			res,
			headers
		);
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf(".");
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 * @param resourcePath The path after /web-extension-resource/
	 */
	private async _handleWebExtensionResource(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		resourcePath: string
	): Promise<void> {
		const corsHeaders = this._buildCorsHeaders(req.headers);
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(
				req,
				res,
				500,
				"No extension gallery service configured.",
				corsHeaders
			);
		}

		if (req.method?.toUpperCase() === "OPTIONS") {
			res.writeHead(204, corsHeaders);
			return void res.end();
		}

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname);
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf("/")),
			path: path.substring(path.indexOf("/") + 1),
		});

		if (
			this._getResourceURLTemplateAuthority(
				this._webExtensionResourceUrlTemplate
			) !== this._getResourceURLTemplateAuthority(uri)
		) {
			return serveError(req, res, 403, "Request Forbidden", corsHeaders);
		}

		const headers: IHeaders = {};
		const setRequestHeader = (header: string) => {
			const value = req.headers[header];
			if (value && (isString(value) || value[0])) {
				headers[header] = isString(value) ? value : value[0];
			} else if (header !== header.toLowerCase()) {
				setRequestHeader(header.toLowerCase());
			}
		};
		setRequestHeader("X-Client-Name");
		setRequestHeader("X-Client-Version");
		setRequestHeader("X-Machine-Id");
		setRequestHeader("X-Client-Commit");

		const context = await this._requestService.request(
			{
				type: "GET",
				url: uri.toString(true),
				headers,
			},
			CancellationToken.None
		);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {
				/* Ignore */
			}
			return serveError(
				req,
				res,
				status,
				text || `Request failed with status ${status}`,
				corsHeaders
			);
		}

		const responseHeaders: Record<string, string | string[]> =
			Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader("Cache-Control");
		setResponseHeader("Content-Type");
		for (const key in corsHeaders) {
			responseHeaders[key] = corsHeaders[key];
		}
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return void res.end(buffer.buffer);
	}

	private async _handleOpenVSXProxy(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		resourcePath: string,
		parsedUrl: url.UrlWithParsedQuery
	): Promise<void> {
		const corsHeaders = this._buildCorsHeaders(req.headers);
		const method = req.method?.toUpperCase();
		if (method === "OPTIONS") {
			res.writeHead(204, corsHeaders);
			return void res.end();
		}
		if (method !== "GET") {
			return serveError(
				req,
				res,
				405,
				"Method not allowed. Only GET is supported.",
				corsHeaders
			);
		}

		const normalizedResourcePath = resourcePath.startsWith("/")
			? resourcePath
			: `/${resourcePath}`;
		const segments = normalizedResourcePath.substring(1).split("/");
		if (
			segments.length < 5 ||
			!segments[0] ||
			!segments[1] ||
			!segments[2] ||
			segments[3] !== "file" ||
			!segments[4]
		) {
			return serveError(
				req,
				res,
				400,
				"Invalid Open VSX asset path.",
				corsHeaders
			);
		}

		const searchParams = new url.URLSearchParams();
		const query = parsedUrl.query;
		for (const key in query) {
			const value = query[key];
			if (Array.isArray(value)) {
				for (const entry of value) {
					searchParams.append(key, entry);
				}
			} else if (typeof value === "string") {
				searchParams.append(key, value);
			} else if (typeof value !== "undefined" && value !== null) {
				searchParams.append(key, String(value));
			}
		}
		const queryString = searchParams.toString();
		const upstreamUrl = `${OPEN_VSX_API_BASE_URL}${normalizedResourcePath}${
			queryString ? `?${queryString}` : ""
		}`;

		const headers: IHeaders = {};
		const forwardHeader = (header: string) => {
			const value = req.headers[header];
			if (!value) {
				return;
			}
			headers[header] = Array.isArray(value) ? value[0] : value;
		};
		forwardHeader("accept");
		forwardHeader("accept-encoding");
		forwardHeader("if-none-match");
		forwardHeader("if-modified-since");

		let context;
		try {
			context = await this._requestService.request(
				{
					type: "GET",
					url: upstreamUrl,
					headers,
				},
				CancellationToken.None
			);
		} catch (error) {
			this._logService.error(error);
			return serveError(
				req,
				res,
				502,
				"Failed to fetch Open VSX resource.",
				corsHeaders
			);
		}

		const status = context.res.statusCode ?? 500;
		if (status !== 200 && status !== 304) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {
				/* Ignore */
			}
			return serveError(
				req,
				res,
				status,
				text || `Request failed with status ${status}`,
				corsHeaders
			);
		}

		const responseHeaders: Record<string, string | string[]> =
			Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (typeof value !== "undefined") {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader("Cache-Control");
		setResponseHeader("Content-Type");
		setResponseHeader("Content-Length");
		setResponseHeader("Etag");
		setResponseHeader("Last-Modified");
		setResponseHeader("Content-Encoding");
		for (const key in corsHeaders) {
			responseHeaders[key] = corsHeaders[key];
		}

		res.writeHead(status, responseHeaders);
		if (status === 304) {
			return void res.end();
		}

		const stream = context.stream;
		if (!stream) {
			return void res.end();
		}

		stream.on("error", (error) => {
			this._logService.error(error);
			if (!res.writableEnded) {
				res.end();
			}
		});
		stream.on("data", (chunk) => {
			try {
				res.write(chunk.buffer);
			} catch (error) {
				this._logService.error(error);
				stream.destroy();
			}
		});
		stream.on("end", () => {
			if (!res.writableEnded) {
				res.end();
			}
		});
	}

	private _buildCorsHeaders(
		requestHeaders: http.IncomingHttpHeaders
	): Record<string, string> {
		const corsHeaders: Record<string, string> = Object.create(null);
		corsHeaders["Access-Control-Allow-Origin"] = "*";
		corsHeaders["Access-Control-Allow-Methods"] = "GET, OPTIONS";
		const requestedHeaders = requestHeaders["access-control-request-headers"];

		// Base allowed headers for VS Code extension gallery requests
		const baseAllowedHeaders = [
			"authorization",
			"content-type",
			"x-requested-with",
			"x-market-client-id",
			"x-client-name",
			"x-client-version",
			"x-machine-id",
			"x-client-commit",
			"accept",
			"accept-encoding",
			"if-none-match",
			"if-modified-since",
		];

		// Combine base headers with any requested headers
		const allowedHeadersSet = new Set(baseAllowedHeaders);
		if (requestedHeaders) {
			const requestedArray = Array.isArray(requestedHeaders)
				? requestedHeaders
				: [requestedHeaders];
			for (const header of requestedArray) {
				// Split comma-separated headers and add each
				header.split(",").forEach((h: string) => {
					allowedHeadersSet.add(h.trim().toLowerCase());
				});
			}
		}

		corsHeaders["Access-Control-Allow-Headers"] =
			Array.from(allowedHeadersSet).join(", ");
		corsHeaders["Access-Control-Max-Age"] = "86400";
		return corsHeaders;
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery
	): Promise<void> {
		const getFirstHeader = (headerName: string) => {
			const val = req.headers[headerName];
			return Array.isArray(val) ? val[0] : val;
		};

		// Prefix routes with basePath for clients
		const basePath = getFirstHeader("x-forwarded-prefix") || this._basePath;

		const queryConnectionToken = parsedUrl.query[connectionTokenQueryName];
		if (typeof queryConnectionToken === "string") {
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders["Set-Cookie"] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: "lax",
					maxAge: 60 * 60 * 24 * 7 /* 1 week */,
				}
			);

			const newQuery = Object.create(null);
			for (const key in parsedUrl.query) {
				if (key !== connectionTokenQueryName) {
					newQuery[key] = parsedUrl.query[key];
				}
			}
			const newLocation = url.format({ pathname: basePath, query: newQuery });
			responseHeaders["Location"] = newLocation;

			res.writeHead(302, responseHeaders);
			return void res.end();
		}

		const replacePort = (host: string, port: string) => {
			const index = host?.indexOf(":");
			if (index !== -1) {
				host = host?.substring(0, index);
			}
			host += `:${port}`;
			return host;
		};

		const useTestResolver =
			!this._environmentService.isBuilt &&
			this._environmentService.args["use-test-resolver"];
		let remoteAuthority = useTestResolver
			? "test+test"
			: getFirstHeader("x-original-host") ||
			  getFirstHeader("x-forwarded-host") ||
			  req.headers.host;
		if (!remoteAuthority) {
			return serveError(req, res, 400, `Bad request.`);
		}
		const forwardedPort = getFirstHeader("x-forwarded-port");
		if (forwardedPort) {
			remoteAuthority = replacePort(remoteAuthority, forwardedPort);
		}

		function asJSON(value: unknown): string {
			return JSON.stringify(value).replace(/"/g, "&quot;");
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.args["enable-smoke-test-driver"]) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		if (this._logService.getLevel() === LogLevel.Trace) {
			[
				"x-original-host",
				"x-forwarded-host",
				"x-forwarded-port",
				"host",
			].forEach((header) => {
				const value = getFirstHeader(header);
				if (value) {
					this._logService.trace(`[WebClientServer] ${header}: ${value}`);
				}
			});
			this._logService.trace(
				`[WebClientServer] Request URL: ${req.url}, basePath: ${basePath}, remoteAuthority: ${remoteAuthority}`
			);
		}

		const staticRoute = posix.join(basePath, this._productPath, STATIC_PATH);
		const callbackRoute = posix.join(
			basePath,
			this._productPath,
			CALLBACK_PATH
		);
		const webExtensionRoute = posix.join(
			basePath,
			this._productPath,
			WEB_EXTENSION_PATH
		);

		const resolveWorkspaceURI = (defaultLocation?: string) =>
			defaultLocation &&
			URI.file(resolve(defaultLocation)).with({
				scheme: Schemas.vscodeRemote,
				authority: remoteAuthority,
			});

		const filePath = FileAccess.asFileUri(
			`vs/code/browser/workbench/workbench${
				this._environmentService.isBuilt ? "" : "-dev"
			}.html`
		).fsPath;
		const authSessionInfo =
			!this._environmentService.isBuilt &&
			this._environmentService.args["github-auth"]
				? {
						id: generateUuid(),
						providerId: "github",
						accessToken: this._environmentService.args["github-auth"],
						scopes: [["user:email"], ["repo"]],
				  }
				: undefined;

		const openVsxRoute = posix.join(
			basePath,
			this._productPath,
			OPEN_VSX_PROXY_PATH
		);
		const extensionsGalleryConfiguration =
			this._webExtensionResourceUrlTemplate &&
			this._productService.extensionsGallery
				? (() => {
						const gallery = { ...this._productService.extensionsGallery };
						const buildTemplate = (template: string | undefined) => {
							if (!template) {
								return undefined;
							}
							try {
								const parsed = URI.parse(template);
								// Check if this is an Open VSX URL (either open-vsx.org or any URL containing /openvsx/)
								const isOpenVSX =
									parsed.authority.includes("open-vsx.org") ||
									parsed.path.includes("/openvsx/") ||
									parsed.path.startsWith(`${OPEN_VSX_PROXY_PATH}/`);

								if (isOpenVSX) {
									// Extract the path pattern after /openvsx/ or /api/
									let pathSuffix = "";
									const openvsxIndex = parsed.path.indexOf("/openvsx/");
									const apiIndex = parsed.path.indexOf("/api/");

									if (openvsxIndex !== -1) {
										// Extract path after /openvsx/ (including the leading slash)
										pathSuffix = parsed.path.substring(
											openvsxIndex + OPEN_VSX_PROXY_PATH.length + 1
										);
										// Ensure it starts with /
										if (!pathSuffix.startsWith("/")) {
											pathSuffix = "/" + pathSuffix;
										}
									} else if (apiIndex !== -1) {
										// Extract path after /api/ (open-vsx.org format: /api/{publisher}/...)
										pathSuffix = parsed.path.substring(
											apiIndex + "/api".length
										);
									} else if (
										parsed.path.startsWith(`${OPEN_VSX_PROXY_PATH}/`)
									) {
										pathSuffix = parsed.path.substring(
											OPEN_VSX_PROXY_PATH.length
										);
									}

									// Always rewrite to use server's base address
									return URI.from({
										scheme: "http",
										authority: remoteAuthority,
										path: `${openVsxRoute}${pathSuffix}`,
									}).toString(true);
								}

								// For other URLs, use the web extension route
								return parsed
									.with({
										scheme: "http",
										authority: remoteAuthority,
										path: `${webExtensionRoute}/${parsed.authority}${parsed.path}`,
									})
									.toString(true);
							} catch (error) {
								this._logService.error(error);
								return undefined;
							}
						};
						const resourceTemplate = buildTemplate(gallery.resourceUrlTemplate);
						if (resourceTemplate) {
							gallery.resourceUrlTemplate = resourceTemplate;
						}
						if (gallery.extensionUrlTemplate) {
							const extensionTemplate = buildTemplate(
								gallery.extensionUrlTemplate
							);
							if (extensionTemplate) {
								gallery.extensionUrlTemplate = extensionTemplate;
							}
						}
						return gallery;
				  })()
				: undefined;

		const productConfiguration: Partial<Mutable<IProductConfiguration>> = {
			embedderIdentifier: "server-distro",
			extensionsGallery: extensionsGalleryConfiguration,
		};

		const proposedApi = this._environmentService.args["enable-proposed-api"];
		if (proposedApi?.length) {
			productConfiguration.extensionsEnabledWithApiProposalVersion ??= [];
			productConfiguration.extensionsEnabledWithApiProposalVersion.push(
				...proposedApi
			);
		}

		if (!this._environmentService.isBuilt) {
			try {
				const productOverrides = JSON.parse(
					(
						await promises.readFile(join(APP_ROOT, "product.overrides.json"))
					).toString()
				);
				Object.assign(productConfiguration, productOverrides);
			} catch (err) {
				/* Ignore Error */
			}
		}

		const workbenchWebConfiguration = {
			remoteAuthority,
			serverBasePath: basePath,
			_wrapWebWorkerExtHostInIframe,
			developmentOptions: {
				enableSmokeTestDriver: this._environmentService.args[
					"enable-smoke-test-driver"
				]
					? true
					: undefined,
				logLevel: this._logService.getLevel(),
			},
			settingsSyncOptions:
				!this._environmentService.isBuilt &&
				this._environmentService.args["enable-sync"]
					? { enabled: true }
					: undefined,
			enableWorkspaceTrust:
				!this._environmentService.args["disable-workspace-trust"],
			folderUri: resolveWorkspaceURI(
				this._environmentService.args["default-folder"]
			),
			workspaceUri: resolveWorkspaceURI(
				this._environmentService.args["default-workspace"]
			),
			productConfiguration,
			callbackRoute: callbackRoute,
		};

		const cookies = cookie.parse(req.headers.cookie || "");
		const locale =
			cookies["vscode.nls.locale"] ||
			req.headers["accept-language"]?.split(",")[0]?.toLowerCase() ||
			"en";
		let WORKBENCH_NLS_BASE_URL: string | undefined;
		let WORKBENCH_NLS_URL: string;
		if (!locale.startsWith("en") && this._productService.nlsCoreBaseUrl) {
			WORKBENCH_NLS_BASE_URL = this._productService.nlsCoreBaseUrl;
			WORKBENCH_NLS_URL = `${WORKBENCH_NLS_BASE_URL}${this._productService.commit}/${this._productService.version}/${locale}/nls.messages.js`;
		} else {
			WORKBENCH_NLS_URL = ""; // fallback will apply
		}

		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: authSessionInfo ? asJSON(authSessionInfo) : "",
			WORKBENCH_WEB_BASE_URL: staticRoute,
			WORKBENCH_NLS_URL,
			WORKBENCH_NLS_FALLBACK_URL: `${staticRoute}/out/nls.messages.js`,
		};

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: The server needs to send along all CSS modules so that the client can construct the
		// DEV: import-map.
		// DEV ---------------------------------------------------------------------------------------
		if (this._cssDevService.isEnabled) {
			const cssModules = await this._cssDevService.getCssModules();
			values["WORKBENCH_DEV_CSS_MODULES"] = JSON.stringify(cssModules);
		}

		if (useTestResolver) {
			const bundledExtensions: {
				extensionPath: string;
				packageJSON: IExtensionManifest;
			}[] = [];
			for (const extensionPath of [
				"vscode-test-resolver",
				"github-authentication",
			]) {
				const packageJSON = JSON.parse(
					(
						await promises.readFile(
							FileAccess.asFileUri(
								`${builtinExtensionsPath}/${extensionPath}/package.json`
							).fsPath
						)
					).toString()
				);
				bundledExtensions.push({ extensionPath, packageJSON });
			}
			values["WORKBENCH_BUILTIN_EXTENSIONS"] = asJSON(bundledExtensions);
		}

		let data;
		try {
			const workbenchTemplate = (await promises.readFile(filePath)).toString();
			data = workbenchTemplate.replace(
				/\{\{([^}]+)\}\}/g,
				(_, key) => values[key] ?? "undefined"
			);
		} catch (e) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			return void res.end("Not found");
		}

		const webWorkerExtensionHostIframeScriptSHA =
			"sha256-2Q+j4hfT09+1+imS46J2YlkCtHWQt0/BE79PXjJ0ZJ8=";

		const cspDirectives = [
			"default-src 'self';",
			"img-src 'self' https: data: blob:;",
			"media-src 'self';",
			`script-src 'self' 'unsafe-eval' ${
				WORKBENCH_NLS_BASE_URL ?? ""
			} blob: 'nonce-1nline-m4p' ${this._getScriptCspHashes(data).join(
				" "
			)} '${webWorkerExtensionHostIframeScriptSHA}' 'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ${
				useTestResolver ? "" : `http://${remoteAuthority}`
			};`, // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			"child-src 'self';",
			`frame-src 'self' https://*.vscode-cdn.net data:;`,
			"worker-src 'self' data: blob:;",
			"style-src 'self' 'unsafe-inline';",
			"connect-src 'self' ws: wss: https:;",
			"font-src 'self' blob:;",
			"manifest-src 'self';",
		].join(" ");

		const headers: http.OutgoingHttpHeaders = {
			"Content-Type": "text/html",
			"Content-Security-Policy": cspDirectives,
		};
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			headers["Set-Cookie"] = cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: "lax",
					maxAge: 60 * 60 * 24 * 7 /* 1 week */,
				}
			);
		}

		res.writeHead(200, headers);
		return void res.end(data);
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script>([\s\S]+?)<\/script>/gim;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content))) {
			const hasher = crypto.createHash("sha256");
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[1].replace(/\r\n/g, "\n");
			const hash = hasher
				.update(Buffer.from(script))
				.digest()
				.toString("base64");

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri(
			"vs/code/browser/workbench/callback.html"
		).fsPath;
		const data = (await promises.readFile(filePath)).toString();
		const cspDirectives = [
			"default-src 'self';",
			"img-src 'self' https: data: blob:;",
			"media-src 'none';",
			`script-src 'self' ${this._getScriptCspHashes(data).join(" ")};`,
			"style-src 'self' 'unsafe-inline';",
			"font-src 'self' blob:;",
		].join(" ");

		res.writeHead(200, {
			"Content-Type": "text/html",
			"Content-Security-Policy": cspDirectives,
		});
		return void res.end(data);
	}
}
