/**
 * The caller's address behind the platform's proxies (finding A69-003), for the org IP allow-list
 * (migration 1201), legal acceptances and rate limits.
 *
 * Every proxy appends the address it saw to whatever `X-Forwarded-For` the client sent, so the
 * first entry is the client's own text: reading it let anyone outside an org's allowed networks
 * claim an office address. The trustworthy entry is the one the nearest trusted proxy appended,
 * counted from the right:
 *   - Vercel replaces the header with the one client address it saw, so the last entry is the client;
 *   - one appending proxy (nginx `proxy_add_x_forwarded_for`, Caddy, Traefik, Kong) makes the
 *     last entry the address that proxy saw, which is the client;
 *   - each further trusted proxy in front of that one adds an entry, set as `XOS_TRUSTED_PROXY_HOPS`.
 * A chain shorter than the trusted hops skipped a proxy, so the address is unknown (null), which an
 * enforcing allow-list refuses. `X-Real-IP` counts only when there is no chain at all.
 */

/** Trusted proxies behind the one that appends the client address, from `XOS_TRUSTED_PROXY_HOPS`. */
export function trustedProxyHops(value: string | undefined): number {
  const raw = value?.trim() ?? "";
  return /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
}

/** The client address from the forwarding headers, past `trustedHops` trusted proxies; null when unknown. */
export function clientAddress(
  headers: { get(name: string): string | null },
  trustedHops = 0,
): string | null {
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (chain.length === 0) {
    const real = headers.get("x-real-ip")?.trim();
    return real === undefined || real === "" ? null : real;
  }
  const index = chain.length - 1 - Math.max(0, Math.trunc(trustedHops));
  return index < 0 ? null : (chain[index] as string);
}
