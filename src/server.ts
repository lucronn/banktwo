import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Config } from "./config.js";
import { ConnectorError, serializeError } from "./errors.js";
import { registerRoutes } from "./routes.js";
import { UpstreamClient } from "./upstream-client.js";
import { bearerToken, createApiKeyVerifier, type ApiKeyVerifier } from "./api-keys.js";

export async function createApp(config: Config, fetcher: typeof fetch = fetch, verifyApiKey: ApiKeyVerifier = createApiKeyVerifier(config.apiKeysDatabaseUrl)): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestIdHeader: "x-request-id", routerOptions: { maxParamLength: 2048 } });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { status?: number }).status || 500;
    reply.code(status).send(serializeError(error, request.id));
  });
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "Banktwo Read-only API", version: "0.1.0" }, components: { securitySchemes: { BanktwoBearer: { type: "http", scheme: "bearer", bearerFormat: "AutoData API key", description: "Create a Banktwo key in the protected AutoData key dashboard." } } } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  app.addHook("preHandler", async (request) => {
    if (!request.url.split("?", 1)[0].startsWith("/v1/")) return;
    const token = bearerToken(request.headers.authorization);
    if (!token || !(await verifyApiKey(token, "banktwo"))) {
      throw new ConnectorError("unauthenticated", "A valid Banktwo API key is required", 401);
    }
  });
  registerRoutes(app, { config, upstream: new UpstreamClient(config, fetcher) });
  await app.ready();
  return app;
}
