import { errorForStatus, IntegrationError } from "./errors.ts";

/**
 * The one way connectors talk to providers. Production passes `httpFromFetch(fetch)`; tests pass a
 * recording client, so no test ever reaches a real provider.
 */
export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Adapts fetch: no redirects followed, a timeout per request, header names lowercased. */
export function httpFromFetch(fetchImpl: FetchLike, timeoutMs = 20000): HttpClient {
  return async (request) => {
    const init: RequestInit = {
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (request.headers) init.headers = { ...request.headers };
    if (request.body !== undefined) init.body = request.body as BodyInit;
    const response = await fetchImpl(request.url, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

export interface JsonCall {
  readonly method: HttpRequest["method"];
  readonly url: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}

/** Sends a JSON request and returns the parsed body, raising an IntegrationError for any failure. */
export async function callJson<T>(http: HttpClient, provider: string, call: JsonCall): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...call.headers };
  if (call.token !== undefined) headers["authorization"] = `Bearer ${call.token}`;
  const request: { -readonly [K in keyof HttpRequest]: HttpRequest[K] } = {
    method: call.method,
    url: call.url,
    headers,
  };
  if (call.json !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(call.json);
  }
  const response = await http(request);
  const failure = errorForStatus(provider, response.status, response.body);
  if (failure) throw failure;
  if (response.body.length === 0) return undefined as T;
  try {
    return JSON.parse(response.body) as T;
  } catch (error) {
    throw new IntegrationError(
      "provider_malformed_response",
      `${provider} sent a body that is not JSON: ${String(error)}`,
      {
        retryable: true,
      },
    );
  }
}

/** Sends a non-JSON request (file uploads, downloads) and returns the raw response after the status check. */
export async function callRaw(
  http: HttpClient,
  provider: string,
  request: HttpRequest,
): Promise<HttpResponse> {
  const response = await http(request);
  const failure = errorForStatus(provider, response.status, response.body);
  if (failure) throw failure;
  return response;
}
