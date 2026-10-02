import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ host: config.host, port: config.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { createApp } from "./server.js";
export { loadConfig } from "./config.js";
