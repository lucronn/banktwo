import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, createHmac } from "node:crypto";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const config: Config = {
  host: "127.0.0.1", port: 3001, upstreamBaseUrl: "https://source.test",
  requestTimeoutMs: 500, retryAttempts: 1, retryDelayMs: 0, retryAfterCapSeconds: 0,
  maxResponseBytes: 100_000, maxCacheEntries: 100, maxCacheBytes: 1_000_000, maxConcurrentUpstream: 4,
  cacheTtlSeconds: 60, maxClientRequestsPerWindow: 200, clientRateWindowSeconds: 60,
  opaqueRefSecret: "test-secret-with-at-least-thirty-two-bytes",
};
const apps: FastifyInstance[] = [];
async function app(fetcher: typeof fetch) { const instance = await createApp(config, fetcher); apps.push(instance); return instance; }
afterEach(async () => { await Promise.all(apps.splice(0).map((instance) => instance.close())); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const article = (id: number) => ({ display: `Engine >> Parts and Labor >> Article ${id}`, itypeCategory: { name: "Parts and Labor" }, _links: { self: { href: `/api/v1/content/carids/12/components/1/itypes/2/nonstandards/${id}` } } });
const signedRef = (prefix: string, payload: string) => {
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", config.opaqueRefSecret).update(`banktwo-${prefix}-ref-v1\\0`).update(encoded).digest("base64url");
  return `${prefix}.${encoded}.${signature}`;
};

describe("Banktwo Source Connector v1", () => {
  it("discovers capabilities and exposes contract operations in OpenAPI", async () => {
    const instance = await app(vi.fn() as typeof fetch);
    const response = await instance.inject("/v1/capabilities");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "banktwo", capabilities: ["catalog", "vehicle_resolution", "article_list", "article_search", "resource_read"] });
    expect(response.json().request_id).toMatch(/^[a-f0-9-]{36}$/);
    const document = (await instance.inject("/openapi.json")).json();
    for (const path of ["/v1/capabilities", "/v1/catalog/{scope}", "/v1/vehicle-resolutions", "/v1/vehicles/{opaqueRef}/articles", "/v1/vehicles/{opaqueRef}/article-search", "/v1/resources/{opaqueRef}"]) expect(document.paths[path]).toBeDefined();
    const canonical = await instance.inject("/openapi/source-connector-v1.yaml");
    expect(canonical.statusCode).toBe(200);
    expect(canonical.body).toContain("openapi: 3.1.0");
    expect(canonical.body).toContain("asset_resource_refs");
  });

  it("projects catalog records and returns a bounded continuation cursor", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://source.test/api/v1/fleet/years");
      return json(Array.from({ length: 101 }, (_, index) => ({ year: String(1900 + index) })));
    });
    const instance = await app(fetcher as typeof fetch);
    const first = await instance.inject("/v1/catalog/years");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: "banktwo", scope: "years", complete: false });
    expect(first.json().items).toHaveLength(100);
    const second = await instance.inject(`/v1/catalog/years?cursor=${encodeURIComponent(first.json().next_cursor)}`);
    expect(second.json()).toMatchObject({ complete: true, items: [{ year: 2000, label: "2000" }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a continuation cursor when the source catalog revision changes", async () => {
    const first = await app(vi.fn(async () => json(Array.from({ length: 101 }, (_, index) => ({ year: 1900 + index })))) as typeof fetch);
    const page = await first.inject("/v1/catalog/years");
    const cursor = page.json().next_cursor;
    const changed = await app(vi.fn(async () => json(Array.from({ length: 102 }, (_, index) => ({ year: 1900 + index })))) as typeof fetch);
    const response = await changed.inject(`/v1/catalog/years?cursor=${encodeURIComponent(cursor)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_INPUT");
  });

  it("returns all matching vehicle candidates without choosing an ambiguous configuration", async () => {
    const fetcher = vi.fn(async () => json({ results: [
      { id: "12", year: "1999", make: "Toyota", model: "Avalon", engine: "V6 3.0L FWD" },
      { id: "13", year: "1999", make: "Toyota", model: "Avalon", engine: "V6 3.0L AWD" },
      { id: "99", year: "1999", make: "Honda", model: "Accord" },
      { id: "14" },
    ] }));
    const instance = await app(fetcher as typeof fetch);
    const response = await instance.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates.map((item: { opaque_ref: string }) => item.opaque_ref)).toEqual([signedRef("v", "12"), signedRef("v", "13")]);
    expect((await instance.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon", unknown: "x" } })).json().error.code).toBe("INVALID_INPUT");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const constrained = await app(vi.fn(async () => json({ results: [{ id: "12", year: "1999", make: "Toyota", model: "Avalon", engine: "V6 3.0L FWD" }] })) as typeof fetch);
    const missingVin = await constrained.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon", vin: "1ABC" } });
    expect(missingVin.json().candidates).toEqual([]);
  });

  it("owns article discovery, search, resource selection, labor association and binary hashes", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/search/o")) return json({ _embedded: { data: { results: [article(42)] } } });
      if (path.includes("/search/")) return json({ _embedded: { data: { results: [] } } });
      if (path.endsWith("/nonstandards/42")) return json({ car: { id: "12" }, _embedded: { data: { article: { image: '<mtr-image src="/api/v1/content/carids/12/thumbnails/a">' }, partsAndLabor: { labors: { operations: [{ operation: "Replace" }] } } } } });
      if (path.endsWith("/thumbnails/a")) return new Response(bytes, { headers: { "content-type": "image/png" } });
      throw new Error(`Unexpected path: ${path}`);
    });
    const instance = await app(fetcher as typeof fetch);
    const vehicle = signedRef("v", "12");
    const listing = await instance.inject(`/v1/vehicles/${vehicle}/articles`);
    expect(listing.statusCode).toBe(200);
    expect(listing.json().articles).toHaveLength(1);
    const search = await instance.inject({ method: "POST", url: `/v1/vehicles/${vehicle}/article-search`, payload: { query: "o" } });
    expect(search.statusCode).toBe(200);
    expect(search.json().articles[0].title).toBe("Article 42");
    const ref = search.json().articles[0].resource_ref;
    expect(search.json().articles[0].labor_resource_ref).toBe(ref);
    const resource = await instance.inject(`/v1/resources/${ref}`);
    expect(resource.json()).toMatchObject({ kind: "labor", media_type: "application/json" });
    expect(resource.json().sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resource.headers["x-provider"]).toBe("banktwo");
    expect(resource.headers["x-source-sha256"]).toBe(resource.json().sha256);
    expect(resource.headers["x-source-media-type"]).toBe("application/json");
    expect(resource.headers["x-source-locator"]).toBe("https://source.test/api/v1/content/carids/12/components/1/itypes/2/nonstandards/42");
    expect(resource.json().asset_resource_refs).toHaveLength(1);
    const assetRef = resource.json().asset_resource_refs[0];
    const asset = await instance.inject(`/v1/resources/${assetRef}`);
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "image/png", content_base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
  });

  it("rejects forged resource handles and sanitizes invalid upstream payloads", async () => {
    const fetcher = vi.fn(async () => new Response("secret provider payload", { headers: { "content-type": "application/json" } }));
    const instance = await app(fetcher as typeof fetch);
    const escape = `r.${Buffer.from("/api/v1/content/carids/12/../../admin").toString("base64url")}`;
    const forbidden = await instance.inject(`/v1/resources/${escape}`);
    expect(forbidden.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await instance.inject("/v1/catalog/years");
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("INVALID_UPSTREAM_RESPONSE");
    expect(response.body).not.toContain("secret provider payload");
  });

  it("fails closed on article links containing signed or credential query strings", async () => {
    const fetcher = vi.fn(async () => json({ _embedded: { data: { results: [{
      display: "Engine >> Article",
      _links: { self: { href: "/api/v1/content/carids/12/articles/42?access_token=private" } },
    }] } } }));
    const instance = await app(fetcher as typeof fetch);
    const response = await instance.inject({ method: "POST", url: `/v1/vehicles/${signedRef("v", "12")}/article-search`, payload: { query: "brake" } });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private");
  });

  it("maps an upstream rate limit to the stable retryable contract error", async () => {
    const instance = await app(vi.fn(async () => new Response("private", { status: 429, headers: { "retry-after": "1" } })) as typeof fetch);
    const response = await instance.inject("/v1/catalog/years");
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
    expect(response.body).not.toContain("private");
  });
});
