/**
 * The transport core of the SDK: authentication, idempotency keys, ETags, retries, problem
 * errors and cursor pagination. Generated resource classes call into it; it knows nothing
 * about individual resources.
 */
import type { Problem } from "./errors.ts";
import { XosNetworkError, errorForProblem, parseRetryAfter } from "./errors.ts";
import { buildPath, buildQuery } from "./query.ts";
import type {
  ApiResponse,
  MutationOptions,
  OperationSpec,
  Page,
  RateLimit,
  RequestInput,
  RequestOptions,
} from "./types.ts";

export interface XosClientOptions {
  /** API base URL including the version, for example `https://atlas.example.com/api/v1`. */
  readonly baseUrl: string;
  /** Org-scoped API key (`xos_live_...`) for servers. */
  readonly apiKey?: string;
  /** A session JWT or an OAuth access token. */
  readonly accessToken?: string;
  /** Called before every request; use it to refresh short-lived tokens. */
  readonly getToken?: () => string | Promise<string>;
  /** A `fetch` implementation; defaults to the global one. */
  readonly fetch?: typeof fetch;
  /** Retries after 429, 502, 503, 504 and network failures. Default 2. */
  readonly maxRetries?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
  /** Headers sent on every request. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Generates `Idempotency-Key` values. Defaults to `crypto.randomUUID`. */
  readonly idempotencyKey?: () => string;
  /** Waits between retries. Replaceable in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 8000;
const PROBLEM_MEDIA = "application/problem+json";

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRateLimit(headers: Headers): RateLimit | null {
  const limit = headers.get("RateLimit-Limit");
  const remaining = headers.get("RateLimit-Remaining");
  const reset = headers.get("RateLimit-Reset");
  if (limit === null || remaining === null || reset === null) return null;
  const values = [limit, remaining, reset].map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const [l, r, s] = values as [number, number, number];
  return { limit: l, remaining: r, reset: s };
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export class XosClientCore {
  readonly baseUrl: string;
  readonly #options: XosClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: XosClientOptions) {
    if (!options.baseUrl)
      throw new TypeError("XosClient needs a baseUrl such as https://atlas.example.com/api/v1.");
    const credentials = [options.apiKey, options.accessToken, options.getToken].filter(
      (c) => c !== undefined,
    );
    if (credentials.length > 1) {
      throw new TypeError("Pass only one of apiKey, accessToken or getToken.");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("No fetch implementation is available; pass one as options.fetch.");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#options = options;
    this.#fetch = fetchImpl;
  }

  async #authorization(): Promise<string | null> {
    const o = this.#options;
    const token = o.apiKey ?? o.accessToken ?? (o.getToken ? await o.getToken() : undefined);
    return token ? `Bearer ${token}` : null;
  }

  #newIdempotencyKey(): string {
    return this.#options.idempotencyKey
      ? this.#options.idempotencyKey()
      : globalThis.crypto.randomUUID();
  }

  async #send(
    spec: OperationSpec,
    url: string,
    init: RequestInit,
    options: RequestOptions | undefined,
  ): Promise<RawResponse> {
    const timeoutMs = options?.timeoutMs ?? this.#options.timeoutMs ?? 30000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new XosNetworkError(spec.id, error, timeout.aborted);
    }
    const type = response.headers.get("Content-Type") ?? "";
    const text = response.status === 204 ? "" : await response.text();
    let body: unknown = undefined;
    if (text !== "") {
      if (type.includes("json")) {
        try {
          body = JSON.parse(text);
        } catch (error) {
          throw new XosNetworkError(
            spec.id,
            new Error(`The API sent malformed JSON: ${String(error)}`),
            false,
          );
        }
      } else {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body };
  }

  #toError(spec: OperationSpec, raw: RawResponse): Error {
    const problem: Problem = isProblem(raw.body)
      ? { ...raw.body, status: raw.status }
      : {
          type: "about:blank",
          title: `HTTP ${raw.status}`,
          status: raw.status,
          ...(typeof raw.body === "string" && raw.body !== ""
            ? { detail: raw.body.slice(0, 500) }
            : {}),
        };
    return errorForProblem(spec.id, problem, raw.headers);
  }

  /** Sends one operation and returns the raw success body. Retries are transparent. */
  async #execute(
    spec: OperationSpec,
    input: RequestInput,
    options: (MutationOptions & { readonly ifMatch?: string }) | undefined,
  ): Promise<RawResponse> {
    const query = buildQuery(spec, input.query);
    const qs = query.toString();
    const url = `${this.baseUrl}${buildPath(spec, input.path)}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      Accept: `application/json, ${PROBLEM_MEDIA}`,
      ...this.#options.defaultHeaders,
      ...options?.headers,
    };
    const auth = await this.#authorization();
    if (auth) headers["Authorization"] = auth;
    if (spec.idempotent)
      headers["Idempotency-Key"] = options?.idempotencyKey ?? this.#newIdempotencyKey();
    if (spec.ifMatch) {
      if (!options?.ifMatch) {
        throw new TypeError(`${spec.id} requires ifMatch: pass the ETag from the row you read.`);
      }
      headers["If-Match"] = options.ifMatch;
    }
    let body: string | undefined;
    if (input.body !== undefined) {
      if (spec.body === null) throw new TypeError(`${spec.id} takes no request body.`);
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(input.body);
    } else if (spec.bodyRequired) {
      throw new TypeError(`${spec.id} requires a request body (${spec.body}).`);
    }

    const maxRetries = this.#options.maxRetries ?? 2;
    const sleep = this.#options.sleep ?? sleepFor;
    for (let attempt = 0; ; attempt++) {
      let raw: RawResponse;
      try {
        raw = await this.#send(
          spec,
          url,
          { method: spec.method, headers, ...(body !== undefined ? { body } : {}) },
          options,
        );
      } catch (error) {
        if (error instanceof XosNetworkError && attempt < maxRetries) {
          await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
          continue;
        }
        throw error;
      }
      if (raw.status >= 200 && raw.status < 300) return raw;
      if (RETRY_STATUSES.has(raw.status) && attempt < maxRetries) {
        const wait = parseRetryAfter(raw.headers.get("Retry-After"), Date.now());
        await sleep(wait !== null ? wait * 1000 : Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
        continue;
      }
      throw this.#toError(spec, raw);
    }
  }

  /** Calls one operation. Generated resource methods use this; it is public for tools such as the CLI. */
  async request<T>(
    spec: OperationSpec,
    input: RequestInput = {},
    options?: MutationOptions & { readonly ifMatch?: string },
  ): Promise<ApiResponse<T>> {
    const raw = await this.#execute(spec, input, options);
    return {
      data: raw.body as T,
      status: raw.status,
      etag: raw.headers.get("ETag"),
      rateLimit: readRateLimit(raw.headers),
      headers: raw.headers,
    };
  }

  /** Fetches one page of a paged list. */
  async requestPage<T>(
    spec: OperationSpec,
    input: RequestInput = {},
    options?: RequestOptions,
  ): Promise<Page<T>> {
    if (!spec.paged) throw new TypeError(`${spec.id} is not a paged list.`);
    const raw = await this.#execute(spec, input, options);
    const body = raw.body as { data?: unknown; next_cursor?: unknown } | undefined;
    if (!body || !Array.isArray(body.data)) {
      throw new XosNetworkError(
        spec.id,
        new Error("The API returned a page without a data array."),
        false,
      );
    }
    return {
      data: body.data as T[],
      nextCursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
      status: raw.status,
      etag: raw.headers.get("ETag"),
      rateLimit: readRateLimit(raw.headers),
      headers: raw.headers,
    };
  }

  /** Iterates every item of a paged list, following `next_cursor` until the last page. */
  async *paginate<T>(
    spec: OperationSpec,
    input: RequestInput = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    let cursor: string | null = null;
    do {
      const query = { ...input.query, ...(cursor !== null ? { cursor } : {}) };
      const page: Page<T> = await this.requestPage<T>(spec, { ...input, query }, options);
      yield* page.data;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}

/** Base class of the generated resource groups. */
export abstract class Resource {
  protected readonly client: XosClientCore;

  constructor(client: XosClientCore) {
    this.client = client;
  }
}
