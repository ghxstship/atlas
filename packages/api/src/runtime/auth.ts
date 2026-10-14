/**
 * Credentials for the public API (ADR 0003, ADR 0007 item 1):
 * - `Authorization: Bearer <Supabase session JWT>` for first-party clients;
 * - the Atlas session cookie (`xos-auth`, written by `@supabase/ssr`) for Atlas pages, with a
 *   same-origin check on state-changing methods because cookies ride along cross-site;
 * - `Authorization: Bearer xos_live_...` API keys (see `apiKeys` below).
 *
 * The token is verified with Supabase Auth, and every query runs through a client carrying that
 * token, so RLS decides access. The service role is never used for a user request.
 *
 * The active organization is bound to the credential, resolved in this order: the `org_id` claim
 * written by the custom access token hook from the context switcher's choice; for cookie sessions,
 * the org Atlas last opened on this device; the person's only active membership. A candidate is
 * always checked against the caller's active memberships, read through RLS.
 */
import { getCurrentPerson, listMyOrganizations } from "@xos/data";
import { createCallerClient } from "@xos/data/client";
import type { XosClient } from "@xos/data";
import { unauthorized } from "../problem.ts";
import type { Authenticate, RequestContext, RequestOrg } from "./context.ts";

export const SESSION_COOKIE = "xos-auth";
export const LAST_ORG_COOKIE = "xos-last-org";
export const API_KEY_PREFIX = "xos_live_";
export const SUPPORTED_LOCALES = ["en-US", "es-US"] as const;

export interface SupabaseAuthOptions {
  readonly url: string;
  readonly anonKey: string;
  /** Public origin of the site that sets the session cookie, for the cross-site check. */
  readonly siteOrigin: string;
  readonly sessionCookie?: string;
  readonly lastOrgCookie?: string;
  readonly locales?: readonly string[];
  readonly fetch?: typeof fetch;
}

/** Cookie header to a name-to-value map. */
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch (error) {
      // A malformed escape keeps the raw value; the session decoder rejects it if it matters.
      if (!(error instanceof URIError)) throw error;
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The access token in an `@supabase/ssr` session cookie: the value, or its chunks `name.0`,
 * `name.1` and so on joined in order, optionally `base64-` prefixed base64url JSON.
 */
export function sessionTokenFromCookies(cookies: Map<string, string>, name: string): string | null {
  let value = cookies.get(name);
  if (value === undefined) {
    const chunks: string[] = [];
    for (let i = 0; cookies.has(`${name}.${i}`); i += 1)
      chunks.push(cookies.get(`${name}.${i}`) as string);
    if (chunks.length === 0) return null;
    value = chunks.join("");
  }
  const json = value.startsWith("base64-")
    ? Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")
    : value;
  try {
    const session = JSON.parse(json) as { access_token?: unknown };
    return typeof session.access_token === "string" && session.access_token !== ""
      ? session.access_token
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Claims of a JWT whose signature Supabase Auth has already verified. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** The best supported locale for an `Accept-Language` header (RFC 9110 quality values). */
export function negotiateLocale(header: string | null, supported: readonly string[]): string {
  const fallback = supported[0] as string;
  if (header === null || header.trim() === "") return fallback;
  const ranges = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: (tag ?? "").toLowerCase(), q: q === undefined ? 1 : Number(q.slice(2)), index };
    })
    .filter((r) => r.tag !== "" && Number.isFinite(r.q) && r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranges) {
    const exact = supported.find((s) => s.toLowerCase() === tag);
    if (exact !== undefined) return exact;
    const language = supported.find((s) => s.toLowerCase().split("-")[0] === tag.split("-")[0]);
    if (language !== undefined) return language;
    if (tag === "*") return fallback;
  }
  return fallback;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface Credential {
  readonly token: string;
  readonly kind: "session-bearer" | "session-cookie" | "api-key";
  readonly cookies: Map<string, string>;
}

function readCredential(request: Request, options: SupabaseAuthOptions): Credential | null {
  const cookies = parseCookies(request.headers.get("cookie"));
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match === null) throw unauthorized("Send the credential as Authorization: Bearer <token>.");
    const token = match[1] as string;
    return {
      token,
      kind: token.startsWith(API_KEY_PREFIX) ? "api-key" : "session-bearer",
      cookies,
    };
  }
  const token = sessionTokenFromCookies(cookies, options.sessionCookie ?? SESSION_COOKIE);
  if (token === null) return null;
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const origin = request.headers.get("origin");
    if (origin === null || origin !== new URL(options.siteOrigin).origin) {
      throw unauthorized("A cross-site request cannot use the Atlas session cookie.");
    }
  }
  return { token, kind: "session-cookie", cookies };
}

