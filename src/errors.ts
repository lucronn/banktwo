export type ErrorCode = "invalid_request" | "client_rate_limited" | "upstream_error" | "upstream_timeout" | "upstream_response_too_large" | "unauthenticated" | "key_store_unavailable" | "internal_error";

export class ConnectorError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function serializeError(error: unknown, requestId: string) {
  if (error instanceof ConnectorError) {
    return { error: { code: error.code, message: error.message, request_id: requestId, retryable: error.code === "upstream_timeout" || error.code === "key_store_unavailable" || (error.upstreamStatus !== undefined && error.upstreamStatus >= 500), ...(error.upstreamStatus === undefined ? {} : { upstream_status: error.upstreamStatus }) } };
  }
  return { error: { code: "internal_error" as const, message: "Internal connector error", request_id: requestId, retryable: false } };
}
