export type Config = {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  requestTimeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  retryAfterCapSeconds: number;
  maxResponseBytes: number;
  maxCacheEntries: number;
  maxCacheBytes: number;
  maxConcurrentUpstream: number;
  cacheTtlSeconds: number;
  maxClientRequestsPerWindow: number;
  clientRateWindowSeconds: number;
};

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstreamBaseUrl = env.UPSTREAM_BASE_URL?.trim() || "https://autoapitwo.vercel.app";
  const upstream = new URL(upstreamBaseUrl);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("UPSTREAM_BASE_URL must be an HTTPS origin without credentials or a path");
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env, "PORT", 3001),
    upstreamBaseUrl: upstream.origin,
    requestTimeoutMs: positiveInteger(env, "REQUEST_TIMEOUT_MS", 20_000),
    retryAttempts: positiveInteger(env, "RETRY_ATTEMPTS", 3),
    retryDelayMs: nonNegativeInteger(env, "RETRY_DELAY_MS", 250),
    retryAfterCapSeconds: positiveInteger(env, "RETRY_AFTER_CAP_SECONDS", 30),
    maxResponseBytes: positiveInteger(env, "MAX_RESPONSE_BYTES", 8 * 1024 * 1024),
    maxCacheEntries: positiveInteger(env, "MAX_CACHE_ENTRIES", 256),
    maxCacheBytes: positiveInteger(env, "MAX_CACHE_BYTES", 64 * 1024 * 1024),
    maxConcurrentUpstream: positiveInteger(env, "MAX_CONCURRENT_UPSTREAM", 8),
    cacheTtlSeconds: positiveInteger(env, "CACHE_TTL_SECONDS", 300),
    maxClientRequestsPerWindow: positiveInteger(env, "MAX_CLIENT_REQUESTS_PER_WINDOW", 120),
    clientRateWindowSeconds: positiveInteger(env, "CLIENT_RATE_WINDOW_SECONDS", 60),
  };
}
