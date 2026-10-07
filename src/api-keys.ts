import { createHash } from "node:crypto";
import pg, { type Pool as PoolType } from "pg";
import { ConnectorError } from "./errors.js";

const { Pool } = pg;
export type ApiKeyVerifier = (token: string, service: "banktwo") => Promise<boolean>;

export function createApiKeyVerifier(connectionString?: string): ApiKeyVerifier {
  let pool: PoolType | undefined;
  return async (token, service) => {
    if (!connectionString) throw new ConnectorError("key_store_unavailable", "API key validation is temporarily unavailable", 503);
    if (!token.startsWith(`adk_${service}_`) || token.length > 128) return false;
    pool ??= new Pool({ connectionString, max: 2, allowExitOnIdle: true, connectionTimeoutMillis: 2500, idleTimeoutMillis: 10_000 });
    const digest = createHash("sha256").update(token, "utf8").digest();
    try {
      const result = await pool.query(`
        UPDATE managed_api_keys
        SET last_used_at = clock_timestamp()
        WHERE key_digest = $1 AND service = $2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        RETURNING id`, [digest, service]);
      return result.rowCount === 1;
    } catch {
      throw new ConnectorError("key_store_unavailable", "API key validation is temporarily unavailable", 503);
    }
  };
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1];
}
