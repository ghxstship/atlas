import "server-only";
import { LAST_ORG_COOKIE, sessionCookieName } from "@xos/api";
import { apiApp } from "@/lib/api/app";

/**
 * Calls into the public API app in process (B16, ADR 0155 C28). The API judges every credential by the caller's
 * address (the org IP allow-list, rate limits), so a call made on someone's behalf carries the address and trace
 * headers of the request that caused it; without them the allow-list would refuse an allowed person.
 */

/** The headers carried over from the incoming request. */
export const FORWARDED_HEADERS = ["x-forwarded-for", "x-real-ip", "traceparent", "x-request-id"];

/** A fetch into the API app with the incoming request's address and trace, and `rewrite` applied last. */
export function inProcessFetch(
  incoming: Pick<Headers, "get">,
  rewrite?: (headers: Headers) => void,
): typeof fetch {
  const forwarded = FORWARDED_HEADERS.map((name) => [name, incoming.get(name)] as const).filter(
    (pair): pair is readonly [string, string] => pair[1] !== null,
  );
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const [name, value] of forwarded) headers.set(name, value);
    rewrite?.(headers);
    return (await apiApp()).fetch(new Request(request, { headers }));
  };
}

/**
 * A fetch that calls the API as the person's Atlas session bound to one org: the session travels as the Atlas
 * session cookie with that org as the last-org cookie, the way the person's own browser calls /api/v1, so only that
 * org's allow-list, MFA policy and session lifetime apply (A69-010). A bearer session would be unbound and checked
 * against every org the person belongs to.
 */
export function inProcessSessionFetch(
  incoming: Pick<Headers, "get">,
  session: { readonly accessToken: string; readonly orgSlug: string; readonly siteOrigin: string },
): typeof fetch {
  const origin = new URL(session.siteOrigin).origin;
  const value = `base64-${Buffer.from(JSON.stringify({ access_token: session.accessToken })).toString("base64url")}`;
  return inProcessFetch(incoming, (headers) => {
    headers.delete("authorization");
    headers.set(
      "cookie",
      `${sessionCookieName(origin)}=${value}; ${LAST_ORG_COOKIE}=${encodeURIComponent(session.orgSlug)}`,
    );
    // The API refuses the session cookie on a write from another origin; this call starts on Atlas itself.
    headers.set("origin", origin);
  });
}
