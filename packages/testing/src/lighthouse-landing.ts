import type { SessionCookie } from "./lighthouse.ts";

/**
 * Where each Lighthouse page lands. lhci asserts a report by its final URL, so a page that redirects
 * (Atlas /p/NWS to its overview, Gateway /money to /money/overview) fell outside every exact-URL
 * assertMatrix entry and went unasserted. The CLI visits the redirect target instead, and stops when
 * a signed-in page sends the person to sign in, which would leave the rest of the run signed out.
 */

/** Pages per signed-in session: about 7 minutes of Lighthouse, well inside the hour a JWT lasts. */
export const PAGES_PER_SESSION = 40;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;

type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "headers">>;

/** The Cookie header a browser sends for the session cookies, or null for a signed-out run. */
export function cookieHeader(cookies: readonly SessionCookie[] | null): string | null {
  return cookies && cookies.length > 0
    ? cookies.map((c) => `${c.name}=${c.value}`).join("; ")
    : null;
}

/**
 * The path and query a page ends on after the app's own HTTP redirects, at most five. A redirect to
 * another origin, or to sign-in on a signed-in run, throws: the run would measure the wrong page.
 */
export async function landingPath(
  baseUrl: string,
  path: string,
  cookie: string | null,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const origin = new URL(baseUrl).origin;
  let url = new URL(path, origin);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const res = await fetchImpl(url.href, {
      redirect: "manual",
      headers: cookie === null ? {} : { cookie },
    });
    const location = res.headers.get("location");
    if (!REDIRECTS.has(res.status) || location === null) break;
    const next = new URL(location, url);
    if (next.origin !== origin) throw new Error(`${path} redirects off the app, to ${next.href}.`);
    if (cookie !== null && next.pathname.startsWith("/auth/")) {
      throw new Error(`${path} sends the signed-in person to ${next.pathname}: the session ended.`);
    }
    url = next;
  }
  return `${url.pathname}${url.search}`;
}

/**
 * The pages to visit in place of `paths`: each one's landing path, leaving out a landing path already
 * visited (`seen`, which this adds to), such as a project's overview reached from the project.
 */
export async function landingPaths(
  baseUrl: string,
  paths: readonly string[],
  cookie: string | null,
  seen: Set<string>,
  fetchImpl: Fetch = fetch,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const landed = await landingPath(baseUrl, path, cookie, fetchImpl);
    if (seen.has(landed)) continue;
    seen.add(landed);
    out.push(landed);
  }
  return out;
}

/** The paths in runs of at most `size`, each run signed in afresh. */
export function batches<T>(items: readonly T[], size: number = PAGES_PER_SESSION): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
