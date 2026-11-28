import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { Parser } from "htmlparser2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";
import { rewriteUpstreamLinks } from "./public-links.js";
import { rateLimit } from "./routes.js";
import { UpstreamClient, type UpstreamResponse } from "./upstream-client.js";

export type ArticleIndexCache = {
  get: (key: string) => Promise<unknown>;
  remember: (key: string, value: string, ttlSeconds: number) => void;
};
type Dependencies = { config: Config; upstream: UpstreamClient; articleIndexCache?: ArticleIndexCache };
type RecordValue = Record<string, unknown>;
type Selector = { year: number; make: string; model: string; configuration?: string; region?: string; vin?: string };
type Article = { opaque_ref: string; title: string; category?: string; component?: string; resource_ref: string; labor_resource_ref?: string; asset_resource_refs?: string[] };
type ArticleIndex = { articles: Article[]; legacyRevision: string; expiresAt: number };
const revision = "banktwo-fleet-v1";
const indexTerms = "abcdefghijklmnopqrstuvwxyz0123456789";
// Numeric searches often take longer. Start them alongside the letter searches.
const indexReadOrder = "a1b2c3d4e5f6g7h8i9j0klmnopqrstuvwxyz";
const articleIndexTtlSeconds = 86_400;
const articleIndexCacheBytes = 1_900_000;
const articleIndexSnapshotBytes = 16 * 1024 * 1024;
const articleIndexCacheReadMs = 150;
const zipIndex = promisify(gzip);
const unzipIndex = promisify(gunzip);
const pageSize = 100;
const articleContinuationSize = 500;
const articleContinuationBytes = 3 * 1024 * 1024;
const articlePagePreference = `max-page-size=${articleContinuationSize}`;
const vehicleSvgPath = /^\/api\/v1\/content\/carids\/\d{1,20}\/svgs\/[^/]+$/;
const vehicleGuidPath = /^\/api\/v1\/content\/carids\/(\d{1,20})\/guid\/([A-Za-z0-9_-]{1,160})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const resourceAccept = "application/json,image/*,application/octet-stream,application/pdf";

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
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function mediaType(source: UpstreamResponse): string {
  return source.contentType.split(";")[0].trim().toLowerCase();
}
function isJsonResource(source: UpstreamResponse): boolean {
  return ["application/json", "application/hal+json"].includes(mediaType(source));
}
function encoded(value: string): string { return encodeURIComponent(value); }
function signRef(prefix: string, payload: string, secret: string): string {
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`banktwo-${prefix}-ref-v1\\0`).update(encodedPayload).digest("base64url");
  return `${prefix}.${encodedPayload}.${signature}`;
}
function verifyRef(value: unknown, prefix: string, secret: string): string {
  const match = new RegExp(`^${prefix}\\.([A-Za-z0-9_-]{1,1870})\\.([A-Za-z0-9_-]{43})$`).exec(text(value));
  if (!match) invalid("Invalid source reference");
  const expected = createHmac("sha256", secret).update(`banktwo-${prefix}-ref-v1\\0`).update(match[1]).digest();
  const supplied = Buffer.from(match[2], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid("Invalid source reference");
  try { return Buffer.from(match[1], "base64url").toString("utf8"); }
  catch { return invalid("Invalid source reference"); }
}
function vehicleRef(carId: string, secret: string): string { return signRef("v", carId, secret); }
function carIdFromRef(value: unknown, secret: string): string {
  const carId = verifyRef(value, "v", secret);
  if (!/^\d{1,20}$/.test(carId)) invalid("Invalid vehicle reference");
  return carId;
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
function groupedModelSearchTerm(model: string): string | undefined {
  const names = model.split("/").map((name) => name.trim());
  if (names.length < 2 || names.some((name) => !/^[\p{L}\p{N}][\p{L}\p{N} .()'+_-]*$/u.test(name))) return undefined;
  return names.join(" ");
}
function fleetSearchPath(year: number, make: string, model: string): string {
  return `/api/v1/fleet/search/${encoded(`${year} ${make} ${groupedModelSearchTerm(model) ?? model}`)}`;
}
function contentPath(value: string, carId?: string, upstreamOrigin = "https://banktwo.invalid"): string {
  let path: string;
  try {
    const parsed = new URL(value, upstreamOrigin);
    if (parsed.origin !== upstreamOrigin || parsed.username || parsed.password || parsed.hash) invalid("Invalid resource origin or fragment");
    if (parsed.search) {
      const entries = [...parsed.searchParams];
      const localizedPath = /^\/api\/v1\/content\/carids\/\d{1,20}\/(?:components|thumbnails)\/[^/]+(?:\/[^/]+)*$/.test(parsed.pathname)
        || vehicleSvgPath.test(parsed.pathname);
      if (!localizedPath || parsed.search.length > 128 || new Set(entries.map(([key]) => key)).size !== entries.length
        || entries.some(([key, value]) => !["locale", "region"].includes(key) || !/^[A-Za-z0-9_-]{1,32}$/.test(value))) invalid("Resource query parameters are not supported");
    }
    path = parsed.pathname + parsed.search;
  } catch { return invalid("Invalid resource reference"); }
  const pathname = path.split("?", 1)[0];
  const match = /^\/api\/v1\/content\/carids\/(\d{1,20})\/(.+)$/.exec(pathname);
  if (!match || path.length > 1400 || (carId && match[1] !== carId) || /%2f|%5c|%2e/i.test(pathname) || pathname.includes("\\") || pathname.split("/").some((part) => part === "." || part === "..")) invalid("Resource is outside the selected vehicle");
  return path;
}
function resourceRef(path: string, secret: string): string {
  return signRef("r", contentPath(path), secret);
}
function pathFromResourceRef(ref: unknown, secret: string): string {
  return contentPath(verifyRef(ref, "r", secret));
}
function cursorOffset(cursor: unknown, key: string, sourceRevision: string, legacyRevision = sourceRevision): number {
  if (cursor === undefined) return 0;
  const raw = text(cursor);
  if (!/^p\.[A-Za-z0-9_-]{1,510}$/.test(raw)) invalid("Invalid page cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw.slice(2), "base64url").toString("utf8")); }
  catch { return invalid("Invalid page cursor"); }
  const parsed = object(value);
  if (parsed?.key !== cursorKey(key) || (parsed.revision !== sourceRevision && parsed.revision !== legacyRevision) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > 100_000) invalid("Invalid page cursor");
  return Number(parsed.offset);
}
function cursorKey(key: string): string { return createHash("sha256").update(key).digest("hex"); }
function nextCursor(key: string, offset: number, sourceRevision: string): string { return `p.${Buffer.from(JSON.stringify({ key: cursorKey(key), offset, revision: sourceRevision })).toString("base64url")}`; }
function page<T>(items: T[], offset: number, key: string, sourceRevision: string, limit = pageSize) {
  const slice = items.slice(offset, offset + limit);
  const complete = offset + slice.length >= items.length;
  return { complete, ...(complete ? {} : { next_cursor: nextCursor(key, offset + slice.length, sourceRevision) }), items: slice };
}
function publicLocator(deps: Dependencies, sourceUri: string): string {
  return rewriteUpstreamLinks(JSON.stringify(sourceUri), deps.config.upstreamBaseUrl, deps.config.publicBaseUrl).slice(1, -1);
}
function envelope(request: FastifyRequest, deps?: Dependencies, result?: UpstreamResponse) {
  return {
    request_id: request.id,
    provider: "banktwo" as const,
    source_revision: result?.sha256 || revision,
    fetched_at: new Date().toISOString(),
    ...(result && deps ? { source_locator: publicLocator(deps, result.sourceUri) } : {}),
  };
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
function groupedConfigurations(data: unknown, rows: RecordValue[], year: number, make: string, model: string): RecordValue[] {
  const result = object(data);
  if (result?.count !== rows.length || object(result._links)?.next) return malformed();
  const matches = rows.filter(row => Number(row.year) === year && text(row.make).toLowerCase() === make.toLowerCase()
    && text(row.model).toLowerCase() === model.toLowerCase());
  if (matches.length === 0) throw new ConnectorError("not_found", "No matching source configurations", 404);
  if (matches.some(row => !upstreamCarId(row) || !text(row.engine))) return malformed();
  return matches;
}
function candidate(row: RecordValue, selector: Selector, secret: string) {
  const carId = upstreamCarId(row);
  if (!carId) return undefined;
  const year = Number(row.year);
  const make = text(row.make);
  const model = text(row.model);
  if (!Number.isInteger(year) || year !== selector.year || !make || !model) return undefined;
  if (make.toLocaleLowerCase() !== selector.make.toLocaleLowerCase()) return undefined;
  if (model.toLocaleLowerCase() !== selector.model.toLocaleLowerCase()) return undefined;
  const configuration = text(row.engine || row.configuration || row.description);
  if (selector.configuration && (!configuration || !configuration.toLocaleLowerCase().includes(selector.configuration.toLocaleLowerCase()))) return undefined;
  const region = text(row.region || row.market);
  if (selector.region && (!region || region.toLocaleLowerCase() !== selector.region.toLocaleLowerCase())) return undefined;
  const vin = text(row.vin || row.VIN);
  if (selector.vin && (!vin || vin.toLocaleLowerCase() !== selector.vin.toLocaleLowerCase())) return undefined;
  const label = `${selector.year} ${make || selector.make} ${model || selector.model}${configuration ? ` ${configuration}` : ""}`.slice(0, 512);
  const configurationMatch = !!selector.configuration && configuration.toLocaleLowerCase().includes(selector.configuration.toLocaleLowerCase());
  return { opaque_ref: vehicleRef(carId, secret), label, confidence: configurationMatch ? 1 : 0.8, evidence: ["year, make, and model matched source catalog", ...(configurationMatch ? ["configuration matched"] : [])] };
}
function articleFromRow(
  row: RecordValue, carId: string, upstreamOrigin: string, secret: string, signedRefs?: Map<string, string>,
): Article | undefined {
  const link = object(object(row._links)?.self);
  const href = text(link?.href);
  if (!href) return undefined;
  let ref = signedRefs?.get(href);
  if (ref === undefined) {
    try { ref = resourceRef(contentPath(href, carId, upstreamOrigin), secret); }
    catch { return malformed(); }
    signedRefs?.set(href, ref);
  }
  const display = text(row.display);
  const title = (text(row.title || row.name) || display.split(">>").at(-1)?.trim() || "").slice(0, 1000);
  if (!title) return undefined;
  const category = text(object(row.itypeCategory)?.name).slice(0, 256);
  const component = display.includes(">>") ? display.split(">>")[0].trim().slice(0, 256) : "";
  return { opaque_ref: ref, title, ...(category ? { category } : {}), ...(component ? { component } : {}), resource_ref: ref, ...(category.toLowerCase().includes("labor") ? { labor_resource_ref: ref } : {}) };
}
function markupField(article?: RecordValue): string | undefined {
  const structured = [article?.blocks, article?.steps].some(rows => Array.isArray(rows) && rows.length > 0);
  return (structured ? ["content"] : ["body", "text", "content", "html"]).find(name => {
    const candidate = article?.[name];
    return typeof candidate === "string" && candidate.trim();
  });
}
function legacyGuidArticle(value: unknown, path: string, carId: string) {
  const match = vehicleGuidPath.exec(path);
  const root = object(value);
  const embedded = object(root?._embedded);
  const data = object(embedded?.data);
  const rootCar = object(root?.car);
  const title = typeof root?.title === "string" ? root.title.trim() : "";
  if (match?.[1] !== carId || root?.id !== match[2] || text(object(embedded?.car)?.id) !== carId
      || (root?.car !== undefined && text(rootCar?.id) !== carId) || !title || title.length > 1000
      || !data || data.article !== undefined || data.partsAndLabor !== undefined
      || typeof data.content !== "string" || !data.content.trim()) return undefined;
  return { title, data, markup: data.content };
}
function unquoteAuthoredAttribute(value: string): string {
  return value.startsWith('\\"') && value.endsWith('\\"') ? value.slice(2, -2) : value;
}
function authoredGuidPath(href: string, carId: string, origin: string): string | undefined {
  const value = unquoteAuthoredAttribute(href);
  const relative = value.startsWith(origin + "/") ? value.slice(origin.length) : value;
  return vehicleGuidPath.exec(relative)?.[1] === carId ? relative : undefined;
}
function authoredGuidReference(markup: string, pathDigest: string, parent: string, carId: string, origin: string) {
  const suppressed: boolean[] = [];
  let hrefCount = 0;
  let result: string | undefined;
  new Parser({
    onopentagname() { hrefCount = 0; },
    onattribute(name) { if (name === "href") hrefCount++; },
    onopentag(name, attributes) {
      const hidden = Boolean(suppressed.at(-1) || "hidden" in attributes ||
        attributes["aria-hidden"]?.trim().toLowerCase() === "true" || ["template", "noscript"].includes(name));
      suppressed.push(hidden);
      if (hidden || name !== "a" || hrefCount !== 1 || !attributes.href) return;
      const path = authoredGuidPath(attributes.href, carId, origin);
      if (path && path !== parent && digest(path) === pathDigest) result = path;
    },
    onclosetag() { suppressed.pop(); },
  }, { decodeEntities: true }).end(markup);
  return result;
}
function assetResources(value: unknown, carId: string, origin: string, secret: string, article?: RecordValue, legacy = false) {
  const refs = new Set<string>();
  const bindings = new Map<string, { source_url: string; resource_ref: string }>();
  const standaloneHtml = typeof value === "string";
  const authoredField = markupField(article);
  const declare = (path: string, sourceUrl?: string) => {
    const ref = resourceRef(path, secret);
    if (!refs.has(ref) && refs.size >= 128) return;
    refs.add(ref);
    if (sourceUrl && sourceUrl.length <= 2048 && bindings.size < 128) bindings.set(sourceUrl, { source_url: sourceUrl, resource_ref: ref });
  };
  const addImage = (sourceUrl: string, bind = false, authoredImage = false) => {
    const knownImage = !standaloneHtml && (
      /\.(?:png|jpe?g|gif|svg|webp|bmp|tiff?)(?:$|[?#])/i.test(sourceUrl)
      || /\/(?:images|graphics|thumbnails)\//i.test(sourceUrl)
    );
    if (!knownImage && !authoredImage) return;
    try {
      const path = contentPath(legacy && authoredImage ? unquoteAuthoredAttribute(sourceUrl) : sourceUrl, carId, origin);
      const svgPath = vehicleSvgPath.test(path.split("?", 1)[0]);
      // Localized, extensionless SVGs are bound only from the authored image tag.
      if (!(authoredImage && svgPath) && (!knownImage || (svgPath && path.includes("?")))) return;
      declare(path, bind ? sourceUrl : undefined);
    } catch { /* Ignore images outside the selected source vehicle or query allowlist. */ }
  };
  const addDocument = (sourceUrl: string, mediaType: string, anchor: boolean) => {
    if (sourceUrl.length > 2048 || /[\u0000-\u001f\u007f-\u009f\\]/.test(sourceUrl) || bindings.size >= 128 ||
        (mediaType && mediaType !== "application/pdf")) return;
    try {
      const path = contentPath(sourceUrl, carId, origin);
      const pathname = path.split("?", 1)[0];
      const document = /\/(?:documents|attachments|pdfs)\//i.test(pathname);
      const asset = /\/(?:assets|images|graphics|thumbnails)\//i.test(pathname);
      // Untyped anchors in generic asset namespaces must explicitly name a PDF.
      if (document || (asset && (!anchor || mediaType === "application/pdf" || /\.pdf$/i.test(pathname)))) {
        declare(path, sourceUrl);
      }
    } catch { /* Ignore documents outside the selected source vehicle or query allowlist. */ }
  };
  const visit = (item: unknown, depth: number, documentText = false) => {
    if (depth > 12 || refs.size >= 128) return;
    if (typeof item === "string") {
      // Attribute parsing decodes HTML entities without changing the raw content.
      const attributesSeen = new Set<string>();
      const duplicates = new Set<string>();
      const hidden: boolean[] = [];
      const parser = new Parser({
        onopentagname() { attributesSeen.clear(); duplicates.clear(); },
        onattribute(name) {
          if (!documentText) return;
          if (attributesSeen.has(name)) duplicates.add(name);
          attributesSeen.add(name);
        },
        onopentag(name, attributes) {
          const suppressed = Boolean(hidden.at(-1) || "hidden" in attributes || duplicates.has("aria-hidden") ||
            attributes["aria-hidden"]?.trim().toLowerCase() === "true" || ["template", "noscript"].includes(name));
          if (name === "img" && attributes.src) {
            addImage(attributes.src, true, documentText && !suppressed && !duplicates.has("src"));
          }
          if (!documentText) return;
          hidden.push(suppressed);
          if (suppressed || duplicates.has("type") || (name === "iframe" && "srcdoc" in attributes)) return;
          const attribute = name === "a" ? "href" : name === "object" ? "data" : name === "iframe" || name === "embed" ? "src" : "";
          if (attribute && attributes[attribute] && !duplicates.has(attribute)) {
            addDocument(attributes[attribute], attributes.type?.trim().toLowerCase() || "", name === "a");
          }
        },
        onclosetag() { if (documentText) hidden.pop(); },
      }, { decodeEntities: true });
      parser.end(item);
      if (!standaloneHtml) {
        const linkedPaths = item.match(/(?:https?:\/\/[^"'\s<>]+)?\/api\/v1\/content\/carids\/\d{1,20}\/[^"'\s<>]+/gi) || [];
        for (const link of linkedPaths) addImage(link);
      }
      return;
    }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    const record = object(item);
    if (record) for (const [name, child] of Object.entries(record)) {
      visit(child, depth + 1, record === article && name === authoredField);
    }
  };
  visit(value, 0, standaloneHtml);
  return { ...(refs.size ? { asset_resource_refs: [...refs] } : {}), ...(bindings.size ? { asset_bindings: [...bindings.values()] } : {}) };
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

async function readCachedArticleIndex(cache: ArticleIndexCache, key: string): Promise<ArticleIndex | undefined> {
  let cancelTimeout: (() => void) | undefined;
  try {
    const value = await Promise.race([
      cache.get(key),
      new Promise<undefined>(resolve => {
        const timeout = setTimeout(() => resolve(undefined), articleIndexCacheReadMs);
        cancelTimeout = () => clearTimeout(timeout);
      }),
    ]);
    if (typeof value !== "string" || Buffer.byteLength(value) > articleIndexCacheBytes) return;
    const json = value.startsWith("gz:")
      ? (await unzipIndex(Buffer.from(value.slice(3), "base64"), { maxOutputLength: articleIndexSnapshotBytes })).toString("utf8")
      : value;
    const index = JSON.parse(json) as Partial<ArticleIndex> | null;
    if (!index || !Array.isArray(index.articles) || typeof index.legacyRevision !== "string"
        || !sha256Pattern.test(index.legacyRevision)
        || typeof index.expiresAt !== "number" || !Number.isSafeInteger(index.expiresAt)
        || index.expiresAt <= Date.now()) return;
    return index as ArticleIndex;
  } catch {
    return;
  } finally {
    cancelTimeout?.();
  }
}

async function rememberArticleIndex(cache: ArticleIndexCache, key: string, index: ArticleIndex) {
  try {
    const json = JSON.stringify(index);
    if (Buffer.byteLength(json) > articleIndexSnapshotBytes) return;
    const value = Buffer.byteLength(JSON.stringify(json)) <= articleIndexCacheBytes
      ? json : "gz:" + (await zipIndex(json, { level: 3 })).toString("base64");
    // Compute the TTL after compression so the cache cannot extend an older search response.
    const ttl = Math.floor((index.expiresAt - Date.now()) / 1000);
    if (ttl > 0 && Buffer.byteLength(value) <= articleIndexCacheBytes) cache.remember(key, value, ttl);
  } catch {
    // The source index is still available if the cache write cannot be prepared or scheduled.
  }
}

async function readArticleIndex(deps: Dependencies, carId: string) {
  const cache = deps.articleIndexCache;
  const { upstreamBaseUrl, opaqueRefSecret } = deps.config;
  const cacheKey = cache && "article-index-v2:" + createHmac("sha256", opaqueRefSecret)
    .update(JSON.stringify([upstreamBaseUrl, carId, indexTerms])).digest("hex");
  if (cache && cacheKey) {
    const index = await readCachedArticleIndex(cache, cacheKey);
    if (index) return { index, cacheHit: true };
  }
  const signedRefs = new Map<string, string>();
  const results = await Promise.all([...indexReadOrder].map(async term => {
    const { data, source } = await readJson(deps, `/api/v1/content/carids/${carId}/search/${term}`, articleIndexTtlSeconds);
    const order = indexTerms.indexOf(term);
    // Normalize each response while the remaining searches are running.
    try {
      const articles = searchRows(data)
        .map(row => articleFromRow(row, carId, upstreamBaseUrl, opaqueRefSecret, signedRefs))
        .filter((item): item is Article => item !== undefined);
      return { order, source, articles };
    } catch (error) {
      return { order, source, error };
    }
  }));
  // Preserve canonical duplicate selection and the revision used by legacy cursors.
  results.sort((a, b) => a.order - b.order);
  const articles = boundedArticles(results.flatMap(result => {
    if (!result.articles) throw result.error;
    return result.articles;
  }));
  const index = {
    articles,
    legacyRevision: digest(results.map(({ source }) => source.sha256).join(":")),
    expiresAt: Math.min(...results.map(({ source }) => source.expiresAt)),
  };
  if (cache && cacheKey) await rememberArticleIndex(cache, cacheKey, index);
  return { index, cacheHit: false };
}

function continuationLimit(articles: Article[], offset: number): number {
  let bytes = 2; // Array brackets, with room outside the budget for the response envelope.
  let count = 0;
  for (const article of articles.slice(offset, offset + articleContinuationSize)) {
    bytes += Buffer.byteLength(JSON.stringify(article)) + (count ? 1 : 0);
    if (bytes > articleContinuationBytes) break;
    count += 1;
  }
  return count;
}

function articlePage(articles: Article[], key: string, cursor: unknown, legacyRevision: string, batch = false) {
  // Bind pages to the projected article list, which excludes upstream response metadata.
  const revision = createHash("sha256").update(JSON.stringify(articles)).digest("hex");
  const offset = cursorOffset(cursor, key, revision, legacyRevision);
  const result = page(articles, offset, key, revision, batch ? continuationLimit(articles, offset) : pageSize);
  return {
    source_revision: revision,
    complete: result.complete,
    ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
    articles: result.items,
  };
}

async function resolveAuthoredGuid(request: FastifyRequest, reply: FastifyReply, deps: Dependencies, carId: string, body: RecordValue) {
  onlyKeys(body, ["parent_resource_ref", "markup_sha256", "authored_path_sha256"]);
  const { markup_sha256: markupHash, authored_path_sha256: pathHash } = body;
  if (typeof markupHash !== "string" || !sha256Pattern.test(markupHash) ||
      typeof pathHash !== "string" || !sha256Pattern.test(pathHash)) invalid("Invalid authored reference digest");
  const { opaqueRefSecret: secret, upstreamBaseUrl: origin } = deps.config;
  const parent = contentPath(pathFromResourceRef(body.parent_resource_ref, secret), carId);
  const source = await deps.upstream.read(parent, resourceAccept, 3600);
  if (!isJsonResource(source)) return malformed();
  const value = object(sourceJson(source));
  const modern = object(object(object(value?._embedded)?.data)?.article);
  const field = markupField(modern);
  const markup = field && text(object(value?.car)?.id) === carId ? modern?.[field]
    : legacyGuidArticle(value, parent, carId)?.markup;
  if (typeof markup !== "string" || digest(markup) !== markupHash) invalid("Parent markup did not match");
  const path = authoredGuidReference(markup, pathHash, parent, carId, origin);
  if (!path) throw new ConnectorError("not_found", "The source article did not declare this reference", 404);
  const target = await deps.upstream.read(path, resourceAccept, 3600);
  const article = isJsonResource(target) ? legacyGuidArticle(sourceJson(target), path, carId) : undefined;
  if (!article) return malformed();
  const ref = resourceRef(path, secret);
  reply.header("x-request-id", request.id).header("cache-control", "no-store");
  return { ...envelope(request, deps, target), complete: true,
    articles: [{ opaque_ref: ref, resource_ref: ref, title: article.title }] };
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
    const grouped = model !== undefined && groupedModelSearchTerm(model) !== undefined;
    const path = scope === "years" ? "/api/v1/fleet/years"
      : scope === "makes" ? `/api/v1/fleet/years/${year}/makes`
      : scope === "models" ? `/api/v1/fleet/years/${year}/makes/${encoded(make!)}/models`
      // A slash can belong to the exact listed model. Fleet search accepts its words and returns the original label.
      : grouped ? fleetSearchPath(year!, make!, model!)
      : scope === "configurations" ? `/api/v1/fleet/years/${year}/makes/${encoded(make!)}/models/${encoded(model!)}/engines`
      : invalid("Unsupported catalog scope");
    const key = `${scope}:${year || ""}:${make || ""}:${model || ""}`;
    const { data, source } = await readJson(deps, path, 900);
    const sourceRevision = source.sha256;
    const offset = cursorOffset(query.cursor, key, sourceRevision);
    const rows = list(data);
    const configurations = grouped ? groupedConfigurations(data, rows, year!, make!, model!) : rows;
    const items = configurations.map((row) => {
      const label = text(grouped ? row.engine : row.year || row.make || row.model || row.engine);
      if (!label) return undefined;
      const carId = upstreamCarId(row);
      const opaque_ref = carId ? vehicleRef(carId, deps.config.opaqueRefSecret) : `c.${createHash("sha256").update(`${key}:${label}`).digest("hex")}`;
      return { opaque_ref, label: label.slice(0, 512), ...(year || scope === "years" ? { year: Number(row.year || year) } : {}), ...(make || scope === "makes" ? { make: text(row.make || make) } : {}), ...(model || scope === "models" ? { model: text(row.model || model) } : {}), ...(scope === "configurations" ? { configuration: label.slice(0, 512) } : {}), ...(text(row.engine) ? { engine: text(row.engine).slice(0, 256) } : {}), ...(text(row.drivetrain) ? { drivetrain: text(row.drivetrain).slice(0, 128) } : {}), ...(text(row.region) ? { region: text(row.region).slice(0, 64) } : {}) };
    }).filter((item): item is NonNullable<typeof item> => item !== undefined);
    const result = page(items, offset, key, sourceRevision);
    reply.header("x-request-id", request.id);
    return { ...envelope(request, deps, source), scope, complete: result.complete, ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}), items: result.items };
  });
  app.post("/v1/vehicle-resolutions", schema("Resolve a vehicle selector without silent selection"), async (request, reply) => {
    guard(request, reply);
    const selector = parseSelector(request.body);
    const { data, source } = await readJson(deps, fleetSearchPath(selector.year, selector.make, selector.model), 900);
    const candidates = [...new Map(list(data).map((row) => candidate(row, selector, deps.config.opaqueRefSecret)).filter((item): item is NonNullable<typeof item> => item !== undefined).map((item) => [item.opaque_ref, item])).values()];
    if (candidates.length > 100) throw new ConnectorError("upstream_response_too_large", "Vehicle resolution exceeds candidate limit", 502);
    reply.header("x-request-id", request.id);
    return { ...envelope(request, deps, source), selector, candidates };
  });
  app.get("/v1/vehicles/:opaqueRef/articles", schema("List all source article headings for a vehicle"), async (request, reply) => {
    guard(request, reply);
    const carId = carIdFromRef((request.params as RecordValue).opaqueRef, deps.config.opaqueRefSecret);
    const query = asQuery(request);
    onlyKeys(query, ["cursor"]);
    const key = `articles:${carId}`;
    const started = performance.now();
    const { index, cacheHit } = await readArticleIndex(deps, carId);
    const batch = query.cursor !== undefined && request.headers.prefer === articlePagePreference;
    const result = articlePage(index.articles, key, query.cursor, index.legacyRevision, batch);
    const elapsed = (performance.now() - started).toFixed(1);
    reply.header("x-request-id", request.id).header("vary", "Prefer").header("cache-control", "private, no-store")
      .header("server-timing", `bt-index;dur=${elapsed};desc="${cacheHit ? "runtime cache" : "source lookup"}"`);
    if (batch) reply.header("preference-applied", articlePagePreference);
    return { ...envelope(request), ...result };
  });
  app.post("/v1/vehicles/:opaqueRef/article-search", schema("Search vehicle article headings"), async (request, reply) => {
    guard(request, reply);
    const carId = carIdFromRef((request.params as RecordValue).opaqueRef, deps.config.opaqueRefSecret);
    const body = object(request.body);
    if (!body) invalid("Invalid article search body");
    if ("parent_resource_ref" in body) return resolveAuthoredGuid(request, reply, deps, carId, body);
    onlyKeys(body, ["query", "cursor"]);
    const term = cleanSegment(body.query, "query", 512);
    const key = `search:${carId}:${term}`;
    const { data, source } = await readJson(deps, `/api/v1/content/carids/${carId}/search/${encoded(term)}`, 86_400);
    const articles = boundedArticles(searchRows(data).map((row) => articleFromRow(row, carId, deps.config.upstreamBaseUrl, deps.config.opaqueRefSecret)).filter((item): item is Article => item !== undefined));
    reply.header("x-request-id", request.id);
    return { ...envelope(request, deps, source), ...articlePage(articles, key, body.cursor, source.sha256) };
  });
  app.get("/v1/resources/:opaqueRef", schema("Read a selected text or binary resource"), async (request, reply) => {
    guard(request, reply);
    const path = pathFromResourceRef((request.params as RecordValue).opaqueRef, deps.config.opaqueRefSecret);
    const source = await deps.upstream.read(path, resourceAccept, 3600);
    const media_type = mediaType(source);
    if (!media_type || media_type.length > 128) return malformed();
    const jsonMediaType = isJsonResource(source);
    const provenance = envelope(request, deps, source);
    reply.header("x-request-id", request.id)
      .header("x-provider", "banktwo")
      .header("x-source-revision", provenance.source_revision)
      .header("x-fetched-at", provenance.fetched_at)
      .header("x-source-locator", publicLocator(deps, source.sourceUri))
      .header("x-source-sha256", source.sha256)
      .header("x-source-media-type", media_type)
      .header("cache-control", "no-store");
    if (media_type.startsWith("image/") || media_type === "application/octet-stream" || media_type === "application/pdf") {
      return { ...provenance, kind: "asset", media_type, content_base64: source.body.toString("base64"), sha256: source.sha256 };
    }
    if (!media_type.startsWith("text/") && !jsonMediaType) return malformed();
    const content = source.body.toString("utf8");
    const carId = /^\/api\/v1\/content\/carids\/(\d+)\//.exec(path)?.[1];
    if (jsonMediaType) {
      const value = sourceJson(source);
      if (!carId) return malformed();
      const legacy = legacyGuidArticle(value, path, carId);
      if (legacy) {
        const assets = assetResources(value, carId, deps.config.upstreamBaseUrl, deps.config.opaqueRefSecret, legacy.data, true);
        return { ...provenance, kind: "article", media_type, content, sha256: source.sha256, ...assets };
      }
      if (text(object(object(value)?.car)?.id) !== carId) return malformed();
      const embedded = object(object(object(value)?._embedded)?.data);
      const article = object(embedded?.article);
      if (!article && !object(embedded?.partsAndLabor)) return malformed();
      const kind = object(embedded?.partsAndLabor) ? "labor" : "article";
      const assets = assetResources(value, carId, deps.config.upstreamBaseUrl, deps.config.opaqueRefSecret, article);
      return { ...provenance, kind, media_type, content, sha256: source.sha256, ...assets };
    }
    const assets = media_type === "text/html" && carId ? assetResources(content, carId, deps.config.upstreamBaseUrl, deps.config.opaqueRefSecret) : {};
    return { ...provenance, kind: "text", media_type, content, sha256: source.sha256, ...assets };
  });
}
