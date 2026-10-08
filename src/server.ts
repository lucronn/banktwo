import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Config } from "./config.js";
import { serializeContractError, serializeError } from "./errors.js";
import { registerRoutes } from "./routes.js";
import { registerSourceContractRoutes } from "./source-contract.js";
import { UpstreamClient } from "./upstream-client.js";

export async function createApp(config: Config, fetcher: typeof fetch = fetch): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), routerOptions: { maxParamLength: 2048 } });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { status?: number }).status || 500;
    reply.code(status).send(request.url.startsWith("/v1/capabilities") || request.url.startsWith("/v1/catalog/") || request.url.startsWith("/v1/vehicle-resolutions") || request.url.startsWith("/v1/vehicles/") || request.url.startsWith("/v1/resources/")
      ? serializeContractError(error, request.id) : serializeError(error, request.id));
  });
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "Banktwo Source Connector API", version: "1.0.0" } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  const upstream = new UpstreamClient(config, fetcher);
  registerRoutes(app, { config, upstream });
  registerSourceContractRoutes(app, { config, upstream });
  await app.ready();
  return app;
}
