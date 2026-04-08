---
type: Feature Guide
status: active
---

# API Client

The API tab is a built-in HTTP client — like Postman, but inside your dashboard. Build requests, organize them into collections, switch environments, import OpenAPI specs, and stream large responses. Everything runs through a server-side proxy so you never hit CORS walls.

## Why a Proxy?

Every request you send goes through `POST /api/proxy` on the HIVE server instead of directly from the browser. Two reasons:

1. **CORS** — Browsers block cross-origin requests unless the target API sends the right headers. The proxy runs server-side, so CORS doesn't apply.
2. **Logging** — All requests pass through one place, so the console can show timing, status, and payload without browser devtools.

When you see `[proxy] GET http://localhost:4000/api/scenarios (timeout=600000, stream=true)` in the server console, that's the proxy forwarding your request. The `timeout` is how long it will wait before aborting (up to 10 minutes), and `stream=true` means the response will be streamed back progressively if the server returns NDJSON.

## Making Requests

The request builder sits at the top of the API tab:

- **Method** — GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
- **URL** — Supports `{{variable}}` placeholders resolved from environments and collections
- **Params** — Key/value pairs appended as query string. Edits here sync with the URL and vice versa
- **Headers** — Custom headers with enable/disable toggles per row
- **Body** — JSON, form-data (with file uploads), x-www-form-urlencoded, or raw text
- **Auth** — Bearer token, Basic auth, or inherit from parent collection/folder

Hit **Send** or press the send button to execute. The response panel shows body, headers, test results, and timing.

### Path Variables

If your URL contains `:paramName`, the client extracts it automatically and shows an editable field. For example, `/users/:userId/posts` creates a `userId` field you can fill in.

### Request Timeout

Configurable from 30 seconds to 10 minutes. The server enforces this with `AbortSignal.timeout()` — if the target API doesn't respond in time, the proxy aborts and returns an error.

## Tabs

You can have multiple requests open simultaneously. Each tab preserves its own method, URL, params, headers, body, auth, scripts, and last response. Tabs persist across page reloads via localStorage.

Drag tabs to reorder them. Right-click for close options.

## Streaming (NDJSON)

When the target API returns `application/x-ndjson` (newline-delimited JSON) and streaming is enabled, the proxy converts the response into Server-Sent Events. The client renders each line as it arrives instead of waiting for the full response. This is useful for large dataset endpoints or long-running operations.

The response panel updates progressively — you'll see rows appear one by one.

## Collections

Collections are hierarchical request libraries saved to disk at `data/api/collections.json`.

### Structure

```
Collection
  ├── Auth (Bearer / Basic / None)
  ├── Variables (key/value pairs)
  ├── Pre-Request Script
  ├── Test Script
  ├── Folders
  │   ├── Auth (can inherit from collection)
  │   ├── Variables
  │   ├── Requests
  │   └── Sub-folders
  └── Requests
```

### Auth Inheritance

Set auth at the collection level and every request inherits it unless overridden. Folders can also define auth — requests inherit from their nearest parent that has auth configured. Set a request to "Inherit" to use its parent's auth.

### Collection Variables

Variables defined at the collection or folder level are available to all child requests. Use `{{variableName}}` syntax in URLs, headers, and bodies.

### Importing

- **OpenAPI / Swagger** — Import a spec URL or paste JSON. Endpoints are organized by tags into folders. Path parameters become `{{variables}}`, and example request bodies are generated from schemas.
- **Postman v2.1** — Full fidelity import. Preserves folder hierarchy, auth configuration, pre-request/test scripts, and all body modes.

## Environments

Environments are sets of variables for different deployment targets — Local, Staging, Production, etc. Stored at `data/api/environments.json`.

```json
[
  {
    "name": "Local",
    "variables": [
      { "key": "apiUrl", "value": "http://localhost:3000", "enabled": true },
      { "key": "api_key", "value": "dev-key-123", "enabled": true }
    ]
  }
]
```

Select the active environment from the dropdown in the request bar. Environment variables take precedence over collection variables when names collide.

### Variable Resolution Order

When the client encounters `{{varName}}`, it resolves in this order (highest priority first):

1. Request-scoped variables (set by pre-scripts at runtime)
2. Environment variables (from the active environment)
3. Folder variables (from the request's parent folder)
4. Collection variables (from the request's parent collection)

## Pre-Request & Test Scripts

Scripts run JavaScript before sending a request (pre-request) or after receiving a response (test). They execute on the server via `POST /api/script/run` in a sandboxed context.

### Execution Order

**Pre-request:** Collection → Folders (outer to inner) → Request
**Test:** Request → Folders (inner to outer) → Collection

### Available API

```javascript
// Variables
pm.variables.get('key')              // Request-scoped (temporary)
pm.variables.set('key', 'value')
pm.collectionVariables.get('key')    // Persisted to collection
pm.collectionVariables.set('key', 'value')
pm.environment.get('key')            // Persisted to environment
pm.environment.set('key', 'value')

// Request (pre-script only)
pm.request.url                       // Read/write the URL
pm.request.headers                   // Read/write headers
pm.request.body                      // Read/write body

// Response (test script only)
pm.response.code                     // Status code (200, 404, etc.)
pm.response.json()                   // Parse body as JSON
pm.response.text()                   // Body as string
pm.response.headers                  // Response headers
pm.response.responseTime             // Milliseconds

// Assertions
pm.test('Status is 200', () => {
  pm.expect(pm.response.code).to.equal(200);
});
pm.expect(value).to.equal(expected)
pm.expect(value).to.eql(expected)    // Deep equality
pm.expect(value).to.be.above(n)

// Utilities
console.log('debug output')          // Captured in console tab
_.get(obj, 'nested.path', default)   // Lodash-like accessor
```

### Example: Auth Token Flow

```javascript
// Pre-request script on collection:
// Automatically refresh token if expired
const token = pm.environment.get('authToken');
if (!token) {
  console.log('No token set — request will fail with 401');
}

// Test script on login request:
const body = pm.response.json();
pm.environment.set('authToken', body.token);
pm.test('Login returns token', () => {
  pm.expect(body.token).to.not.equal(undefined);
});
```

## History

The last 200 requests are saved to `data/api/private/history.json`. The Console tab in the response panel shows recent requests with expandable details. Click **Load** to restore a historical request into the builder, or **cURL** to copy the equivalent curl command.

## File Uploads

Select **form-data** as the body type to upload files. The client sends uploads through a dedicated `POST /api/proxy/upload` endpoint that reconstructs the multipart form on the server side. Files up to 50MB are supported.

## Data Flow

```
You type URL + method
  → Pre-scripts run (Collection → Folder → Request)
  → {{variables}} resolved from all scopes
  → POST /api/proxy (server-side)
     → Server forwards to target URL
     → NDJSON? Stream via SSE : Buffer full response
     → Return status, headers, body, timing
  → Test scripts run (Request → Folder → Collection)
  → Response rendered (body, headers, test results)
  → Saved to history
```