async function resolveOrg(
  db: XosClient,
  personId: string,
  candidates: readonly { readonly id?: string; readonly slug?: string }[],
): Promise<RequestOrg | null> {
  const orgs = await listMyOrganizations(db, personId);
  if (!orgs.ok) throw new Error(`Cannot read memberships: ${JSON.stringify(orgs.error)}`);
  for (const candidate of candidates) {
    const found = orgs.data.find(
      (o) =>
        (candidate.id !== undefined && o.id === candidate.id) ||
        (candidate.slug !== undefined && o.slug === candidate.slug),
    );
    if (found !== undefined) return { id: found.id, slug: found.slug };
  }
  const only = orgs.data.length === 1 ? orgs.data[0] : undefined;
  return only === undefined ? null : { id: only.id, slug: only.slug };
}

/**
 * Verifies an API key with `app.authenticate_api_key` (migration 0921). A valid key is still
 * answered 401: queries must run as an identity RLS understands, and no API key identity exists
 * in the database yet (reported as blocked). An unknown, revoked or expired key returns null.
 */
async function checkApiKey(secret: string, options: SupabaseAuthOptions): Promise<void> {
  const db = createCallerClient({
    url: options.url,
    anonKey: options.anonKey,
    accessToken: options.anonKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // app.authenticate_api_key is newer than the generated database types; call it untyped.
  const untyped = db as unknown as {
    rpc(
      name: string,
      args: Record<string, unknown>,
    ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  const { data, error } = await untyped.rpc("authenticate_api_key", { p_secret: secret });
  if (error !== null) throw new Error(`Cannot verify the API key: ${error.message}`);
  if ((data ?? []).length > 0) {
    throw unauthorized(
      "This API key is valid, but API key access to data is not open yet. Use a Supabase session token.",
    );
  }
}

/** The `Authenticate` dependency for Supabase sessions. */
export function createSupabaseAuthenticator(options: SupabaseAuthOptions): Authenticate {
  const locales = options.locales ?? SUPPORTED_LOCALES;
  return async (request, requestId): Promise<RequestContext | null> => {
    const credential = readCredential(request, options);
    if (credential === null) return null;
    if (credential.kind === "api-key") {
      await checkApiKey(credential.token, options);
      return null;
    }
    const db = createCallerClient({
      url: options.url,
      anonKey: options.anonKey,
      accessToken: credential.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const { data, error } = await db.auth.getUser(credential.token);
    if (error !== null || data.user === null) return null;
    const user = data.user;

    const person = await getCurrentPerson(db, user.id);
    if (!person.ok && person.error.kind !== "not-found") {
      throw new Error(`Cannot read the caller's person: ${JSON.stringify(person.error)}`);
    }
    const personId = person.ok ? person.data.id : null;
    const claim = jwtClaims(credential.token)["org_id"];
    const lastOrg =
      credential.kind === "session-cookie"
        ? credential.cookies.get(options.lastOrgCookie ?? LAST_ORG_COOKIE)
        : undefined;
    const org =
      personId === null
        ? null
        : await resolveOrg(db, personId, [
            ...(typeof claim === "string" ? [{ id: claim }] : []),
            ...(lastOrg === undefined ? [] : [{ slug: lastOrg }]),
          ]);
    return {
      user: { id: user.id, email: user.email ?? null },
      personId,
      org,
      locale: negotiateLocale(request.headers.get("accept-language"), locales),
      db,
      credential: "session",
      requestId,
    };
  };
}
