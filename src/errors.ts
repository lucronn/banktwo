export type ErrorCode = "invalid_request" | "not_found" | "unauthorized" | "unauthenticated" | "key_store_unavailable" | "rate_limited" | "invalid_upstream_response" | "client_rate_limited" | "upstream_error" | "upstream_timeout" | "upstream_response_too_large" | "internal_error";

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

export function serializeContractError(error: unknown, requestId: string) {
  const connector = error instanceof ConnectorError ? error : undefined;
  const code = connector?.code === "invalid_request" ? "INVALID_INPUT"
    : connector?.code === "not_found" ? "NOT_FOUND"
    : connector?.code === "unauthorized" || connector?.code === "unauthenticated" ? "UNAUTHORIZED"
    : connector?.code === "rate_limited" ? "RATE_LIMITED"
    : connector?.code === "invalid_upstream_response" ? "INVALID_UPSTREAM_RESPONSE"
    : connector?.code === "client_rate_limited" ? "RATE_LIMITED"
    : connector?.code === "key_store_unavailable" ? "UPSTREAM_UNAVAILABLE"
    : "UPSTREAM_UNAVAILABLE";
  return {
    request_id: requestId,
    error: {
      code,
      message: connector?.message || "Banktwo could not complete the source request",
      retryable: code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE",
    },
  };
}
