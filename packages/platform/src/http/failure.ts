/**
 * The response an Edge Function gives for an unexpected error (A22-013, ASVS V16.5.1). The caller
 * gets a generic problem with a request id and nothing from the error itself: error messages can name
 * environment variables, database errors and SQL fragments. The full error goes to the structured log
 * with the same request id, through a logger that redacts personal data (infra/observability).
 */

/** The structural subset of the infra/observability Logger the Edge Functions pass in. */
export interface FailureLogger {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** The caller's X-Request-Id when it is well formed, otherwise a new UUID. */
export function requestIdFor(
  request: Request,
  generate: () => string = () => crypto.randomUUID(),
): string {
  const given = request.headers.get("X-Request-Id");
  return given !== null && REQUEST_ID.test(given) ? given : generate();
}

/** The function name from an Edge Function URL (`/functions/v1/<name>/...` or `/<name>/...`). */
export function edgeFunctionName(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
  const name = segments[0] === "functions" && segments[1] === "v1" ? segments[2] : segments[0];
  return name !== undefined && /^[a-z0-9-]{1,64}$/.test(name) ? name : "unknown";
}

/**
 * Logs the error with the request id and returns a 500 problem that carries only the request id.
 * Never throws: logging failures cannot turn into a second unhandled error.
 */
export function internalErrorResponse(
  error: unknown,
  options: { readonly requestId: string; readonly logger: FailureLogger; readonly fn?: string },
): Response {
  try {
    options.logger.error("edge function failed", {
      request_id: options.requestId,
      function: options.fn ?? "unknown",
      error,
    });
  } catch (logError) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "edge function failure could not be logged",
        request_id: options.requestId,
        reason: logError instanceof Error ? logError.name : typeof logError,
      }),
    );
  }
  return new Response(
    JSON.stringify({
      type: "/problems/internal",
      title: "Internal error",
      status: 500,
      detail: `The request could not be completed. Quote request id ${options.requestId} to support.`,
      request_id: options.requestId,
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/problem+json", "X-Request-Id": options.requestId },
    },
  );
}
