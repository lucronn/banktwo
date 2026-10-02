import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";

export type UpstreamResponse = { status: number; contentType: string; body: Buffer; sourceUri: string; sha256: string };
type CacheValue = { expiresAt: number; response: UpstreamResponse };

export class UpstreamClient {
  private readonly cache = new Map<string, CacheValue>();
  private readonly pending = new Map<string, Promise<UpstreamResponse>>();
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  async read(path: string, accept: string, ttlSeconds = this.config.cacheTtlSeconds): Promise<UpstreamResponse> {
    const url = this.safeUrl(path);
    const key = `${url}\n${accept}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    if (cached) this.cache.delete(key);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.fetchResponse(url, accept).then((response) => {
      this.cache.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, response });
      while (this.cache.size > this.config.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
      return response;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private safeUrl(path: string): string {
    if (!path.startsWith("/api/v1/fleet/") && !path.startsWith("/api/v1/content/carids/")) {
      throw new ConnectorError("invalid_request", "Only vehicle catalog and vehicle content resources are allowed", 400);
    }
    if (path.includes("\\") || /%2f|%5c|%2e/i.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
      throw new ConnectorError("invalid_request", "Invalid upstream resource path", 400);
    }
    const url = new URL(path, this.config.upstreamBaseUrl);
    if (url.origin !== this.config.upstreamBaseUrl) throw new ConnectorError("invalid_request", "Invalid upstream resource origin", 400);
    return url.toString();
  }

  private async fetchResponse(url: string, accept: string): Promise<UpstreamResponse> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new ConnectorError("upstream_timeout", "AutoAPItwo request timed out", 504);
      throw new ConnectorError("upstream_error", "AutoAPItwo could not be reached", 502);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectorError("upstream_error", "AutoAPItwo returned an unexpected redirect", 502, response.status);
    if (!response.ok) throw new ConnectorError("upstream_error", "AutoAPItwo request failed", 502, response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorError("upstream_error", "AutoAPItwo returned an empty response", 502, response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.config.maxResponseBytes) {
          await reader.cancel();
          throw new ConnectorError("upstream_response_too_large", "AutoAPItwo response exceeded the configured size limit", 502, response.status);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks.map((part) => Buffer.from(part)));
    return { status: response.status, contentType: response.headers.get("content-type") || "application/octet-stream", body, sourceUri: url, sha256: createHash("sha256").update(body).digest("hex") };
  }
}
