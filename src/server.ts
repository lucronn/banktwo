import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Config } from "./config.js";
import { serializeError } from "./errors.js";
import { registerRoutes } from "./routes.js";
import { UpstreamClient } from "./upstream-client.js";

export async function createApp(config: Config, fetcher: typeof fetch = fetch): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestIdHeader: "x-request-id", routerOptions: { maxParamLength: 2048 } });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { status?: number }).status || 500;
    reply.code(status).send(serializeError(error, request.id));
  });
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "AutoDBtwo Read-only Connector API", version: "0.1.0" } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  registerRoutes(app, { config, upstream: new UpstreamClient(config, fetcher) });
  await app.ready();
  return app;
}
