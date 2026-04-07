---
type: ADR
status: Accepted
---

# ADR-007: Server-Side Request Proxy

**Date:** 2026-03  
**Status:** Accepted

## Context

The API Client tab lets developers send HTTP requests to arbitrary URLs. The browser's fetch API enforces CORS (Cross-Origin Resource Sharing) — requests from `localhost:3333` to a different origin are blocked unless the target API sends permissive CORS headers. Most internal APIs, staging environments, and third-party APIs don't.

The question: how should the API client handle CORS?

## Decision

**Route all API client requests through the HIVE server** via `POST /api/proxy`. The browser sends the request details (method, URL, headers, body) to the HIVE server, which makes the actual HTTP request from Node.js (where CORS doesn't apply) and returns the response.

```
Browser → POST /api/proxy { method, url, headers, body }
  → HIVE server (Node.js) → fetch(url) → target API
  → HIVE server → { status, headers, body, time, size }
Browser ← response
```

When you see `[proxy] GET http://localhost:4000/api/scenarios (timeout=600000, stream=true)` in the server console, that's the proxy logging the outbound request it's about to make on behalf of the browser.

## Reasoning

**CORS is a browser-only restriction.** Server-side HTTP requests don't have CORS. By proxying through Node.js, we bypass CORS entirely without requiring target APIs to add permissive headers. This is the same approach Postman uses (Postman is an Electron app making requests from Node.js, not from a browser sandbox).

**Centralized logging.** Every request flows through one endpoint, so we get a complete audit trail in the server console. Request method, URL, timeout, streaming flag, response status, and timing are all logged in one place without browser devtools.

**Server-side timeout enforcement.** The proxy uses `AbortSignal.timeout()` to enforce configurable timeouts (30 seconds to 10 minutes). Browser-side timeouts are less reliable and can't be enforced for streaming responses.

**Streaming support.** For NDJSON responses (`application/x-ndjson`), the proxy converts the response into Server-Sent Events (SSE) and streams them to the browser progressively. The browser renders each line as it arrives. This is impossible with a direct browser fetch that returns a single response body.

**File upload handling.** Multipart form-data with file uploads goes through a dedicated `POST /api/proxy/upload` endpoint. The server reconstructs the FormData on the server side, which is necessary because browser-generated multipart boundaries can't be forwarded through JSON.

## Alternatives Considered

**CORS proxy as a separate service** — Run a generic CORS proxy (like `cors-anywhere`) alongside HIVE. Adds another service to manage, configure, and monitor. HIVE already has an Express server — adding a route is simpler.

**Browser extension to disable CORS** — Works but requires each developer to install and configure an extension. Not portable across browsers. Security risk if left enabled.

**Direct fetch with CORS headers on target APIs** — Requires modifying every API the developer wants to test. Not feasible for third-party APIs or production environments.

**Electron app instead of browser** — Would bypass CORS natively (like Postman). But HIVE is a web app by design — it should work in any browser, and Electron adds significant packaging and distribution complexity.

## Consequences

**Positive:**
- Works with any API, any origin, no configuration
- Centralized request logging and timeout enforcement
- Enables NDJSON streaming that browsers can't do natively
- File uploads work seamlessly through the proxy
- No browser extensions or target API modifications required

**Negative:**
- Adds latency — requests hop through the HIVE server (negligible for local development)
- The HIVE server sees all request/response data, including credentials in headers
- Server must be running — can't use the API client if HIVE is down
- Response size is limited by server memory (large binary responses could be problematic)
