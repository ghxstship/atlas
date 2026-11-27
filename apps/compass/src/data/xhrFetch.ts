import type { WatchedFetch } from "./offlineFetch";

/** The parts of XMLHttpRequest this fetch uses, so a test can stand in for React Native's. */
export interface XhrLike {
  readyState: number;
  status: number;
  statusText: string;
  responseType: string;
  readonly response: unknown;
  readonly responseURL?: string;
  onreadystatechange: (() => void) | null;
  onprogress: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  getAllResponseHeaders(): string | null;
  send(body: unknown): void;
  abort(): void;
}

/** XMLHttpRequest.HEADERS_RECEIVED: the response has started. */
const HEADERS_RECEIVED = 2;

/** Statuses whose response has no body; a Response with a body and one of these is refused. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function parseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.replace(/\r?\n[\t ]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    } catch {
      // A header the platform refuses is left out, as whatwg-fetch does.
    }
  }
  return headers;
}

function requestParts(input: RequestInfo | URL, init: RequestInit | undefined) {
  const request = typeof input === "string" || input instanceof URL ? null : input;
  const url = request ? request.url : String(input);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  let body: unknown = init?.body ?? null;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
  } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    body = body.toString();
  } else if (typeof Blob !== "undefined" && body instanceof Blob && body.type) {
    if (!headers.has("content-type")) headers.set("content-type", body.type);
  }
  return { url, method, headers, body, signal: init?.signal ?? request?.signal ?? null };
}

/**
 * A fetch over XMLHttpRequest that reports when the response starts and as its body arrives. React Native's fetch
 * (whatwg-fetch over XMLHttpRequest) resolves only once the whole body has downloaded, so a time limit that ends
 * when it resolves covers the download as well: a large sync pull on a slow connection always failed. This one
 * calls `onActivity` when the response headers arrive and on every download progress event (React Native sends
 * those once a progress listener is set), so the caller's limit can measure silence instead of the whole download.
 * Requests and responses otherwise behave as React Native's fetch: the same body types, the same errors.
 */
export function createXhrFetch(Xhr: new () => XhrLike): WatchedFetch {
  return (input, init, onActivity) =>
    new Promise<Response>((resolve, reject) => {
      const { url, method, headers, body, signal } = requestParts(input, init);
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const xhr = new Xhr();
      const abortXhr = () => xhr.abort();
      const settle = () => signal?.removeEventListener("abort", abortXhr);
      xhr.onreadystatechange = () => {
        if (xhr.readyState >= HEADERS_RECEIVED) onActivity?.();
      };
      xhr.onprogress = () => onActivity?.();
      xhr.onload = () => {
        settle();
        const status = xhr.status;
        const responseHeaders = parseHeaders(xhr.getAllResponseHeaders() ?? "");
        const responseBody = NULL_BODY_STATUSES.has(status)
          ? null
          : (xhr.response as BodyInit | null);
        setTimeout(() => {
          try {
            const response = new Response(responseBody, {
              status,
              statusText: xhr.statusText,
              headers: responseHeaders,
            });
            if (xhr.responseURL) Object.defineProperty(response, "url", { value: xhr.responseURL });
            resolve(response);
          } catch (error) {
            reject(error);
          }
        }, 0);
      };
      xhr.onerror = () => {
        settle();
        setTimeout(() => reject(new TypeError("Network request failed")), 0);
      };
      xhr.ontimeout = () => {
        settle();
        setTimeout(() => reject(new TypeError("Network request timed out")), 0);
      };
      xhr.onabort = () => {
        settle();
        setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 0);
      };
      xhr.open(method, url, true);
      xhr.responseType = "blob";
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      signal?.addEventListener("abort", abortXhr);
      xhr.send(body);
    });
}

/** The fetch Compass uses on React Native: XMLHttpRequest is React Native's own. */
export const xhrFetch: WatchedFetch = (input, init, onActivity) =>
  createXhrFetch(XMLHttpRequest as unknown as new () => XhrLike)(input, init, onActivity);
