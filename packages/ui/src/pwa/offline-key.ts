/**
 * The offline page cache key the proxies set (A96, ADR 0052). Its own module, so a proxy imports a few lines and
 * none of the service worker source or the tokens.
 */

/** Response header naming the signed-in person's offline cache: a hash, never the id itself. */
export const OFFLINE_KEY_HEADER = "x-xos-offline-key";

/**
 * The key of a person's offline page cache: the first 128 bits of SHA-256 over their sign-in id, hex. The proxy sets
 * it on the pages it serves to that person, so the service worker files each page under its own person.
 */
export async function offlineKey(userId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xos-offline:${userId}`)),
  );
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
