import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";
import { UpstreamClient } from "./upstream-client.js";

type Dependencies = { config: Config; upstream: UpstreamClient };
type Window = { start: number; count: number };
const year = (value: unknown) => { const text = String(value ?? ""); if (!/^\d{4}$/.test(text) || Number(text) < 1886 || Number(text) > 2100) throw new ConnectorError("invalid_request", "year must be a valid four-digit vehicle year", 400); return text; };
const id = (value: unknown, name: string) => { const text = String(value ?? ""); if (!/^\d{1,20}$/.test(text)) throw new ConnectorError("invalid_request", `${name} must be numeric`, 400); return text; };
const segment = (value: unknown, name: string) => { const text = String(value ?? "").trim(); if (!text || text.length > 256 || /[\u0000-\u001f]/.test(text)) throw new ConnectorError("invalid_request", `${name} is invalid`, 400); return encodeURIComponent(text); };

function rateLimit(request: FastifyRequest, config: Config, windows: Map<string, Window>, reply: FastifyReply) {
  const key = request.ip || "unknown";
  const now = Date.now();
  let state = windows.get(key);
  if (!state || now - state.start >= config.clientRateWindowSeconds * 1000) state = { start: now, count: 0 };
  state.count += 1;
  windows.set(key, state);
  if (state.count > config.maxClientRequestsPerWindow) {
    reply.header("retry-after", String(Math.max(1, Math.ceil((state.start + config.clientRateWindowSeconds * 1000 - now) / 1000))));
    throw new ConnectorError("client_rate_limited", "Caller request rate exceeded; request was not sent upstream", 429);
  }
}

async function send(request: FastifyRequest, reply: FastifyReply, deps: Dependencies, path: string, binary = false) {
  rateLimit(request, deps.config, reply.server.rateLimitWindows, reply);
  const result = await deps.upstream.read(path, binary ? "image/*,application/octet-stream" : "application/json", binary ? 3600 : undefined);
  reply.header("x-source-uri", result.sourceUri).header("x-content-sha256", result.sha256).header("cache-control", "no-store");
  if (binary) return reply.type(result.contentType).send(result.body);
  try { return reply.type("application/json; charset=utf-8").send(JSON.parse(result.body.toString("utf8"))); }
  catch { throw new ConnectorError("upstream_error", "AutoAPItwo returned invalid JSON", 502, result.status); }
}

declare module "fastify" { interface FastifyInstance { rateLimitWindows: Map<string, Window> } }

export function registerRoutes(app: FastifyInstance, deps: Dependencies) {
  app.decorate("rateLimitWindows", new Map<string, Window>());
  const route = (url: string, summary: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => app.get(url, { schema: { tags: [url.includes("content") ? "Articles and assets" : "Vehicle catalog"], summary, response: { 200: { description: "Read-only AutoAPItwo response" } } } }, handler);
  route("/v1/fleet/years", "List available model years", (req, rep) => send(req, rep, deps, "/api/v1/fleet/years"));
  route("/v1/fleet/years/:year/makes", "List makes for a model year", (req, rep) => send(req, rep, deps, `/api/v1/fleet/years/${year((req.params as any).year)}/makes`));
  route("/v1/fleet/years/:year/makes/:make/models", "List models for a year and make", (req, rep) => { const p = req.params as any; return send(req, rep, deps, `/api/v1/fleet/years/${year(p.year)}/makes/${segment(p.make, "make")}/models`); });
  route("/v1/fleet/years/:year/makes/:make/models/:model/engines", "List configurations for a year, make, and model", (req, rep) => { const p = req.params as any; return send(req, rep, deps, `/api/v1/fleet/years/${year(p.year)}/makes/${segment(p.make, "make")}/models/${segment(p.model, "model")}/engines`); });
  route("/v1/fleet/carids/:carId", "Get a provider vehicle by its AutoAPItwo car ID", (req, rep) => send(req, rep, deps, `/api/v1/fleet/carids/${id((req.params as any).carId, "carId")}`));
  route("/v1/fleet/search/:query", "Search the AutoAPItwo vehicle catalog", (req, rep) => send(req, rep, deps, `/api/v1/fleet/search/${segment((req.params as any).query, "query")}`));
  route("/v1/fleet/resource", "Read an allowlisted fleet resource path", (req, rep) => {
    const query = req.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== "path")) throw new ConnectorError("invalid_request", "Unsupported query parameter", 400);
    const path = String(query.path || "");
    const allowed = /^\/api\/v1\/fleet\/(?:years|years\/\d{4}\/makes|years\/\d{4}\/makes\/[^/?#]+\/models|years\/\d{4}\/makes\/[^/?#]+\/models\/[^/?#]+\/engines|carids\/\d+|search\/[^/?#]+)$/;
    if (!allowed.test(path)) throw new ConnectorError("invalid_request", "Fleet resource path is not allowlisted", 400);
    return send(req, rep, deps, path);
  });
  route("/v1/content/carids/:carId/search/:term", "Search article headings and links for a vehicle", (req, rep) => { const p = req.params as any; return send(req, rep, deps, `/api/v1/content/carids/${id(p.carId, "carId")}/search/${segment(p.term, "term")}`); });
  route("/v1/content/carids/:carId/resource", "Read an article or asset under one vehicle's content namespace", (req, rep) => {
    const carId = id((req.params as any).carId, "carId");
    const query = req.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => !["path", "binary"].includes(key))) throw new ConnectorError("invalid_request", "Unsupported query parameter", 400);
    const path = String(query.path || "");
    const prefix = `/api/v1/content/carids/${carId}/`;
    if (!path.startsWith(prefix) || path.length > 2048 || path.includes("\\") || /%2f|%5c|%2e/i.test(path) || path.split("/").some((part) => part === "." || part === "..")) throw new ConnectorError("invalid_request", "resource path must remain within the requested vehicle content", 400);
    return send(req, rep, deps, path, query.binary === "true");
  });
}
