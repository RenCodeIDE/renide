# Marketplace Server Requirements

This document outlines all the endpoints and resources the server needs to proxy/fetch for the marketplace to work correctly.

## API Endpoints (POST/GET)

### 1. Extension Query API
- **Endpoint**: `/api/extensionquery?api-version=3.0-preview.1`
- **Method**: POST (with JSON body)
- **Purpose**: Search and query extensions from the marketplace
- **Headers Required**:
  - `Content-Type: application/json`
  - `Accept: application/json;api-version=3.0-preview.1`
  - `X-Market-Client-Id`
  - `VSCode-SessionId`
  - `User-Agent`
  - `X-Market-User-Id` (optional)

### 2. Latest Version API
- **Endpoint**: `/api/{publisher}/{name}/latest`
- **Method**: GET
- **Purpose**: Get the latest version information for an extension
- **Example**: `/api/vscode/vscode-typescript-next/latest`

### 3. Extension Statistics API
- **Endpoint**: `/api/publishers/{publisher}/extensions/{name}/{version}/stats?statType={statTypeName}`
- **Method**: POST
- **Purpose**: Report/view extension statistics (installs, ratings)
- **Example**: `/api/publishers/vscode/extensions/typescript/1.0.0/stats?statType=install`

### 4. Web Extension Statistics API
- **Endpoint**: `/api/itemName/{publisher}.{name}/version/{version}/statType/{statTypeValue}/vscodewebextension`
- **Method**: POST
- **Purpose**: Statistics for web extensions
- **Example**: `/api/itemName/vscode.typescript/version/1.0.0/statType/1/vscodewebextension`

## Extension Assets (GET requests)

All assets are fetched from paths like: `/api/{publisher}/{name}/{version}/file/{assetType}`

### Asset Types Required:

1. **VSIX Package** (Extension Download)
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.VSIXPackage`
   - Query params: `?redirect=true&targetPlatform={platform}`
   - Purpose: Download the actual extension package
   - **Critical**: Required for installing extensions

2. **Manifest** (package.json)
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Code.Manifest`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension metadata and configuration
   - **Critical**: Required to validate extension compatibility

3. **Details/README**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.Content.Details`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension description and documentation
   - Files: `extension/README.md`, `README.md`, etc.

4. **Changelog**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.Content.Changelog`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension version history
   - Files: `extension/CHANGELOG.md`, `CHANGELOG.md`, etc.

5. **License**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.Content.License`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension license text
   - Files: `extension/LICENSE`, `LICENSE.md`, etc.

6. **Icon**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.Icons.Default`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension icon image
   - Files: `extension/icon.png`, `icon.png`, etc.
   - Formats: PNG, JPG, SVG, ICO

7. **Signature**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.VsixSignature`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Extension package signature for verification
   - **Important**: Required for secure extension installation

8. **Translations**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Code.Translation.{language}`
   - Query params: `?targetPlatform={platform}`
   - Purpose: Localized extension strings
   - Example: `Microsoft.VisualStudio.Code.Translation.en`

9. **Repository Link**
   - Path: `/api/{publisher}/{name}/{version}/file/Microsoft.VisualStudio.Services.Links.Source`
   - Purpose: Source code repository URL

## File Path Patterns

The server needs to handle these file path patterns:

### Standard Asset Path:
```
/api/{publisher}/{name}/{version}/file/{assetType}?targetPlatform={platform}
```

### Example:
```
/api/vscode/typescript/1.0.0/file/Microsoft.VisualStudio.Services.VSIXPackage?targetPlatform=web
```

## Required Headers to Forward

### Request Headers (Client → Server → Upstream):
- `Accept` - Content type acceptance
- `Accept-Encoding` - Compression support (gzip)
- `Content-Type` - Request body type (for POST)
- `Content-Length` - Request body size (for POST)
- `X-Market-Client-Id` - Marketplace client identifier
- `VSCode-SessionId` - Session tracking
- `User-Agent` - Client identification
- `X-Market-User-Id` - User identification (optional)
- `If-None-Match` - ETag caching (for GET)
- `If-Modified-Since` - Date caching (for GET)

### Response Headers (Upstream → Server → Client):
- `Content-Type` - Response content type
- `Content-Length` - Response size
- `Cache-Control` - Caching instructions
- `ETag` - Entity tag for caching
- `Last-Modified` - Modification timestamp
- `Content-Encoding` - Compression (gzip)
- CORS headers (Access-Control-Allow-Origin, etc.)

## CORS Support

The server must handle CORS preflight requests:
- **OPTIONS** requests must return appropriate CORS headers
- Required CORS headers:
  - `Access-Control-Allow-Origin`
  - `Access-Control-Allow-Methods`
  - `Access-Control-Allow-Headers`
  - `Access-Control-Max-Age`

## Query Parameters

### Common Query Parameters:
- `api-version` - API version (e.g., `3.0-preview.1`)
- `targetPlatform` - Target platform (e.g., `web`, `darwin-arm64`, `win32-x64`)
- `redirect` - Redirect flag (for downloads)
- `statType` - Statistics type (for stats endpoints)
- `statTypeValue` - Statistics value (for web stats)

## URL Structure Mapping

### What the client sees:
```
http://remoteAuthority/openvsx/api/extensionquery
```

### What the server proxies to (if SERVER_ADDRESS is set):
```
{SERVER_ADDRESS}/openvsx/api/extensionquery
```

### What the server proxies to (fallback):
```
https://open-vsx.org/api/extensionquery
```

## Summary Checklist

Your server at `${SERVER_ADDRESS}/openvsx/api` must handle:

✅ **POST** `/api/extensionquery` - Extension queries
✅ **GET** `/api/{publisher}/{name}/latest` - Latest versions
✅ **POST** `/api/publishers/{publisher}/extensions/{name}/{version}/stats` - Statistics
✅ **POST** `/api/itemName/{publisher}.{name}/version/{version}/statType/{value}/vscodewebextension` - Web stats
✅ **GET** `/api/{publisher}/{name}/{version}/file/{assetType}` - All asset types:
   - VSIXPackage (downloads)
   - Manifest (package.json)
   - Details (README)
   - Changelog
   - License
   - Icon
   - Signature
   - Translations
   - Repository links

✅ **CORS** - Proper CORS headers for all requests
✅ **Headers** - Forward all marketplace headers correctly
✅ **Query Params** - Support `targetPlatform`, `api-version`, etc.
✅ **Methods** - Support GET, POST, OPTIONS

## Testing

To verify everything works, test:
1. Search extensions in marketplace
2. View extension details
3. Download extension (VSIX)
4. View extension README
5. View extension changelog
6. View extension icon
7. Install extension

All of these should work through your `${SERVER_ADDRESS}/openvsx/api` proxy endpoint.

