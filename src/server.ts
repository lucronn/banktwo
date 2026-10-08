import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { bearerToken, createApiKeyVerifier, type ApiKeyVerifier } from "./api-keys.js";
import { loadConfig, type Config } from "./config.js";
import { ConnectorError, serializeContractError, serializeError } from "./errors.js";
import { registerRoutes } from "./routes.js";
import { registerSourceContractRoutes } from "./source-contract.js";
import { UpstreamClient } from "./upstream-client.js";

function sourceConnectorContractPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "contracts", "source-connector-v1.openapi.yaml"),
    join(moduleDir, "..", "..", "contracts", "source-connector-v1.openapi.yaml"),
    join(moduleDir, "..", "contracts", "source-connector-v1.openapi.yaml"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error("source connector OpenAPI contract not found");
  return match;
}

export async function createApp(
  config: Config,
  fetcher: typeof fetch = fetch,
  verifyApiKey: ApiKeyVerifier = createApiKeyVerifier(config.apiKeysDatabaseUrl),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), routerOptions: { maxParamLength: 2048 } });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { status?: number }).status || 500;
    reply.code(status).send(request.url.startsWith("/v1/capabilities") || request.url.startsWith("/v1/catalog/") || request.url.startsWith("/v1/vehicle-resolutions") || request.url.startsWith("/v1/vehicles/") || request.url.startsWith("/v1/resources/")
      ? serializeContractError(error, request.id) : serializeError(error, request.id));
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Banktwo Source Connector API",
        version: "1.0.0",
        description: "Read-only Banktwo connector for AutoData. Canonical origin: https://banktwo.cars.tk. Create a Banktwo-scoped key in the AutoData key dashboard, then use Authorize in Swagger.",
      },
      servers: [{ url: "https://banktwo.cars.tk" }, { url: "/" }],
      components: {
        securitySchemes: {
          BanktwoBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "AutoData API key",
            description: "Paste a Banktwo key from the AutoData key dashboard (starts with adk_banktwo_).",
          },
        },
      },
      security: [{ BanktwoBearer: [] }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { persistAuthorization: true },
  });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/openapi/source-connector-v1.yaml", async (_request, reply) =>
    reply.type("application/yaml; charset=utf-8").send(readFileSync(sourceConnectorContractPath(), "utf8")),
  );
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  app.addHook("preHandler", async (request) => {
    if (!request.url.split("?", 1)[0].startsWith("/v1/")) return;
    const token = bearerToken(request.headers.authorization);
    if (!token || !(await verifyApiKey(token, "banktwo"))) {
      throw new ConnectorError("unauthenticated", "A valid Banktwo API key is required", 401);
    }
  });
  const upstream = new UpstreamClient(config, fetcher);
  registerRoutes(app, { config, upstream });
  registerSourceContractRoutes(app, { config, upstream });
  await app.ready();
  return app;
}

let serverlessAppPromise: Promise<FastifyInstance> | undefined;

function getServerlessApp(): Promise<FastifyInstance> {
  if (!serverlessAppPromise) serverlessAppPromise = createApp(loadConfig());
  return serverlessAppPromise;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const app = await getServerlessApp();
  app.server.emit("request", request, response);
}
