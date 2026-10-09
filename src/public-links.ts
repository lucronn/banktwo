/** Rewrite upstream absolute/relative API links to Banktwo public routes. */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteApiPath(pathWithQuery: string, publicOrigin: string): string {
  const url = new URL(pathWithQuery, "https://banktwo.invalid");
  const path = url.pathname;
  const search = url.search;

  if (path.startsWith("/api/v1/fleet/")) {
    return `${publicOrigin}${path.replace(/^\/api\/v1/, "/v1")}${search}`;
  }

  const searchMatch = /^\/api\/v1\/content\/carids\/(\d+)\/search\/([^/]+)$/.exec(path);
  if (searchMatch) {
    return `${publicOrigin}/v1/content/carids/${searchMatch[1]}/search/${searchMatch[2]}${search}`;
  }

  const contentMatch = /^\/api\/v1\/content\/carids\/(\d+)\/.+/.exec(path);
  if (contentMatch) {
    const params = new URLSearchParams();
    params.set("path", path);
    const sourceQuery = url.searchParams.toString();
    if (sourceQuery) params.set("sourceQuery", sourceQuery);
    return `${publicOrigin}/v1/content/carids/${contentMatch[1]}/resource?${params.toString()}`;
  }

  if (path.startsWith("/api/v1/")) {
    return `${publicOrigin}${path.replace(/^\/api\/v1/, "/v1")}${search}`;
  }
  return `${publicOrigin}${path}${search}`;
}

export function rewriteUpstreamLinks(body: string, upstreamOrigin: string, publicBaseUrl: string): string {
  const publicOrigin = new URL(publicBaseUrl).origin;
  const absolute = new RegExp(`${escapeRegExp(upstreamOrigin)}(/api/v1/[^"'\\\\\\s]+)`, "g");
  let rewritten = body.replace(absolute, (_match, path: string) => rewriteApiPath(path, publicOrigin));
  rewritten = rewritten.replace(/(?<=["'])\/api\/v1\/[^"']+/g, (path) => rewriteApiPath(path, publicOrigin));
  // Catch any leftover bare upstream origin (non-/api paths) without inventing routes.
  rewritten = rewritten.split(upstreamOrigin).join(publicOrigin);
  return rewritten;
}

export function assertNoUpstreamLeak(body: string, upstreamOrigin: string): void {
  const host = new URL(upstreamOrigin).host;
  if (body.includes(upstreamOrigin) || body.includes(host)) {
    throw new Error("upstream hostname leaked into public response");
  }
}
