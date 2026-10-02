import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const config: Config = {
  host: "127.0.0.1", port: 3001, upstreamBaseUrl: "https://autoapitwo.test",
  requestTimeoutMs: 500, maxResponseBytes: 1024, maxCacheEntries: 8,
  cacheTtlSeconds: 60, maxClientRequestsPerWindow: 10, clientRateWindowSeconds: 60,
};
const apps: FastifyInstance[] = [];
async function app(fetcher: typeof fetch = fetch) { const instance = await createApp(config, fetcher); apps.push(instance); return instance; }
afterEach(async () => { await Promise.all(apps.splice(0).map((instance) => instance.close())); });

describe("AutoDBtwo read-only connector", () => {
  it("serves fleet resources through the fixed upstream origin and reuses its bounded cache", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ year: "2012" }]), { status: 200, headers: { "content-type": "application/json" } }));
    const instance = await app(fetcher as typeof fetch);
    const first = await instance.inject("/v1/fleet/years");
    const second = await instance.inject("/v1/fleet/years");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual([{ year: "2012" }]);
    expect(first.headers["x-source-uri"]).toBe("https://autoapitwo.test/api/v1/fleet/years");
    expect(first.headers["x-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(second.statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed vehicle and resource paths before an upstream request", async () => {
    const fetcher = vi.fn();
    const instance = await app(fetcher as typeof fetch);
    expect((await instance.inject("/v1/fleet/carids/not-a-number")).statusCode).toBe(400);
    expect((await instance.inject(`/v1/content/carids/123/resource?path=${encodeURIComponent("/api/v1/content/carids/123/../../admin")}`)).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards catalog and selected article/image resources through scoped routes", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith("/image.png") ? new Uint8Array([1, 2, 3]) : JSON.stringify({ article: "ok" });
      return new Response(body, { status: 200, headers: { "content-type": url.endsWith(".png") ? "image/png" : "application/json" } });
    });
    const instance = await app(fetcher as typeof fetch);
    const fleetPath = encodeURIComponent("/api/v1/fleet/years/2012/makes/Ram/models/Ram%201500/engines");
    const fleet = await instance.inject(`/v1/fleet/resource?path=${fleetPath}`);
    expect(fleet.statusCode).toBe(200);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://autoapitwo.test/api/v1/fleet/years/2012/makes/Ram/models/Ram%201500/engines");

    const articlePath = encodeURIComponent("/api/v1/content/carids/12/components/867/itypes/401/nonstandards/210265");
    const article = await instance.inject(`/v1/content/carids/12/resource?path=${articlePath}`);
    expect(article.statusCode).toBe(200);
    expect(article.json()).toEqual({ article: "ok" });

    const imagePath = encodeURIComponent("/api/v1/content/carids/12/images/image.png");
    const image = await instance.inject(`/v1/content/carids/12/resource?path=${imagePath}&binary=true`);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it("returns sanitized upstream failures and retains upstream status only", async () => {
    const fetcher = vi.fn(async () => new Response("sensitive provider payload", { status: 503 }));
    const instance = await app(fetcher as typeof fetch);
    const response = await instance.inject("/v1/fleet/years");
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({ code: "upstream_error", upstream_status: 503, retryable: true });
    expect(response.body).not.toContain("sensitive provider payload");
  });

  it("serves health and documents all public routes", async () => {
    const instance = await app();
    expect((await instance.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await instance.inject("/readyz")).json()).toEqual({ status: "ready" });
    const document = (await instance.inject("/openapi.json")).json();
    expect(document.info.title).toBe("AutoDBtwo Read-only Connector API");
    expect(document.paths["/v1/fleet/years"]).toBeDefined();
    expect(document.paths["/v1/content/carids/{carId}/resource"]).toBeDefined();
  });
});
