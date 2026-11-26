import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createHash, createHmac } from "node:crypto";
import Ajv from "ajv";
import { parse } from "yaml";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const config: Config = {
  host: "127.0.0.1", port: 3001, upstreamBaseUrl: "https://source.test",
  publicBaseUrl: "https://banktwo.cars.tk",
  requestTimeoutMs: 500, retryAttempts: 1, retryDelayMs: 0, retryAfterCapSeconds: 0,
  maxResponseBytes: 100_000, maxCacheEntries: 100, maxCacheBytes: 1_000_000, maxConcurrentUpstream: 4,
  cacheTtlSeconds: 60, maxClientRequestsPerWindow: 200, clientRateWindowSeconds: 60,
  opaqueRefSecret: "test-secret-with-at-least-thirty-two-bytes",
};
const apps: FastifyInstance[] = [];
type SchemaValidator = {
  addSchema(schema: unknown, key: string): void;
  compile(schema: Record<string, unknown>): ((value: unknown) => boolean) & { errors?: unknown[] };
  errorsText(errors?: unknown[]): string;
};
const AjvConstructor = Ajv as unknown as new (options: Record<string, unknown>) => SchemaValidator;
const validators = new WeakMap<FastifyInstance, SchemaValidator>();
async function app(fetcher: typeof fetch, maxResponseBytes = config.maxResponseBytes) {
  const instance = await createApp({ ...config, maxResponseBytes }, fetcher, async () => true);
  const servedContract = await instance.inject("/openapi/source-connector-v1.yaml");
  expect(servedContract.statusCode).toBe(200);
  const validator = new AjvConstructor({ strict: false, validateFormats: false, allErrors: true });
  validator.addSchema(parse(servedContract.body), "https://cars.tk/contracts/source-connector/v1");
  validators.set(instance, validator);
  apps.push(instance);
  return instance;
}
async function authed(
  instance: FastifyInstance,
  options: { method?: "GET" | "POST"; url: string; payload?: string | object | Buffer; prefer?: string },
): Promise<LightMyRequestResponse> {
  return await instance.inject({
    method: options.method ?? "GET",
    url: options.url,
    payload: options.payload,
    headers: { authorization: "Bearer adk_banktwo_fixture", ...(options.prefer ? { prefer: options.prefer } : {}) },
  });
}
afterEach(async () => { await Promise.all(apps.splice(0).map((instance) => instance.close())); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const article = (id: number) => ({ display: `Engine >> Parts and Labor >> Article ${id}`, itypeCategory: { name: "Parts and Labor" }, _links: { self: { href: `/api/v1/content/carids/12/components/1/itypes/2/nonstandards/${id}` } } });
const signedRef = (prefix: string, payload: string) => {
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", config.opaqueRefSecret).update(`banktwo-${prefix}-ref-v1\\0`).update(encoded).digest("base64url");
  return `${prefix}.${encoded}.${signature}`;
};

function expectContract(instance: FastifyInstance, schemaName: string, value: unknown) {
  const ajv = validators.get(instance)!;
  const validate = ajv.compile({ $ref: `https://cars.tk/contracts/source-connector/v1#/components/schemas/${schemaName}` });
  const valid = validate(value);
  expect(valid, `${schemaName}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe("Banktwo Source Connector v1", () => {
  it("discovers capabilities and exposes contract operations in OpenAPI", async () => {
    const instance = await app(vi.fn() as typeof fetch);
    const response = await authed(instance, { url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "banktwo", capabilities: ["catalog", "vehicle_resolution", "article_list", "article_search", "resource_read"] });
    expect(response.json().request_id).toMatch(/^[a-f0-9-]{36}$/);
    expectContract(instance, "CapabilitiesResponse", response.json());
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
    const first = await authed(instance, { url: "/v1/catalog/years" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: "banktwo", scope: "years", complete: false });
    expect(first.json().items).toHaveLength(100);
    expectContract(instance, "CatalogResponse", first.json());
    const second = await authed(instance, { url: `/v1/catalog/years?cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(second.json()).toMatchObject({ complete: true, items: [{ year: 2000, label: "2000" }] });
    expectContract(instance, "CatalogResponse", second.json());
    const emptyCursor = await authed(instance, { url: "/v1/catalog/years?cursor=" });
    expect(emptyCursor.statusCode).toBe(400);
    expect(emptyCursor.json().error.code).toBe("INVALID_INPUT");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a continuation cursor when the source catalog revision changes", async () => {
    const first = await app(vi.fn(async () => json(Array.from({ length: 101 }, (_, index) => ({ year: 1900 + index })))) as typeof fetch);
    const page = await authed(first, { url: "/v1/catalog/years" });
    const cursor = page.json().next_cursor;
    const changed = await app(vi.fn(async () => json(Array.from({ length: 102 }, (_, index) => ({ year: 1900 + index })))) as typeof fetch);
    const response = await authed(changed, { url: `/v1/catalog/years?cursor=${encodeURIComponent(cursor)}` });
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
    const response = await authed(instance, { method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon" } });
    expect(response.statusCode).toBe(200);
    expectContract(instance, "VehicleResolutionResponse", response.json());
    expect(response.json().candidates.map((item: { opaque_ref: string }) => item.opaque_ref)).toEqual([signedRef("v", "12"), signedRef("v", "13")]);
    expect((await authed(instance, { method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon", unknown: "x" } })).json().error.code).toBe("INVALID_INPUT");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const constrained = await app(vi.fn(async () => json({ results: [{ id: "12", year: "1999", make: "Toyota", model: "Avalon", engine: "V6 3.0L FWD" }] })) as typeof fetch);
    const missingVin = await authed(constrained, { method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 1999, make: "Toyota", model: "Avalon", vin: "1ABC" } });
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
    const listing = await authed(instance, { url: `/v1/vehicles/${vehicle}/articles` });
    expect(listing.statusCode).toBe(200);
    expectContract(instance, "ArticleListResponse", listing.json());
    expect(listing.json().articles).toHaveLength(1);
    const search = await authed(instance, { method: "POST", url: `/v1/vehicles/${vehicle}/article-search`, payload: { query: "o" } });
    expect(search.statusCode).toBe(200);
    expectContract(instance, "ArticleListResponse", search.json());
    expect(search.json().articles[0].title).toBe("Article 42");
    const ref = search.json().articles[0].resource_ref;
    expect(search.json().articles[0].labor_resource_ref).toBe(ref);
    const resource = await authed(instance, { url: `/v1/resources/${ref}` });
    expect(resource.json()).toMatchObject({ kind: "labor", media_type: "application/json" });
    expectContract(instance, "TextResource", resource.json());
    expect(resource.json().sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resource.headers["x-provider"]).toBe("banktwo");
    expect(resource.headers["x-source-sha256"]).toBe(resource.json().sha256);
    expect(resource.headers["x-source-media-type"]).toBe("application/json");
    expect(resource.headers["x-source-locator"]).toBe("https://banktwo.cars.tk/v1/content/carids/12/resource?path=%2Fapi%2Fv1%2Fcontent%2Fcarids%2F12%2Fcomponents%2F1%2Fitypes%2F2%2Fnonstandards%2F42");
    expect(resource.json().asset_resource_refs).toHaveLength(1);
    const assetRef = resource.json().asset_resource_refs[0];
    const asset = await authed(instance, { url: `/v1/resources/${assetRef}` });
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "image/png", content_base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
    expectContract(instance, "BinaryResource", asset.json());
  });

  it.each(["list", "search"] as const)("keeps article %s cursors across equivalent upstream responses", async (operation) => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...article(index + 1),
      title: `Procedure ${String(index).padStart(3, "0")}`,
    }));
    const replica = (results: typeof rows, requestStamp: string) => app(vi.fn(async (input) =>
      json({ results: new URL(String(input)).pathname.endsWith("/search/o") ? results : [], requestStamp }),
    ) as typeof fetch);
    const fetchPage = (instance: FastifyInstance, cursor?: string) => {
      const route = `/v1/vehicles/${signedRef("v", "12")}`;
      if (operation === "search") {
        return authed(instance, {
          method: "POST", url: route + "/article-search", payload: { query: "o", ...(cursor ? { cursor } : {}) },
        });
      }
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return authed(instance, { url: route + "/articles" + suffix });
    };

    const firstReplica = await replica(rows, "first");
    const first = await fetchPage(firstReplica);
    expect(first.statusCode).toBe(200);
    const { next_cursor: cursor, source_revision: revision } = first.json();
    expectContract(firstReplica, "ArticleListResponse", first.json());
    expect(first.json().articles).toHaveLength(100);
    expect(first.json().complete).toBe(false);

    const secondReplica = await replica([...rows].reverse(), "second");
    const second = await fetchPage(secondReplica, cursor);
    expect(second.statusCode).toBe(200);
    expectContract(secondReplica, "ArticleListResponse", second.json());
    expect(second.json()).toMatchObject({
      source_revision: revision, complete: true, articles: [{ title: "Procedure 100" }],
    });
    expect(second.json().articles).toHaveLength(1);
    expect(second.json().next_cursor).toBeUndefined();

    const changed = await replica([...rows.slice(0, 100), {
      ...rows[100], itypeCategory: { name: "Changed category" },
    }], "third");
    const stale = await fetchPage(changed, cursor);
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.code).toBe("INVALID_INPUT");
  });

  it("keeps article order and revision when a continuation requests a larger page", async () => {
    const rows = Array.from({ length: 601 }, (_, index) => ({
      title: `Procedure ${String(index).padStart(3, "0")}`,
      _links: { self: { href: `/api/v1/content/carids/12/articles/${index + 1}` } },
    }));
    const instance = await app(vi.fn(async (input) =>
      json({ results: new URL(String(input)).pathname.endsWith("/search/o") ? rows : [] }),
    ) as typeof fetch);
    const route = `/v1/vehicles/${signedRef("v", "12")}/articles`;
    const prefer = "max-page-size=500";
    const first = await authed(instance, { url: route, prefer });
    expect(first.statusCode).toBe(200);
    expect(first.headers.vary).toBe("Prefer");
    expect(first.headers["preference-applied"]).toBeUndefined();
    expect(first.json().articles).toHaveLength(100);
    const continuation = `${route}?cursor=${encodeURIComponent(first.json().next_cursor)}`;
    const normal = await authed(instance, { url: continuation });
    expect(normal.statusCode).toBe(200);
    expect(normal.json().articles).toHaveLength(100);
    expect(normal.headers["preference-applied"]).toBeUndefined();

    const batch = await authed(instance, { url: continuation, prefer });
    expect(batch.statusCode).toBe(200);
    expect(batch.headers.vary).toBe("Prefer");
    expect(batch.headers["preference-applied"]).toBe(prefer);
    expectContract(instance, "ArticleListResponse", batch.json());
    expect(batch.json().articles).toHaveLength(500);
    expect(batch.json().articles.slice(0, 100)).toEqual(normal.json().articles);
    expect(batch.json().source_revision).toBe(first.json().source_revision);

    const tail = await authed(instance, { url: `${route}?cursor=${encodeURIComponent(batch.json().next_cursor)}` });
    expect(tail.statusCode).toBe(200);
    expect(tail.json()).toMatchObject({ complete: true, source_revision: first.json().source_revision });
    expect(tail.json().next_cursor).toBeUndefined();
    const titles = [first, batch, tail].flatMap(response => (response.json().articles as { title: string }[]).map(article => article.title));
    expect(titles).toEqual(rows.map(row => row.title));
  });

  it("continues from the last entry when the byte limit shortens the page", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({
      title: `Procedure ${String(index).padStart(3, "0")} ${"🚗".repeat(450)}`,
      display: `${"部".repeat(256)} >> Procedure`,
      itypeCategory: { name: `Labor ${"部".repeat(250)}` },
      _links: { self: { href: `/api/v1/content/carids/12/articles/${"a".repeat(1300)}/${index + 1}` } },
    }));
    const instance = await app(vi.fn(async (input) =>
      json({ results: new URL(String(input)).pathname.endsWith("/search/o") ? rows : [] }),
    ) as typeof fetch, 4 * 1024 * 1024);
    const route = `/v1/vehicles/${signedRef("v", "12")}/articles`;
    const load = (cursor?: string) => authed(instance, {
      url: cursor ? `${route}?cursor=${encodeURIComponent(cursor)}` : route,
      prefer: "max-page-size=500",
    });
    const first = await load();
    const batch = await load(first.json().next_cursor);
    expect(batch.statusCode).toBe(200);
    expect(batch.json().articles.length).toBeGreaterThan(100);
    expect(batch.json().articles.length).toBeLessThan(500);
    expect(Buffer.byteLength(batch.body)).toBeLessThan(4_500_000);
    const tail = await load(batch.json().next_cursor);
    expect(tail.statusCode).toBe(200);
    expect(tail.json()).toMatchObject({ complete: true, source_revision: first.json().source_revision });
    const titles = [first, batch, tail].flatMap(response => (response.json().articles as { title: string }[]).map(article => article.title));
    expect(titles).toEqual(rows.map(row => row.title));
  });

  it("continues a legacy article search cursor when its upstream response still matches", async () => {
    const results = Array.from({ length: 101 }, (_, index) => article(index + 1));
    const raw = { results };
    const instance = await app(vi.fn(async () => json(raw)) as typeof fetch);
    const oldRevision = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const cursor = "p." + Buffer.from(JSON.stringify({
      key: createHash("sha256").update("search:12:o").digest("hex"),
      offset: 100,
      revision: oldRevision,
    })).toString("base64url");
    const response = await authed(instance, {
      method: "POST", url: `/v1/vehicles/${signedRef("v", "12")}/article-search`,
      payload: { query: "o", cursor },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().complete).toBe(true);
    expect(response.json().articles).toHaveLength(1);
    expect(response.json().source_revision).not.toBe(oldRevision);
  });

  it("lists and opens a localized supplier article with its original body", async () => {
    const path = "/api/v1/content/carids/12/components/1/itypes/2/nonstandards/42";
    const raw = JSON.stringify({ car: { id: 12 }, _embedded: { data: { article: {
      html: "<p>Inspect the oil pump.</p>",
    } } } });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === path) {
        expect(url.search).toBe("?locale=en_US");
        return new Response(raw, { headers: { "content-type": "application/hal+json" } });
      }
      const results = url.pathname.endsWith("/search/o")
        ? [{ display: "Engine >> Oil Pump", _links: { self: { href: `https://source.test${path}?locale=en_US` } } }]
        : [];
      return json({ _embedded: { data: { results } } });
    });
    const instance = await app(fetcher as typeof fetch);
    const vehicle = signedRef("v", "12");
    const listing = await authed(instance, { url: `/v1/vehicles/${vehicle}/articles` });
    expect(listing.statusCode).toBe(200);
    expectContract(instance, "ArticleListResponse", listing.json());
    expect(listing.json().articles).toHaveLength(1);
    const ref = listing.json().articles[0].resource_ref;
    const search = await authed(instance, { method: "POST", url: `/v1/vehicles/${vehicle}/article-search`, payload: { query: "o" } });
    expect(search.json().articles[0].resource_ref).toBe(ref);
    const articleResponse = await authed(instance, { url: `/v1/resources/${ref}` });
    expect(articleResponse.statusCode).toBe(200);
    expectContract(instance, "TextResource", articleResponse.json());
    expect(articleResponse.json()).toMatchObject({
      content: raw, media_type: "application/hal+json", kind: "article",
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
  });

  it.each(["application/json", "application/hal+json"])("binds decoded thumbnail src values to scoped opaque refs without changing source bytes (%s)", async (mediaType) => {
    const sourceUrl = "/api/v1/content/carids/12/thumbnails/group/image/variant?locale=en_US&region=US";
    const markup = `<img src="${sourceUrl.replace("&", "&amp;")}"><img src="${sourceUrl.replace("&", "&#38;")}">`;
    const original = JSON.stringify({ car: { id: "12" }, _embedded: { data: { article: { html: markup } } } });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/articles/42")) return new Response(original, { headers: { "content-type": mediaType } });
      if (url.pathname.endsWith("/thumbnails/group/image/variant") && url.search === "?locale=en_US&region=US") return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
      return new Response("missing", { status: 404 });
    });
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", "/api/v1/content/carids/12/articles/42")}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.content).toBe(original);
    expect(body.media_type).toBe(mediaType);
    expect(body.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(body.asset_bindings).toEqual([{ source_url: sourceUrl, resource_ref: signedRef("r", sourceUrl) }]);
    expect(body.asset_resource_refs).toEqual([signedRef("r", sourceUrl)]);
    expectContract(instance, "TextResource", body);
    const asset = await authed(instance, { url: `/v1/resources/${body.asset_bindings[0].resource_ref}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "image/jpeg", content_base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
    expectContract(instance, "BinaryResource", asset.json());
  });

  it.each(["application/hal+json", "text/html"])("binds an authored localized SVG after a table (%s)", async (mediaType) => {
    const sourceUrl = "/api/v1/content/carids/12/svgs/drawing?locale=en_US&region=US";
    const markup = [
      "<table><tr><td>Alignment data</td></tr></table>",
      `<img src="${sourceUrl.replace("&", "&amp;")}">`,
      '<img src="/api/v1/content/carids/13/svgs/other?locale=en_US&region=US">',
      '<img src="/api/v1/content/carids/12/svgs/duplicate?region=US&region=CA">',
      '<img src="/api/v1/content/carids/12/svgs/hidden?locale=en_US" hidden>',
      '<img src="/api/v1/content/carids/12/svgs/wrong?access_token=fixture">',
      '<img src="/api/v1/content/carids/12/svgs/group/member?locale=en_US">',
      '<img src="/api/v1/content/carids/12/svgs/ambiguous?locale=en_US" src="other">',
    ].join("");
    const original = mediaType === "text/html" ? markup : JSON.stringify({
      car: { id: "12" }, _embedded: { data: { article: {
        content: markup, label: '<img src="/api/v1/content/carids/12/svgs/metadata?locale=en_US">',
      } } },
    });
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8"/></svg>');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/articles/42")) return new Response(original, { headers: { "content-type": mediaType } });
      if (url.pathname + url.search === sourceUrl) return new Response(bytes, { headers: { "content-type": "image/svg+xml" } });
      return new Response("missing", { status: 404 });
    });
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", "/api/v1/content/carids/12/articles/42")}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ref = signedRef("r", sourceUrl);
    expect(body.content).toBe(original);
    expect(body.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(body.asset_bindings).toEqual([{ source_url: sourceUrl, resource_ref: ref }]);
    expect(body.asset_resource_refs).toEqual([ref]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expectContract(instance, "TextResource", body);
    const asset = await authed(instance, { url: `/v1/resources/${ref}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({
      kind: "asset", media_type: "image/svg+xml", content_base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expectContract(instance, "BinaryResource", asset.json());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["application/json", "application/hal+json", "text/html"])("binds authored PDF locations in source order without changing bytes (%s)", async (mediaType) => {
    const root = "/api/v1/content/carids/12";
    const bodyPath = `${root}/articles/42`;
    const anchoredPath = `${root}/components/1/documents/service?locale=en_US&region=US`;
    const anchored = `https://source.test${anchoredPath}`;
    const iframe = `${root}/attachments/illustration`;
    const object = `${root}/assets/illustration`;
    const embed = `${root}/assets/service.pdf`;
    const html = `<p>Vérifier le serrage.</p><a href="${anchored.replace("&", "&amp;")}">Service diagram</a>` +
      `<iframe src="${iframe}"></iframe><a href="${anchored.replace("&", "&#38;")}">Repeated diagram</a>` +
      `<object type="application/pdf" data="${object}">Fallback</object><embed src="${embed}">`;
    const raw = mediaType === "text/html" ? html : JSON.stringify({ car: { id: 12 }, _embedded: { data: { article: {
      content: html, blocks: [{ kind: "text", text: "Vérifier le serrage." }],
    } } } });
    const pdf = Buffer.from("%PDF-1.7\n% Fixture bytes\n%%EOF\n");
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === bodyPath) return new Response(raw, { headers: { "content-type": `${mediaType}; charset=utf-8` } });
      expect(url.href).toBe(anchored);
      expect(new Headers(init?.headers).get("accept")).toContain("application/pdf");
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    });
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", bodyPath)}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const bindings = [[anchored, anchoredPath], [iframe, iframe], [object, object], [embed, embed]].map(([source_url, path]) => ({
      source_url, resource_ref: signedRef("r", path),
    }));
    expect(body).toMatchObject({ content: raw, media_type: mediaType, sha256: createHash("sha256").update(raw).digest("hex"),
      asset_bindings: bindings, asset_resource_refs: bindings.map(binding => binding.resource_ref),
    });
    expectContract(instance, "TextResource", body);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const asset = await authed(instance, { url: `/v1/resources/${body.asset_bindings[0].resource_ref}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "application/pdf", content_base64: pdf.toString("base64"),
      sha256: createHash("sha256").update(pdf).digest("hex"),
    });
    expectContract(instance, "BinaryResource", asset.json());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("omits unrelated, foreign, unscoped and ambiguous document locations", async () => {
    const root = "/api/v1/content/carids/12";
    const valid = `${root}/documents/good.pdf`;
    const html = [
      `<a href="${root}/components/2/unrelated" type="application/pdf">Unrelated article</a>`,
      `<a href="${root}/assets/unrelated">Unrelated asset</a>`,
      '<a href="https://foreign.test/api/v1/content/carids/12/documents/foreign.pdf">Foreign origin</a>',
      '<a href="/api/v1/content/carids/13/documents/other.pdf">Other vehicle</a>',
      '<a href="/documents/unscoped.pdf">Unscoped document</a>',
      `<a href="${valid}?locale=en_US">Unapproved query namespace</a>`,
      `<a href="${valid}#section">Fragment</a>`,
      `<a href="${valid}" href="${root}/documents/other.pdf">Ambiguous link</a>`,
      `<a href="${valid}" type="text/html">Wrong type</a>`,
      `<iframe src="${valid}" srcdoc="Fallback"></iframe>`,
      `<template><embed src="${valid}"></template>`,
      `<aside hidden><a href="${valid}">Hidden document</a></aside>`,
    ].join("");
    const raw = JSON.stringify({ car: { id: 12 }, _embedded: { data: { article: { content: html } } },
      unrelated: `<a href="${valid}">Outside article</a>`,
    });
    const fetcher = vi.fn(async () => new Response(raw, { headers: { "content-type": "application/hal+json" } }));
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", `${root}/articles/42`)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: raw, sha256: createHash("sha256").update(raw).digest("hex") });
    expect(response.json().asset_bindings).toBeUndefined();
    expect(response.json().asset_resource_refs).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds document bindings and keeps the first authored positions", async () => {
    const root = "/api/v1/content/carids/12";
    const urls = Array.from({length: 130}, (_, index) => `${root}/documents/${index}`);
    const html = urls.map(url => `<a href="${url}">Document</a>`).join("");
    const instance = await app(vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } })) as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", `${root}/articles/42`)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().asset_bindings.map(({source_url}: {source_url:string}) => source_url)).toEqual(urls.slice(0, 128));
    expect(response.json().asset_resource_refs).toHaveLength(128);
    expectContract(instance, "TextResource", response.json());
  });

  it("does not bind images outside the selected vehicle or with unsafe query parameters", async () => {
    const sources = [
      "https://other.test/api/v1/content/carids/12/thumbnails/a?locale=en_US",
      "https://user:private@source.test/api/v1/content/carids/12/thumbnails/a?locale=en_US",
      "/api/v1/content/carids/13/thumbnails/a?locale=en_US",
      "/api/v1/content/carids/12/thumbnails/a?access_token=secret",
      "/api/v1/content/carids/12/thumbnails/a?locale=en_US&locale=en_GB",
      "/api/v1/content/carids/12/thumbnails/a?region=%2fadmin",
    ];
    const original = JSON.stringify({ car: { id: "12" }, _embedded: { data: { article: { html: sources.map((src) => `<img src="${src}">`).join("") } } } });
    const instance = await app(vi.fn(async () => new Response(original, { headers: { "content-type": "application/json" } })) as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", "/api/v1/content/carids/12/articles/42")}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().content).toBe(original);
    expect(response.json().asset_bindings).toBeUndefined();
    expect(response.json().asset_resource_refs).toBeUndefined();
  });

  it.each([
    "/api/v1/content/carids/12/articles/42?locale=en_US",
    "/api/v1/content/carids/12/thumbnails/a?access_token=secret",
    "/api/v1/content/carids/12/thumbnails/a?locale=en_US&locale=en_GB",
    "/api/v1/content/carids/12/thumbnails/a?region=%0aUS",
    "/api/v1/content/carids/12/thumbnails/a?region=" + "x".repeat(33),
  ])("rejects signed but disallowed resource queries before fetching (%s)", async (path) => {
    const fetcher = vi.fn();
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { url: `/v1/resources/${signedRef("r", path)}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_INPUT");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects forged resource handles and sanitizes invalid upstream payloads", async () => {
    const fetcher = vi.fn(async () => new Response("secret provider payload", { headers: { "content-type": "application/json" } }));
    const instance = await app(fetcher as typeof fetch);
    const escape = `r.${Buffer.from("/api/v1/content/carids/12/../../admin").toString("base64url")}`;
    const forbidden = await authed(instance, { url: `/v1/resources/${escape}` });
    expect(forbidden.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await authed(instance, { url: "/v1/catalog/years" });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("INVALID_UPSTREAM_RESPONSE");
    expectContract(instance, "ErrorResponse", response.json());
    expect(response.body).not.toContain("secret provider payload");
  });

  it("fails closed on article links containing signed or credential query strings", async () => {
    const fetcher = vi.fn(async () => json({ _embedded: { data: { results: [{
      display: "Engine >> Article",
      _links: { self: { href: "/api/v1/content/carids/12/components/1/itypes/2/nonstandards/42?locale=en_US&access_token=private" } },
    }] } } }));
    const instance = await app(fetcher as typeof fetch);
    const response = await authed(instance, { method: "POST", url: `/v1/vehicles/${signedRef("v", "12")}/article-search`, payload: { query: "brake" } });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private");
  });

  it("maps an upstream rate limit to the stable retryable contract error", async () => {
    const instance = await app(vi.fn(async () => new Response("private", { status: 429, headers: { "retry-after": "1" } })) as typeof fetch);
    const response = await authed(instance, { url: "/v1/catalog/years" });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
    expectContract(instance, "ErrorResponse", response.json());
    expect(response.body).not.toContain("private");
  });
});
