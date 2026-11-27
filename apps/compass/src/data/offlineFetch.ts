/**
 * How long a request to the server waits for its response to start. React Native's HTTP client on Android sets no
 * connect, read or write timeout (OkHttpClientProvider sets all three to 0), so a server that stops answering kept
 * a request open for good: a cold start with a stored session waited on that read and never left the starting screen
 * (nightly run 45247413192, field-gate-in-out-override: the app opened five connections in its first second, then
 * logged nothing and showed the loading skeleton for the two minutes the flow waited).
 */
export const RESPONSE_TIMEOUT_MS = 60_000;

/** True for a body that uploads a file (a photo, a voice note, a document): it may take longer than the limit. */
function uploadsFile(body: BodyInit | null | undefined): boolean {
  if (body === undefined || body === null || typeof body === "string") return false;
  return !(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams);
}

/**
 * A fetch that fails at once while the device reports no connection, and fails a request whose response has not
 * started within RESPONSE_TIMEOUT_MS. On Android, airplane mode can leave a request to the server waiting with no
 * answer and no error (React Native's HTTP client has no connect timeout), so a cold start offline waited on the
 * legal gate's read and never left the starting screen. Failing the way React Native fails an unreachable request
 * ("Network request failed", or "Network request timed out") sends every caller down the path it already has for an
 * unreachable server: the cached identity, the queued writes, the auth retry. A file upload keeps no limit: its
 * body can take longer than a minute to send on a slow connection.
 */
export function offlineAwareFetch(
  isConnected: () => Promise<boolean>,
  base: typeof fetch = fetch,
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
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await base(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new TypeError("Network request timed out");
      throw error;
    } finally {
      // The limit covers the wait for the response to start; reading its body is the caller's.
      clearTimeout(timer);
      caller?.removeEventListener("abort", relay);
    }
  };
}
