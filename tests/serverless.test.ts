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
