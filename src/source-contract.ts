import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";
import { rateLimit } from "./routes.js";
import { UpstreamClient, type UpstreamResponse } from "./upstream-client.js";

type Dependencies = { config: Config; upstream: UpstreamClient };
type RecordValue = Record<string, unknown>;
type Selector = { year: number; make: string; model: string; configuration?: string; region?: string; vin?: string };
type Article = { opaque_ref: string; title: string; category?: string; component?: string; resource_ref: string; labor_resource_ref?: string };
const revision = "autoapitwo-fleet-v1";
const indexTerms = "abcdefghijklmnopqrstuvwxyz0123456789";
const pageSize = 100;

function invalid(message: string): never { throw new ConnectorError("invalid_request", message, 400); }
function malformed(): never { throw new ConnectorError("invalid_upstream_response", "Banktwo received an invalid source response", 502); }
function object(value: unknown): RecordValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; }
function list(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.map(object).filter((item): item is RecordValue => item !== undefined);
  const parent = object(value);
  for (const key of ["results", "items", "data"]) {
    if (Array.isArray(parent?.[key])) return (parent[key] as unknown[]).map(object).filter((item): item is RecordValue => item !== undefined);
  }
  return malformed();
}
function sourceJson(result: UpstreamResponse): unknown {
  try { return JSON.parse(result.body.toString("utf8")); }
  catch { return malformed(); }
}
function encoded(value: string): string { return encodeURIComponent(value); }
function vehicleRef(carId: string): string { return `v.${carId}`; }
function carIdFromRef(value: unknown): string {
  const ref = text(value);
  if (!/^v\.\d{1,20}$/.test(ref)) invalid("Invalid vehicle reference");
  return ref.slice(2);
}
function cleanSegment(value: unknown, name: string, maxLength = 160): string {
  const part = text(value);
  if (!part || part.length > maxLength || /[\u0000-\u001f\u007f]/.test(part)) invalid(`${name} is invalid`);
  return part;
}
function cleanYear(value: unknown): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1886 || year > 2200) invalid("year is invalid");
  return year;
}
function contentPath(value: string, carId?: string, upstreamOrigin = "https://banktwo.invalid"): string {
  let path: string;
  try {
    const parsed = new URL(value, upstreamOrigin);
    if (parsed.origin !== upstreamOrigin || parsed.hash || parsed.search.length > 1024 || [...parsed.searchParams].some(([key, item]) => !/^[A-Za-z0-9_.~-]{1,64}$/.test(key) || item.length > 512 || /[\u0000-\u001f]/.test(item))) invalid("Invalid resource reference");
    path = parsed.pathname;
    if (parsed.search) path += parsed.search;
  } catch { return invalid("Invalid resource reference"); }
  const pathname = path.split("?", 1)[0];
  const match = /^\/api\/v1\/content\/carids\/(\d{1,20})\/(.+)$/.exec(pathname);
  if (!match || path.length > 1400 || (carId && match[1] !== carId) || /%2f|%5c|%2e/i.test(pathname) || pathname.includes("\\") || pathname.split("/").some((part) => part === "." || part === "..")) invalid("Resource is outside the selected vehicle");
  return path;
}
function resourceRef(path: string): string {
  return `r.${Buffer.from(contentPath(path), "utf8").toString("base64url")}`;
}
function pathFromResourceRef(ref: unknown): string {
  const value = text(ref);
  if (!/^r\.[A-Za-z0-9_-]{1,2000}$/.test(value)) invalid("Invalid resource reference");
  let decoded: string;
  try { decoded = Buffer.from(value.slice(2), "base64url").toString("utf8"); }
  catch { return invalid("Invalid resource reference"); }
  if (resourceRef(decoded) !== value) invalid("Invalid resource reference");
  return decoded;
}
function cursorOffset(cursor: unknown, key: string): number {
  if (cursor === undefined || cursor === "") return 0;
  const raw = text(cursor);
  if (!/^p\.[A-Za-z0-9_-]{1,510}$/.test(raw)) invalid("Invalid page cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw.slice(2), "base64url").toString("utf8")); }
  catch { return invalid("Invalid page cursor"); }
  const parsed = object(value);
  if (parsed?.key !== cursorKey(key) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > 100_000) invalid("Invalid page cursor");
  return Number(parsed.offset);
}
function cursorKey(key: string): string { return createHash("sha256").update(key).digest("hex"); }
function nextCursor(key: string, offset: number): string { return `p.${Buffer.from(JSON.stringify({ key: cursorKey(key), offset })).toString("base64url")}`; }
function page<T>(items: T[], offset: number, key: string) {
  const slice = items.slice(offset, offset + pageSize);
  const complete = offset + slice.length >= items.length;
  return { complete, ...(complete ? {} : { next_cursor: nextCursor(key, offset + slice.length) }), items: slice };
}
function envelope(request: FastifyRequest, result?: UpstreamResponse) {
  return { request_id: request.id, provider: "banktwo" as const, source_revision: result?.sha256 || revision, fetched_at: new Date().toISOString(), ...(result ? { source_locator: result.sourceUri } : {}) };
}
async function readJson(deps: Dependencies, path: string, ttlSeconds = deps.config.cacheTtlSeconds): Promise<{ data: unknown; source: UpstreamResponse }> {
  const source = await deps.upstream.read(path, "application/json", ttlSeconds);
  return { data: sourceJson(source), source };
}
function upstreamCarId(row: RecordValue): string | undefined {
  const embedded = object(row._embedded);
  const link = object(object(row._links)?.car);
  const linked = text(link?.href);
  const match = /\/api\/v1\/fleet\/carids\/(\d{1,20})(?:$|[?#])/.exec(linked);
  const value = text(row.id || row.carId || embedded?.carId || match?.[1]);
  return /^\d{1,20}$/.test(value) ? value : undefined;
}
function candidate(row: RecordValue, selector: Selector) {
  const carId = upstreamCarId(row);
  if (!carId) return undefined;
  const year = Number(row.year);
  const make = text(row.make);
  const model = text(row.model);
  if (year && year !== selector.year) return undefined;
  if (make && make.toLocaleLowerCase() !== selector.make.toLocaleLowerCase()) return undefined;
  if (model && model.toLocaleLowerCase() !== selector.model.toLocaleLowerCase()) return undefined;
  const configuration = text(row.engine || row.configuration || row.description);
  const label = `${selector.year} ${make || selector.make} ${model || selector.model}${configuration ? ` ${configuration}` : ""}`.slice(0, 512);
  const configurationMatch = !!selector.configuration && configuration.toLocaleLowerCase().includes(selector.configuration.toLocaleLowerCase());
  return { opaque_ref: vehicleRef(carId), label, confidence: configurationMatch ? 1 : 0.8, evidence: ["year, make, and model matched source catalog", ...(configurationMatch ? ["configuration matched"] : [])] };
}
function articleFromRow(row: RecordValue, carId: string, upstreamOrigin: string): Article | undefined {
  const link = object(object(row._links)?.self);
  const href = text(link?.href);
  if (!href) return undefined;
  let path: string;
  try { path = contentPath(href, carId, upstreamOrigin); }
  catch { return undefined; }
  const display = text(row.display);
  const title = (text(row.title || row.name) || display.split(">>").at(-1)?.trim() || "").slice(0, 1000);
  if (!title) return undefined;
  const ref = resourceRef(path);
  const category = text(object(row.itypeCategory)?.name).slice(0, 256);
  const component = display.includes(">>") ? display.split(">>")[0].trim().slice(0, 256) : "";
  return { opaque_ref: ref, title, ...(category ? { category } : {}), ...(component ? { component } : {}), resource_ref: ref, ...(category.toLowerCase().includes("labor") ? { labor_resource_ref: ref } : {}) };
}
function searchRows(data: unknown): RecordValue[] {
  const root = object(data);
  const embedded = object(root?._embedded);
  const nested = object(embedded?.data);
  if (Array.isArray(nested?.results)) return (nested.results as unknown[]).map(object).filter((item): item is RecordValue => item !== undefined);
  if (Array.isArray(root?.results)) return (root.results as unknown[]).map(object).filter((item): item is RecordValue => item !== undefined);
  return malformed();
}
function parseSelector(value: unknown): Selector {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["year", "make", "model", "configuration", "region", "vin"].includes(key))) invalid("Invalid vehicle selector");
  const selector: Selector = { year: cleanYear(input.year), make: cleanSegment(input.make, "make"), model: cleanSegment(input.model, "model") };
  for (const [key, max] of [["configuration", 512], ["region", 64], ["vin", 32]] as const) {
    if (input[key] !== undefined) selector[key] = cleanSegment(input[key], key, max);
  }
  return selector;
}
function asQuery(request: FastifyRequest): RecordValue { return object(request.query) || {}; }
function onlyKeys(value: RecordValue, allowed: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Unsupported query parameter"); }
function boundedArticles(items: Article[]): Article[] {
  if (items.length > 100_000) throw new ConnectorError("upstream_response_too_large", "Source article index exceeds size limit", 502);
  return [...new Map(items.map((item) => [item.opaque_ref, item])).values()].sort((a, b) => a.title.localeCompare(b.title) || a.opaque_ref.localeCompare(b.opaque_ref));
}

export function registerSourceContractRoutes(app: FastifyInstance, deps: Dependencies) {
  const guard = (request: FastifyRequest, reply: FastifyReply) => rateLimit(request, deps.config, app.rateLimitWindows, reply);
  const schema = (summary: string) => ({ schema: { tags: ["Source Connector v1"], summary, response: { 200: { description: "Banktwo Source Connector v1 response" } } } });
  app.get("/v1/capabilities", schema("Discover supported source operations"), async (request, reply) => {
    guard(request, reply);
    reply.header("x-request-id", request.id);
    return { ...envelope(request), capabilities: ["catalog", "vehicle_resolution", "article_list", "article_search", "resource_read"] };
  });
  app.get("/v1/catalog/:scope", schema("Read a bounded catalog page"), async (request, reply) => {
    guard(request, reply);
    const scope = text((request.params as RecordValue).scope);
    const query = asQuery(request);
    onlyKeys(query, ["year", "make", "model", "cursor"]);
    const year = scope === "years" ? undefined : cleanYear(query.year);
    const make = scope === "models" || scope === "configurations" ? cleanSegment(query.make, "make") : undefined;
    const model = scope === "configurations" ? cleanSegment(query.model, "model") : undefined;
    const path = scope === "years" ? "/api/v1/fleet/years"
      : scope === "makes" ? `/api/v1/fleet/years/${year}/makes`
      : scope === "models" ? `/api/v1/fleet/years/${year}/makes/${encoded(make!)}/models`
      : scope === "configurations" ? `/api/v1/fleet/years/${year}/makes/${encoded(make!)}/models/${encoded(model!)}/engines`
      : invalid("Unsupported catalog scope");
    const key = `${scope}:${year || ""}:${make || ""}:${model || ""}`;
    const offset = cursorOffset(query.cursor, key);
    const { data, source } = await readJson(deps, path, 900);
    const items = list(data).map((row) => {
      const label = text(row.year || row.make || row.model || row.engine);
      if (!label) return undefined;
      const carId = upstreamCarId(row);
      const opaque_ref = carId ? vehicleRef(carId) : `c.${createHash("sha256").update(`${key}:${label}`).digest("hex")}`;
      return { opaque_ref, label: label.slice(0, 512), ...(year || scope === "years" ? { year: Number(row.year || year) } : {}), ...(make || scope === "makes" ? { make: text(row.make || make) } : {}), ...(model || scope === "models" ? { model: text(row.model || model) } : {}), ...(scope === "configurations" ? { configuration: label.slice(0, 512) } : {}) };
    }).filter((item): item is NonNullable<typeof item> => item !== undefined);
    const result = page(items, offset, key);
    reply.header("x-request-id", request.id);
    return { ...envelope(request, source), scope, complete: result.complete, ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}), items: result.items };
  });
  app.post("/v1/vehicle-resolutions", schema("Resolve a vehicle selector without silent selection"), async (request, reply) => {
    guard(request, reply);
    const selector = parseSelector(request.body);
    const query = `${selector.year} ${selector.make} ${selector.model}`;
    const { data, source } = await readJson(deps, `/api/v1/fleet/search/${encoded(query)}`, 900);
    const candidates = [...new Map(list(data).map((row) => candidate(row, selector)).filter((item): item is NonNullable<typeof item> => item !== undefined).map((item) => [item.opaque_ref, item])).values()];
    if (candidates.length > 100) throw new ConnectorError("upstream_response_too_large", "Vehicle resolution exceeds candidate limit", 502);
    reply.header("x-request-id", request.id);
    return { ...envelope(request, source), selector, candidates };
  });
  app.get("/v1/vehicles/:opaqueRef/articles", schema("List all source article headings for a vehicle"), async (request, reply) => {
    guard(request, reply);
    const carId = carIdFromRef((request.params as RecordValue).opaqueRef);
    const query = asQuery(request);
    onlyKeys(query, ["cursor"]);
    const key = `articles:${carId}`;
    const offset = cursorOffset(query.cursor, key);
    const results = await Promise.all([...indexTerms].map((term) => readJson(deps, `/api/v1/content/carids/${carId}/search/${term}`, 86_400)));
    const articles = boundedArticles(results.flatMap(({ data }) => searchRows(data).map((row) => articleFromRow(row, carId, deps.config.upstreamBaseUrl)).filter((item): item is Article => item !== undefined)));
    const result = page(articles, offset, key);
    const digest = createHash("sha256").update(results.map((item) => item.source.sha256).join(":"), "utf8").digest("hex");
    reply.header("x-request-id", request.id);
    return { ...envelope(request), source_revision: digest, complete: result.complete, ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}), articles: result.items };
  });
  app.post("/v1/vehicles/:opaqueRef/article-search", schema("Search vehicle article headings"), async (request, reply) => {
    guard(request, reply);
    const carId = carIdFromRef((request.params as RecordValue).opaqueRef);
    const body = object(request.body);
    if (!body) invalid("Invalid article search body");
    onlyKeys(body, ["query", "cursor"]);
    const term = cleanSegment(body.query, "query", 512);
    const key = `search:${carId}:${term}`;
    const offset = cursorOffset(body.cursor, key);
    const { data, source } = await readJson(deps, `/api/v1/content/carids/${carId}/search/${encoded(term)}`, 86_400);
    const articles = boundedArticles(searchRows(data).map((row) => articleFromRow(row, carId, deps.config.upstreamBaseUrl)).filter((item): item is Article => item !== undefined));
    const result = page(articles, offset, key);
    reply.header("x-request-id", request.id);
    return { ...envelope(request, source), complete: result.complete, ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}), articles: result.items };
  });
  app.get("/v1/resources/:opaqueRef", schema("Read a selected text or binary resource"), async (request, reply) => {
    guard(request, reply);
    const path = pathFromResourceRef((request.params as RecordValue).opaqueRef);
    const source = await deps.upstream.read(path, "application/json,image/*,application/octet-stream", 3600);
    const media_type = source.contentType.split(";")[0].trim().toLowerCase();
    if (!media_type || media_type.length > 128) return malformed();
    const provenance = envelope(request, source);
    reply.header("x-request-id", request.id)
      .header("x-provider", "banktwo")
      .header("x-source-revision", provenance.source_revision)
      .header("x-fetched-at", provenance.fetched_at)
      .header("x-source-locator", source.sourceUri)
      .header("x-source-sha256", source.sha256)
      .header("x-source-media-type", media_type)
      .header("cache-control", "no-store");
    if (media_type.startsWith("image/") || media_type === "application/octet-stream" || media_type === "application/pdf") {
      return { ...provenance, kind: "asset", media_type, content_base64: source.body.toString("base64"), sha256: source.sha256 };
    }
    if (!media_type.startsWith("text/") && media_type !== "application/json") return malformed();
    const content = source.body.toString("utf8");
    if (media_type === "application/json") {
      const value = sourceJson(source);
      const carId = /^\/api\/v1\/content\/carids\/(\d+)/.exec(path)?.[1];
      const responseCarId = text(object(object(value)?.car)?.id);
      if (!carId || responseCarId !== carId) return malformed();
      const embedded = object(object(object(value)?._embedded)?.data);
      if (!object(embedded?.article) && !object(embedded?.partsAndLabor)) return malformed();
      const kind = object(embedded?.partsAndLabor) ? "labor" : "article";
      return { ...provenance, kind, media_type, content, sha256: source.sha256 };
    }
    return { ...provenance, kind: "text", media_type, content, sha256: source.sha256 };
  });
}
