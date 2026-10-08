# Banktwo

Banktwo is an independent read-only source connector. It owns the upstream
vehicle catalog, article search, resource validation, retry, cache, and rate
limits. AutoData calls its provider-neutral Source Connector v1 API over HTTP;
Banktwo does not need AutoData code, database access, or Bankone routes.

The intended direct service origin is `https://banktwo.cars.tk`. A deployment
serves `/v1` at the origin root, plus `/healthz` and `/readyz`; it does not
require `MOUNT_PATH=/banktwo` or a shared-path gateway. Domain attachment and
production traffic changes are separate deployment operations.

## Run

Node.js 22 or newer is required.

```sh
npm ci
cp .env.example .env
npm run dev
```

The local listener defaults to `127.0.0.1:3001`. Set `HOST=0.0.0.0` in a
container. `UPSTREAM_BASE_URL` is the fixed HTTPS origin for the Banktwo source
and defaults to `https://autoapitwo.vercel.app`; caller input cannot change it.
The Dockerfile builds and runs this repository alone.

## Source Connector v1

- `GET /v1/capabilities`
- `GET /v1/catalog/{years|makes|models|configurations}` with scoped selector
  query parameters and continuation cursors
- `POST /v1/vehicle-resolutions`
- `GET /v1/vehicles/{opaqueRef}/articles`
- `POST /v1/vehicles/{opaqueRef}/article-search`
- `GET /v1/resources/{opaqueRef}`

The v1 API returns `provider: banktwo`, a request ID, source revision, fetch
time, source locator, explicit page completion, and opaque references. It
returns all matching vehicle candidates without silently selecting one.
Resources include SHA-256 and either original source text or base64 binary
bytes. Provider paths stay inside Banktwo and are never used to choose an
arbitrary upstream origin.

The previous `/v1/fleet/*` and `/v1/content/*` endpoints remain temporarily for
existing callers during cutover. New integrations should use the Source
Connector operations. OpenAPI JSON is at `/openapi.json`, with Swagger UI at
`/docs`.

## Operational limits

The transport uses GET only, a fixed HTTPS origin, no redirects, a bounded
response size and timeout, bounded concurrency and cache, and a client rate
limit. A partial article-index traversal fails rather than returning an
apparently complete list. All v1 errors use stable error codes and omit
upstream response bodies.

## Verify

```sh
npm ci
npm test
npm run lint
npm run build
```
