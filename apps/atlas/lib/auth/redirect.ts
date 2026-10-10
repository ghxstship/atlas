/**
 * Where to go after signing in. Only same-site relative paths are honored, so a crafted `next`
 * parameter can never send a person to another site (open redirect, OWASP ASVS 5.1.5).
 */
export function safeNext(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const url = new URL(next, "http://atlas.invalid");
    if (url.origin !== "http://atlas.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    if (error instanceof TypeError) return fallback;
    throw error;
  }
}

/** An absolute URL on the Atlas site for links sent by email or handed to OAuth providers. */
export function siteUrl(site: string, path: string, next?: string): string {
  const url = new URL(path, site);
  if (next !== undefined && next !== "/") url.searchParams.set("next", next);
  return url.toString();
}
