/**
 * A fetch that fails at once while the device reports no connection. On Android, airplane mode can leave a request
 * to the server waiting with no answer and no error (React Native's HTTP client has no connect timeout), so a
 * cold start offline waited on the legal gate's read and never left the starting screen. Failing the way React
 * Native fails an unreachable request ("Network request failed") sends every caller down the path it already has
 * for an unreachable server: the cached identity, the queued writes, the auth retry.
 */
export function offlineAwareFetch(
  isConnected: () => Promise<boolean>,
  base: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    // A connectivity reading that fails is no reason to refuse: the request decides.
    const connected = await isConnected().catch(() => true);
    if (!connected) throw new TypeError("Network request failed");
    return base(input, init);
  };
}
