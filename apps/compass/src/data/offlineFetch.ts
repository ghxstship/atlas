/**
 * How long a request to the server waits with no sign of life: for its response to start, then between pieces of
 * its body. React Native's HTTP client on Android sets no
 * connect, read or write timeout (OkHttpClientProvider sets all three to 0), so a server that stops answering kept
 * a request open for good: a cold start with a stored session waited on that read and never left the starting screen
 * (nightly run 45247413192, field-gate-in-out-override: the app opened five connections in its first second, then
 * logged nothing and showed the loading skeleton for the two minutes the flow waited).
 */
export const RESPONSE_TIMEOUT_MS = 60_000;

/**
 * A fetch that may report signs of life: `onActivity` when the response starts and as its body arrives. A plain
 * fetch qualifies (it ignores the third argument); there, the response resolving is the only sign.
 */
export type WatchedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
  onActivity?: () => void,
) => Promise<Response>;

/** True for a body that uploads a file (a photo, a voice note, a document): it may take longer than the limit. */
function uploadsFile(body: BodyInit | null | undefined): boolean {
  if (body === undefined || body === null || typeof body === "string") return false;
  return !(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams);
}

/**
 * A fetch that fails at once while the device reports no connection, and fails a request whose response has not
 * started within RESPONSE_TIMEOUT_MS or whose body then stops arriving for as long. On Android, airplane mode can leave a request to the server waiting with no
 * answer and no error (React Native's HTTP client has no connect timeout), so a cold start offline waited on the
 * legal gate's read and never left the starting screen. Failing the way React Native fails an unreachable request
 * ("Network request failed", or "Network request timed out") sends every caller down the path it already has for an
 * unreachable server: the cached identity, the queued writes, the auth retry. A file upload keeps no limit: its
 * body can take longer than a minute to send on a slow connection.
 *
 * The limit restarts on every sign of life `base` reports. React Native's fetch resolves only once the whole body
 * has downloaded, so Compass passes xhrFetch, which reports the headers and each download progress event: a large
 * sync pull on a slow connection keeps going for as long as its bytes keep arriving.
 */
export function offlineAwareFetch(
  isConnected: () => Promise<boolean>,
  base: WatchedFetch = fetch,
  timeoutMs: number = RESPONSE_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    // A connectivity reading that fails is no reason to refuse: the request decides.
    const connected = await isConnected().catch(() => true);
    if (!connected) throw new TypeError("Network request failed");
    if (uploadsFile(init?.body)) return base(input, init);
    const controller = new AbortController();
    const caller = init?.signal;
    // The caller's own cancellation still cancels the request.
    const relay = () => controller.abort(caller?.reason);
    if (caller?.aborted) controller.abort(caller.reason);
    else caller?.addEventListener("abort", relay);
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (timedOut || settled) return;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    arm();
    try {
      return await base(input, { ...init, signal: controller.signal }, arm);
    } catch (error) {
      if (timedOut) throw new TypeError("Network request timed out", { cause: error });
      throw error;
    } finally {
      // Once the response resolves, reading anything left of its body is the caller's.
      settled = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", relay);
    }
  };
}
