/**
 * Every connector failure is an IntegrationError carrying a rule code (lowercase snake case, stored in
 * `integration_sync_runs.error_code`) and how the runner treats it:
 *   - retryable: the attempt may succeed later (rate limits, provider outages, timeouts)
 *   - connectionError: the provider refused the credential, so the connection moves to Error and the
 *     run fails for good until an admin reauthorizes
 * Anything else fails the run without retry. No failure is swallowed (Section 19.7).
 */
export class IntegrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly connectionError: boolean;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; connectionError?: boolean; status?: number | null } = {},
  ) {
    super(message);
    this.name = "IntegrationError";
    this.code = /^[a-z][a-z0-9_]*$/.test(code) ? code : "provider_error";
    this.retryable = options.retryable ?? false;
    this.connectionError = options.connectionError ?? false;
    this.status = options.status ?? null;
  }
}

/** Classifies a provider HTTP status into an IntegrationError, or null for success. */
export function errorForStatus(
  provider: string,
  status: number,
  detail: string,
): IntegrationError | null {
  if (status >= 200 && status < 300) return null;
  const message = `${provider} returned ${status}${detail ? `: ${detail.slice(0, 500)}` : ""}`;
  if (status === 401 || status === 403) {
    return new IntegrationError("credential_refused", message, { connectionError: true, status });
  }
  if (status === 429)
    return new IntegrationError("provider_rate_limited", message, { retryable: true, status });
  if (status === 408 || status >= 500) {
    return new IntegrationError("provider_unavailable", message, { retryable: true, status });
  }
  if (status === 404) return new IntegrationError("provider_not_found", message, { status });
  if (status === 409 || status === 412)
    return new IntegrationError("provider_conflict", message, { status });
  return new IntegrationError("provider_rejected", message, { status });
}

/** Wraps an unknown thrown value so the runner can always record a code and a message. */
export function asIntegrationError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof Error) {
    const network = error.name === "AbortError" || error.name === "TypeError";
    return new IntegrationError(
      network ? "provider_unreachable" : "unexpected_error",
      error.message,
      {
        retryable: network,
      },
    );
  }
  return new IntegrationError("unexpected_error", String(error));
}
