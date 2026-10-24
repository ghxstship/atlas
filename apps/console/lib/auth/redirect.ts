/**
 * Where to go after signing in. Only same-site relative paths are honored, so a crafted `next`
 * parameter can never send a person to another site (open redirect, OWASP ASVS 5.1.5).
 */
export function safeNext(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const url = new URL(next, "http://console.invalid");
    if (url.origin !== "http://console.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    if (error instanceof TypeError) return fallback;
    throw error;
  }
}

/**
 * An absolute URL on the console site for links sent by email or handed to OAuth providers. `extra`
 * adds query parameters the return leg reads, such as the OAuth provider.
 */
export function siteUrl(
  site: string,
  path: string,
  next?: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(path, site);
  if (next !== undefined && next !== "/") url.searchParams.set("next", next);
  for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
  return url.toString();
}

/**
 * The sign-in page showing an auth error. It keeps `next`, so a person who retries still lands on
 * the page they started from.
 */
export function signInErrorPath(error: string, next: string, fallback = "/"): string {
  const params = new URLSearchParams({ error });
  if (next !== fallback) params.set("next", next);
  return `/auth/sign-in?${params.toString()}`;
}
