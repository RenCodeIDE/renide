/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { env } from "../../../base/common/process.js";
import { IProductService } from "../../product/common/productService.js";
import {
	ExtensionGalleryResourceType,
	Flag,
	IExtensionGalleryManifest,
	IExtensionGalleryManifestService,
	ExtensionGalleryManifestStatus,
} from "./extensionGalleryManifest.js";
import { FilterType, SortBy } from "./extensionManagement.js";

type ExtensionGalleryConfig = {
	readonly serviceUrl: string;
	readonly itemUrl: string;
	readonly publisherUrl: string;
	readonly resourceUrlTemplate: string;
	readonly extensionUrlTemplate: string;
	readonly controlUrl: string;
	readonly nlsBaseUrl: string;
};

export class ExtensionGalleryManifestService
	extends Disposable
	implements IExtensionGalleryManifestService
{
	readonly _serviceBrand: undefined;
	readonly onDidChangeExtensionGalleryManifest = Event.None;
	readonly onDidChangeExtensionGalleryManifestStatus = Event.None;

	get extensionGalleryManifestStatus(): ExtensionGalleryManifestStatus {
		return !!this.productService.extensionsGallery?.serviceUrl
			? ExtensionGalleryManifestStatus.Available
			: ExtensionGalleryManifestStatus.Unavailable;
	}

	/**
	 * Helper function to fix duplicate /api in paths and prevent double slashes
	 * If serverAddress ends with /api and path starts with /api, remove duplicate
	 * Also ensures no double slashes when concatenating
	 */
	private fixDuplicateApi(serverAddress: string, path: string): string {
		// First, handle duplicate /api case
		if (serverAddress.endsWith("/api") && path.startsWith("/api")) {
			// Remove the leading /api from path to avoid duplicate
			const fixedPath = path.substring(4); // Remove "/api"
			// If the result is empty, return empty string (not "/") since serverAddress already ends with /api
			if (!fixedPath) {
				return "";
			}
			// Remove leading "/" if present to avoid double slash when concatenating
			// serverAddress ends with /api (no trailing slash), so path shouldn't start with /
			return fixedPath.startsWith("/") ? fixedPath.substring(1) : fixedPath;
		}
		// Handle case where serverAddress ends with /api (no trailing slash) and path starts with /
		// This prevents double slashes: /api + /extensionquery = /api//extensionquery (wrong!)
		// Should be: /api + extensionquery = /api/extensionquery (correct)
		if (
			serverAddress.endsWith("/api") &&
			!serverAddress.endsWith("/api/") &&
			path.startsWith("/")
		) {
			// Remove leading "/" to avoid double slash
			return path === "/" ? "" : path.substring(1);
		}
		// Handle case where serverAddress ends with /api/ (with trailing slash) and path starts with /
		if (serverAddress.endsWith("/api/") && path.startsWith("/")) {
			// Remove leading "/" since serverAddress already has trailing slash
			return path.substring(1);
		}
		return path;
	}

	constructor(
		@IProductService protected readonly productService: IProductService
	) {
		super();
	}

	async getExtensionGalleryManifest(): Promise<IExtensionGalleryManifest | null> {
		const extensionsGallery = this.productService.extensionsGallery as
			| ExtensionGalleryConfig
			| undefined;
		if (!extensionsGallery?.serviceUrl) {
			return null;
		}

		// Prefer SERVER_ADDRESS from environment if available, otherwise use product.json
		let serviceUrl = extensionsGallery.serviceUrl;
		let itemUrl = extensionsGallery.itemUrl;
		let publisherUrl = extensionsGallery.publisherUrl;

		const productEnvVars = this.productService.environmentVariables;
		const serverAddress =
			env["SERVER_ADDRESS"] || productEnvVars?.["SERVER_ADDRESS"];

		if (serverAddress) {
			let normalizedServerAddress = serverAddress.trim();
			if (
				!normalizedServerAddress.startsWith("http://") &&
				!normalizedServerAddress.startsWith("https://")
			) {
				normalizedServerAddress = `https://${normalizedServerAddress}`;
			}
			normalizedServerAddress = normalizedServerAddress.replace(/\/+$/, "");

			// Replace base URLs with server address
			// Map serviceUrl paths to /api/ on the server (e.g., /vscode/gallery/extensionquery -> /api/extensionquery)
			if (serviceUrl) {
				const serviceUrlMatch = serviceUrl.match(/https?:\/\/[^\/]+(\/.*)/);
				if (serviceUrlMatch) {
					const pathPart = serviceUrlMatch[1];
					// Replace /vscode/gallery with /api for API endpoints
					// This maps: /vscode/gallery/extensionquery -> /api/extensionquery
					//            /vscode/gallery/{publisher}/{name}/latest -> /api/{publisher}/{name}/latest
					let normalizedPath = pathPart.replace(/^\/vscode\/gallery/, "/api");
					// Fix duplicate /api if serverAddress ends with /api and normalizedPath starts with /api
					normalizedPath = this.fixDuplicateApi(
						normalizedServerAddress,
						normalizedPath
					);
					serviceUrl = `${normalizedServerAddress}${normalizedPath}`;
				}
			}

			if (itemUrl) {
				const itemUrlMatch = itemUrl.match(/https?:\/\/[^\/]+(\/.*)/);
				if (itemUrlMatch) {
					const pathPart = itemUrlMatch[1];
					// Map /vscode/item to /api/item
					let normalizedPath = pathPart.replace(/^\/vscode\/item/, "/api/item");
					// Fix duplicate /api if serverAddress ends with /api and normalizedPath starts with /api
					normalizedPath = this.fixDuplicateApi(
						normalizedServerAddress,
						normalizedPath
					);
					itemUrl = `${normalizedServerAddress}${normalizedPath}`;
				}
			}

			if (publisherUrl) {
				const publisherUrlMatch = publisherUrl.match(/https?:\/\/[^\/]+(\/.*)/);
				if (publisherUrlMatch) {
					const pathPart = publisherUrlMatch[1];
					// Map /publishers to /api/publishers
					let normalizedPath = pathPart.replace(
						/^\/publishers/,
						"/api/publishers"
					);
					// Fix duplicate /api if serverAddress ends with /api and normalizedPath starts with /api
					normalizedPath = this.fixDuplicateApi(
						normalizedServerAddress,
						normalizedPath
					);
					publisherUrl = `${normalizedServerAddress}${normalizedPath}`;
				}
			}
		}

		const resources = [
			{
				id: `${serviceUrl}/extensionquery?api-version=3.0-preview.1`,
				type: ExtensionGalleryResourceType.ExtensionQueryService,
			},
			{
				id: `${serviceUrl}/{publisher}/{name}/latest`,
				type: ExtensionGalleryResourceType.ExtensionLatestVersionUri,
			},
			{
				id: `${serviceUrl}/publishers/{publisher}/extensions/{name}/{version}/stats?statType={statTypeName}`,
				type: ExtensionGalleryResourceType.ExtensionStatisticsUri,
			},
			{
				id: `${serviceUrl}/itemName/{publisher}.{name}/version/{version}/statType/{statTypeValue}/vscodewebextension`,
				type: ExtensionGalleryResourceType.WebExtensionStatisticsUri,
			},
		];

		if (publisherUrl) {
			resources.push({
				id: `${publisherUrl}/{publisher}`,
				type: ExtensionGalleryResourceType.PublisherViewUri,
			});
		}

		if (itemUrl) {
			resources.push({
				id: `${itemUrl}?itemName={publisher}.{name}`,
				type: ExtensionGalleryResourceType.ExtensionDetailsViewUri,
			});
			resources.push({
				id: `${itemUrl}?itemName={publisher}.{name}&ssr=false#review-details`,
				type: ExtensionGalleryResourceType.ExtensionRatingViewUri,
			});
		}

		if (extensionsGallery.resourceUrlTemplate) {
			resources.push({
				id: extensionsGallery.resourceUrlTemplate,
				type: ExtensionGalleryResourceType.ExtensionResourceUri,
			});
		}

		const filtering = [
			{
				name: FilterType.Tag,
				value: 1,
			},
			{
				name: FilterType.ExtensionId,
				value: 4,
			},
			{
				name: FilterType.Category,
				value: 5,
			},
			{
				name: FilterType.ExtensionName,
				value: 7,
			},
			{
				name: FilterType.Target,
				value: 8,
			},
			{
				name: FilterType.Featured,
				value: 9,
			},
			{
				name: FilterType.SearchText,
				value: 10,
			},
			{
				name: FilterType.ExcludeWithFlags,
				value: 12,
			},
		];

		const sorting = [
			{
				name: SortBy.NoneOrRelevance,
				value: 0,
			},
			{
				name: SortBy.LastUpdatedDate,
				value: 1,
			},
			{
				name: SortBy.Title,
				value: 2,
			},
			{
				name: SortBy.PublisherName,
				value: 3,
			},
			{
				name: SortBy.InstallCount,
				value: 4,
			},
			{
				name: SortBy.AverageRating,
				value: 6,
			},
			{
				name: SortBy.PublishedDate,
				value: 10,
			},
			{
				name: SortBy.WeightedRating,
				value: 12,
			},
		];

		const flags = [
			{
				name: Flag.None,
				value: 0x0,
			},
			{
				name: Flag.IncludeVersions,
				value: 0x1,
			},
			{
				name: Flag.IncludeFiles,
				value: 0x2,
			},
			{
				name: Flag.IncludeCategoryAndTags,
				value: 0x4,
			},
			{
				name: Flag.IncludeSharedAccounts,
				value: 0x8,
			},
			{
				name: Flag.IncludeVersionProperties,
				value: 0x10,
			},
			{
				name: Flag.ExcludeNonValidated,
				value: 0x20,
			},
			{
				name: Flag.IncludeInstallationTargets,
				value: 0x40,
			},
			{
				name: Flag.IncludeAssetUri,
				value: 0x80,
			},
			{
				name: Flag.IncludeStatistics,
				value: 0x100,
			},
			{
				name: Flag.IncludeLatestVersionOnly,
				value: 0x200,
			},
			{
				name: Flag.Unpublished,
				value: 0x1000,
			},
			{
				name: Flag.IncludeNameConflictInfo,
				value: 0x8000,
			},
			{
				name: Flag.IncludeLatestPrereleaseAndStableVersionOnly,
				value: 0x10000,
			},
		];

		return {
			version: "",
			resources,
			capabilities: {
				extensionQuery: {
					filtering,
					sorting,
					flags,
				},
				signing: {
					allPublicRepositorySigned: true,
				},
			},
		};
	}
}
