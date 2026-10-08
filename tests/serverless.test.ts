import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import handler from "../src/server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

it("serves public readiness through the Vercel serverless entry point", async () => {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ready" });
});

it("serves OpenAPI and Swagger docs through the serverless entry point", async () => {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;

  const openapi = await fetch(`${base}/openapi.json`);
  expect(openapi.status).toBe(200);
  const document = await openapi.json() as { info: { title: string }; servers?: Array<{ url: string }> };
  expect(document.info.title).toBe("Banktwo Source Connector API");
  expect(document.servers?.some((server) => server.url === "https://banktwo.cars.tk")).toBe(true);

  const docs = await fetch(`${base}/docs`);
  expect(docs.status).toBe(200);
  expect(await docs.text()).toContain("Swagger UI");

  const contract = await fetch(`${base}/openapi/source-connector-v1.yaml`);
  expect(contract.status).toBe(200);
  expect(await contract.text()).toContain("openapi:");
});
