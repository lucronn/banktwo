import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";

export type UpstreamResponse = { status: number; contentType: string; body: Buffer; sourceUri: string; sha256: string };
type CacheValue = { expiresAt: number; response: UpstreamResponse };

export class UpstreamClient {
  private readonly cache = new Map<string, CacheValue>();
  private readonly pending = new Map<string, Promise<UpstreamResponse>>();
  private cacheBytes = 0;
  private activeRequests = 0;
  private retryAt = 0;
  private readonly requestQueue: Array<() => void> = [];
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  async read(path: string, accept: string, ttlSeconds = this.config.cacheTtlSeconds): Promise<UpstreamResponse> {
    const url = this.safeUrl(path);
    const key = `${url}\n${accept}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    if (cached) { this.cache.delete(key); this.cacheBytes -= cached.response.body.byteLength; }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.fetchResponse(url, accept).then((response) => {
      if (response.body.byteLength <= this.config.maxCacheBytes) {
        this.cache.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, response });
        this.cacheBytes += response.body.byteLength;
        while (this.cache.size > this.config.maxCacheEntries || this.cacheBytes > this.config.maxCacheBytes) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey === undefined) break;
          const evicted = this.cache.get(firstKey);
          this.cache.delete(firstKey);
          if (evicted) this.cacheBytes -= evicted.response.body.byteLength;
        }
      }
      return response;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private safeUrl(path: string): string {
    let url: URL;
    try { url = new URL(path, this.config.upstreamBaseUrl); }
    catch { throw new ConnectorError("invalid_request", "Invalid upstream resource path", 400); }
    if (url.origin !== this.config.upstreamBaseUrl || (!url.pathname.startsWith("/api/v1/fleet/") && !url.pathname.startsWith("/api/v1/content/carids/"))) {
      throw new ConnectorError("invalid_request", "Only vehicle catalog and vehicle content resources are allowed", 400);
    }
    if (url.pathname.includes("\\") || /%2f|%5c|%2e/i.test(url.pathname) || url.pathname.split("/").some((part) => part === "." || part === "..") || url.hash) {
      throw new ConnectorError("invalid_request", "Invalid upstream resource path", 400);
    }
    return url.toString();
  }

  private async fetchResponse(url: string, accept: string): Promise<UpstreamResponse> {
    if (this.activeRequests >= this.config.maxConcurrentUpstream) await new Promise<void>((resolve) => this.requestQueue.push(resolve));
    this.activeRequests += 1;
    try { return await this.fetchBounded(url, accept); }
    finally { this.activeRequests -= 1; this.requestQueue.shift()?.(); }
  }

  private async fetchBounded(url: string, accept: string): Promise<UpstreamResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.retryAttempts; attempt += 1) {
      const cooldown = this.retryAt - Date.now();
      if (cooldown > 0) await new Promise((resolve) => setTimeout(resolve, cooldown));
      try { return await this.fetchOnce(url, accept); }
      catch (error) {
        lastError = error;
        const transientStatus = error instanceof ConnectorError && [429, 502, 503, 504].includes(error.upstreamStatus ?? 0);
        const transientTransport = error instanceof ConnectorError && ["upstream_timeout", "upstream_error"].includes(error.code) && error.upstreamStatus === undefined;
        if ((!transientStatus && !transientTransport) || attempt + 1 >= this.config.retryAttempts) throw error;
        const exponential = this.config.retryDelayMs * (2 ** attempt) / 1000;
        const retryAfter = error instanceof ConnectorError ? error.retryAfterSeconds ?? 0 : 0;
        const delaySeconds = Math.min(this.config.retryAfterCapSeconds, Math.max(exponential, retryAfter));
        if (error instanceof ConnectorError && error.upstreamStatus === 429) this.retryAt = Math.max(this.retryAt, Date.now() + delaySeconds * 1000);
        if (delaySeconds > 0) await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
    throw lastError;
  }

  private async fetchOnce(url: string, accept: string): Promise<UpstreamResponse> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new ConnectorError("upstream_timeout", "Banktwo upstream request timed out", 504);
      throw new ConnectorError("upstream_error", "Banktwo upstream could not be reached", 502);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectorError("upstream_error", "Banktwo upstream returned an unexpected redirect", 502, response.status);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      if (response.status === 404) throw new ConnectorError("not_found", "Banktwo source resource was not found", 404, response.status);
      if (response.status === 401 || response.status === 403) throw new ConnectorError("unauthorized", "Banktwo source access was denied", 401, response.status);
      if (response.status === 429) throw new ConnectorError("rate_limited", "Banktwo source rate limit was reached", 429, response.status, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
      throw new ConnectorError("upstream_error", "Banktwo upstream request failed", 502, response.status, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorError("upstream_error", "Banktwo upstream returned an empty response", 502, response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.config.maxResponseBytes) {
          await reader.cancel();
          throw new ConnectorError("upstream_response_too_large", "Banktwo upstream response exceeded the configured size limit", 502, response.status);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks.map((part) => Buffer.from(part)));
    return { status: response.status, contentType: response.headers.get("content-type") || "application/octet-stream", body, sourceUri: url, sha256: createHash("sha256").update(body).digest("hex") };
  }
}
