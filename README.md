# AutoDBtwo Read-only Connector API

AutoDBtwo is a small, standalone HTTP adapter for AutoAPItwo. It exposes a
fixed read-only API for vehicle catalog, article, and image resources, while
keeping provider transport outside of consuming applications. It does not
normalize or persist AutoData records and it is not a general-purpose proxy.

Deploy it only on a trusted private service network or behind an authenticated
gateway. Do not expose the connector directly to the public internet. The
caller should be a trusted AutoData service.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

The service binds to `127.0.0.1:3001` by default. Set `HOST=0.0.0.0` inside a
container. The upstream defaults to `https://autoapitwo.vercel.app` and can be
overridden with `UPSTREAM_BASE_URL`, which must be an HTTPS origin.

## API

- `GET /v1/fleet/years`
- `GET /v1/fleet/years/{year}/makes`
- `GET /v1/fleet/years/{year}/makes/{make}/models`
- `GET /v1/fleet/years/{year}/makes/{make}/models/{model}/engines`
- `GET /v1/fleet/carids/{carId}`
- `GET /v1/fleet/search/{query}`
- `GET /v1/fleet/resource?path={encodedAllowlistedFleetPath}` for the bounded
  fleet traversal path used by the ingestion worker.
- `GET /v1/content/carids/{carId}/search/{term}`
- `GET /v1/content/carids/{carId}/resource?path={encodedProviderPath}` for a
  resource path under that same vehicle's AutoAPItwo content namespace; add
  `binary=true` for image/binary resources.
- `GET /healthz`, `GET /readyz`

OpenAPI JSON is at `/openapi.json`, with Swagger UI at `/docs`. Successful
upstream responses include `X-Source-Uri` and `X-Content-SHA256` for provenance.
Errors use a sanitized JSON envelope and never include upstream response bodies.

## Limits and safety

- HTTPS-only configured upstream origin; redirects are rejected.
- Only fixed fleet routes and paths scoped under the requested vehicle's
  content resource are accepted.
- GET-only methods, bounded timeout and response size, bounded in-memory cache,
  request coalescing, and per-client rate limits.
- Caller input cannot select an upstream origin or cross vehicle content IDs.

## Verify

```sh
npm test
npm run build
npm run lint
```
