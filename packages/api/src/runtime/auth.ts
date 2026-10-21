/**
 * Credentials for the public API (ADR 0003, ADR 0007 item 1):
 * - `Authorization: Bearer <Supabase session JWT>` for first-party clients;
 * - the Atlas session cookie (`__Host-xos-auth` over https, `xos-auth` on local http; written by
 *   `@supabase/ssr`) for Atlas pages, with a
 *   same-origin check on state-changing methods because cookies ride along cross-site;
 * - `Authorization: Bearer xos_live_...` API keys, exchanged for a short-lived JWT acting as the
 *   key's service account (`createApiKeyExchange`), limited to the key's scopes;
 * - `Authorization: Bearer <OAuth access token>`: a Supabase Auth JWT issued by its OAuth 2.1 server to an
 *   app an org registered (A99, ADR 0055). It carries `client_id`; the app acts for the person within
 *   the capability groups of their live grant, in the org that registered the app only
 *   (`app.my_oauth_access`), and the database applies the same limits on its own (migration 1563).
 *
 * The token's signature is verified against the project's published keys (runtime/jwt.ts), or by
 * Supabase Auth for a token only Auth can judge, and every query runs through a client carrying
 * that token, so RLS decides access. The service role is never used for a user request.
 *
 * The active organization is bound to the credential, resolved in this order: the `org_id` claim
 * written by the custom access token hook from the context switcher's choice; for cookie sessions,
 * the org Atlas last opened on this device; the person's only active membership. A candidate is
 * always checked against the caller's active memberships, read through RLS.
 *
 * Once the organization is bound, its IP allow-list applies to every credential, session or API key
 * (Section 9, migration 1201): `app.network_access` answers whether the caller's address, as the
 * proxy reports it, may reach the org. An org that never turned its allow-list on admits every
 * address; a refused address is answered 401 before any handler runs. A request bound to no org
 * reads, through RLS, the rows of every org the caller belongs to, so then every one of those
 * orgs' allow-lists applies (A69-010). The address is the X-Forwarded-For entry the trusted proxy
 * appended, never the first entry, which the client writes (A69-003).
 */
import { createHash } from "node:crypto";
import { getCurrentPerson, listMyOrganizations } from "@xos/data";
import { getMyOAuthAccess } from "@xos/data/oauth";
import { clientAddress } from "@xos/data/client-address";
import { createCallerClient } from "@xos/data/client";
import type { XosClient } from "@xos/data";
import { unauthorized } from "../problem.ts";
import type { Authenticate, RequestContext, RequestOrg } from "./context.ts";
import { createJwksVerifier } from "./jwt.ts";

/** Session cookie name on local http development; browsers refuse prefixed cookies without Secure. */
export const SESSION_COOKIE = "xos-auth";
/** Session cookie name over https: the __Host- prefix pins it to this host (A22-014). */
export const SECURE_SESSION_COOKIE = "__Host-xos-auth";

/** The session cookie name Atlas writes for a site origin: prefixed whenever the site is https. */
export function sessionCookieName(siteOrigin: string): string {
  return new URL(siteOrigin).protocol === "https:" ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}
export const LAST_ORG_COOKIE = "xos-last-org";

/**
 * The caller's address as the trusted proxy reports it: the `X-Forwarded-For` entry it appended,
 * counted from the right past `trustedHops` further trusted proxies, else `X-Real-IP` when no chain
 * was sent (A69-003). The first entry is the client's own text and is never trusted.
 */
export function clientIp(headers: Headers, trustedHops = 0): string | null {
  return clientAddress(headers, trustedHops);
}

/**
 * Whether an org's IP allow-list admits the caller (migration 1201), reusing an answer for `ttlMs`
 * per person, org and address. The database answers only for the caller's own orgs; no row means
 * there is nothing to enforce.
 */
export function createNetworkCheck(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { allowed: boolean; until: number }>();
  return async (db: XosClient, userId: string, orgId: string, ip: string | null) => {
    const key = `${userId} ${orgId} ${ip ?? ""}`;
    const hit = entries.get(key);
    if (hit !== undefined && hit.until > now()) return hit.allowed;
    entries.delete(key);
    const { data, error } = await db.rpc("network_access", { p_org_id: orgId, p_ip: ip ?? "" });
    if (error !== null) throw new Error(`Cannot check the org's IP allow-list: ${error.message}`);
    const rows = (data ?? []) as { enforced?: boolean; allowed: boolean; covered?: boolean }[];
    const allowed = rows.length === 0 || rows[0]?.allowed === true;
    // Admitted from outside an enforced list means a break-glass session let the caller in. That
    // answer is never reused, so the admission ends the moment the session does (A69-009).
    const byBreakGlass = rows[0]?.enforced === true && allowed && rows[0]?.covered !== true;
    if (ttlMs > 0 && !byBreakGlass) {
      if (entries.size >= 10_000) entries.clear();
      entries.set(key, { allowed, until: now() + ttlMs });
    }
    return allowed;
  };
}

/** The 401 for an address outside the org's allow-list. */
export function networkRefused() {
  return unauthorized(
    "This organization accepts requests only from its allowed networks. Connect from an allowed network, or ask an Admin to add yours.",
  );
}

/** What an org's security settings say about a session (A77, migration 1330; A99, migration 1561). */
export type SessionRule = "ok" | "mfa" | "session-expired" | "signed-out";

/**
 * Whether a session meets an org's security settings (A77, migration 1330, `app.my_org_auth_status`): a second
 * factor its MFA policy (security.mfa_policy) asks of the caller's roles, and a sign-in no older than its session
 * lifetime (security.session_hours). The answer is
 * reused for `ttlMs` per token and org, never past the moment the session's lifetime ends. API keys are exempt (the
 * database says so too), so callers ask only for sessions.
 */
export function createSessionRulesCheck(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { rule: SessionRule; until: number }>();
  return async (db: XosClient, token: string, orgId: string): Promise<SessionRule> => {
    const key = `${createHash("sha256").update(token).digest("hex")} ${orgId}`;
    const hit = entries.get(key);
    if (hit !== undefined && hit.until > now()) return hit.rule;
    entries.delete(key);
    const { data, error } = await db.rpc("my_org_auth_status", { p_org_id: orgId });
    if (error !== null) throw new Error(`Cannot read the org's session rules: ${error.message}`);
    const row = (
      (data ?? []) as {
        mfa_required?: boolean;
        mfa_verified?: boolean;
        session_expired?: boolean;
        session_expires_at?: string | null;
        session_ended?: boolean;
      }[]
    )[0];
    const rule: SessionRule =
      row === undefined
        ? "ok"
        : row.session_ended === true
          ? "signed-out"
          : row.session_expired === true
            ? "session-expired"
            : row.mfa_required === true && row.mfa_verified !== true
              ? "mfa"
              : "ok";
    if (ttlMs > 0) {
      const ends = row?.session_expires_at ? Date.parse(row.session_expires_at) : Infinity;
      if (entries.size >= 10_000) entries.clear();
      entries.set(key, { rule, until: Math.min(now() + ttlMs, ends) });
    }
    return rule;
  };
}

/** The 401 for a session an org's security settings no longer accept. */
export function sessionRuleRefused(rule: Exclude<SessionRule, "ok">) {
  return unauthorized(
    rule === "mfa"
      ? "This organization requires a second factor for your role. Verify one in Atlas or Gateway, then send a token from that session."
      : rule === "signed-out"
        ? "This session was signed out. Sign in again, then send the new token."
        : "Your session has run longer than this organization allows. Sign in again, then send the new token.",
  );
}

/** What an OAuth app's token may do: the registered app's org and the person's live grant (A99). */
export interface OAuthAccess {
  readonly orgId: string;
  readonly scopes: readonly string[];
}

/**
 * Reads an OAuth app token's access (`app.my_oauth_access`, migration 1563), reusing it for `ttlMs` per token. No
 * entry for a client no registered app owns; a revoked grant reads as no scopes.
 */
export function createOAuthAccessCheck(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { access: OAuthAccess | null; until: number }>();
  return async (db: XosClient, token: string): Promise<OAuthAccess | null> => {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = entries.get(key);
    if (hit !== undefined && hit.until > now()) return hit.access;
    entries.delete(key);
    const result = await getMyOAuthAccess(db);
    if (!result.ok)
      throw new Error(`Cannot read the app's access: ${JSON.stringify(result.error)}`);
    const access =
      result.data === null ? null : { orgId: result.data.orgId, scopes: result.data.scopes };
    if (ttlMs > 0) {
      if (entries.size >= 10_000) entries.clear();
      entries.set(key, { access, until: now() + ttlMs });
    }
    return access;
  };
}
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
  /** The api-token Edge Function; defaults to `${url}/functions/v1/api-token`. */
  readonly tokenExchangeUrl?: string;
  readonly now?: () => number;
  /**
   * How long a caller's person and memberships are reused across requests, in milliseconds; 30
   * seconds by default, 0 to read them on every request. RLS checks membership on every query
   * whatever this holds, so a stale entry can only pick the org a request is bound to.
   */
  readonly identityTtlMs?: number;
  /**
   * Trusted proxies in front of the one that appends the client address to X-Forwarded-For
   * (`XOS_TRUSTED_PROXY_HOPS`); 0 by default, right on Vercel and behind one proxy (A69-003).
   */
  readonly trustedProxyHops?: number;
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
  const token = sessionTokenFromCookies(
    cookies,
    options.sessionCookie ?? sessionCookieName(options.siteOrigin),
  );
  if (token === null) return null;
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const origin = request.headers.get("origin");
    if (origin === null || origin !== new URL(options.siteOrigin).origin) {
      throw unauthorized("A cross-site request cannot use the Atlas session cookie.");
    }
  }
  return { token, kind: "session-cookie", cookies };
}

/** The caller's person and active memberships, as the org binding needs them. */
interface Identity {
  readonly personId: string;
  readonly orgs: readonly RequestOrg[];
}

/**
 * Reads a caller's identity, reusing it for `ttlMs` (A24-010): the person and membership lookups
 * were two of the round trips every request made before its handler ran. A missing person is never
 * cached, so a person created a moment later is found on the next request.
 */
export function createIdentityCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { identity: Identity; until: number }>();
  return async (db: XosClient, userId: string): Promise<Identity | null> => {
    const hit = entries.get(userId);
    if (hit !== undefined && hit.until > now()) return hit.identity;
    entries.delete(userId);
    const person = await getCurrentPerson(db, userId);
    if (!person.ok) {
      if (person.error.kind === "not-found") return null;
      throw new Error(`Cannot read the caller's person: ${JSON.stringify(person.error)}`);
    }
    const orgs = await listMyOrganizations(db, person.data.id);
    if (!orgs.ok) throw new Error(`Cannot read memberships: ${JSON.stringify(orgs.error)}`);
    const identity: Identity = {
      personId: person.data.id,
      orgs: orgs.data.map((o) => ({ id: o.id, slug: o.slug })),
    };
    if (ttlMs > 0) {
      if (entries.size >= 10_000) entries.clear();
      entries.set(userId, { identity, until: now() + ttlMs });
    }
    return identity;
  };
}

function resolveOrg(
  orgs: readonly RequestOrg[],
  candidates: readonly { readonly id?: string; readonly slug?: string }[],
): RequestOrg | null {
  for (const candidate of candidates) {
    const found = orgs.find(
      (o) =>
        (candidate.id !== undefined && o.id === candidate.id) ||
        (candidate.slug !== undefined && o.slug === candidate.slug),
    );
    if (found !== undefined) return { id: found.id, slug: found.slug };
  }
  const only = orgs.length === 1 ? orgs[0] : undefined;
  return only === undefined ? null : { id: only.id, slug: only.slug };
}

interface ExchangedToken {
  readonly accessToken: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

/**
 * API keys go through the api-token Edge Function (supabase/functions/api-token), which resolves the
 * key with `app.exchange_api_key` and signs a short-lived JWT for the key's service account. The
 * runtime never holds a service role key or a signing key. Tokens are cached in this process,
 * keyed by the SHA-256 of the key, until 30 seconds before they expire.
 */
export function createApiKeyExchange(options: SupabaseAuthOptions) {
  const cache = new Map<string, ExchangedToken>();
  const fetcher = options.fetch ?? fetch;
  const url =
    options.tokenExchangeUrl ?? `${options.url.replace(/\/$/, "")}/functions/v1/api-token`;
  const now = options.now ?? Date.now;
  return async (secret: string): Promise<ExchangedToken | null> => {
    const id = createHash("sha256").update(secret).digest("hex");
    const cached = cache.get(id);
    if (cached !== undefined && cached.expiresAt - 30_000 > now()) return cached;
    cache.delete(id);
    const response = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, apikey: options.anonKey },
    });
    if (response.status === 401) return null;
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      org_id?: string;
      scopes?: string[];
      detail?: string;
    };
    if (response.status === 422) {
      throw unauthorized(body.detail ?? "This API key cannot call the API.");
    }
    if (!response.ok || body.access_token === undefined || body.org_id === undefined) {
      throw new Error(`The API key exchange answered ${response.status}.`);
    }
    const token: ExchangedToken = {
      accessToken: body.access_token,
      orgId: body.org_id,
      scopes: body.scopes ?? [],
      expiresAt: now() + (body.expires_in ?? 0) * 1000,
    };
    if (cache.size >= 10_000) cache.clear();
    cache.set(id, token);
    return token;
  };
}

/**
 * The scopes of a JWT minted for an API key (`amr` method `xos_api_key`), or null for an ordinary
 * session. A minted token without a scopes claim gets no scopes, so it can do nothing scoped.
 */
export function apiKeyTokenScopes(claims: Record<string, unknown>): readonly string[] | null {
  const amr = claims["amr"];
  const minted =
    Array.isArray(amr) &&
    amr.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { method?: unknown }).method === "xos_api_key",
    );
  if (!minted) return null;
  const scopes = claims["scopes"];
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
}

/** The `Authenticate` dependency for Supabase sessions. */
export function createSupabaseAuthenticator(options: SupabaseAuthOptions): Authenticate {
  const locales = options.locales ?? SUPPORTED_LOCALES;
  const exchange = createApiKeyExchange(options);
  const verify = createJwksVerifier({
    url: options.url,
    anonKey: options.anonKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const identityOf = createIdentityCache(options.identityTtlMs ?? 30_000, options.now);
  const networkAllows = createNetworkCheck(options.identityTtlMs ?? 30_000, options.now);
  const sessionRule = createSessionRulesCheck(options.identityTtlMs ?? 30_000, options.now);
  const oauthAccess = createOAuthAccessCheck(options.identityTtlMs ?? 30_000, options.now);
  const admit = async (
    context: RequestContext,
    request: Request,
    memberOf: readonly RequestOrg[],
    sessionToken?: string,
  ): Promise<RequestContext> => {
    const ip = clientIp(request.headers, options.trustedProxyHops ?? 0);
    // A69-010: unbound, the request reaches every org the caller belongs to, so each list applies.
    for (const org of context.org === null ? memberOf : [context.org]) {
      if (!(await networkAllows(context.db, context.user.id, org.id, ip))) throw networkRefused();
      // A77: a session also meets each org's MFA policy and session lifetime (API keys are exempt).
      if (sessionToken !== undefined && context.credential === "session") {
        const rule = await sessionRule(context.db, sessionToken, org.id);
        if (rule !== "ok") throw sessionRuleRefused(rule);
      }
    }
    return context;
  };
  return async (request, requestId): Promise<RequestContext | null> => {
    const credential = readCredential(request, options);
    if (credential === null) return null;
    if (credential.kind === "api-key") {
      const token = await exchange(credential.token);
      if (token === null) return null;
      const db = createCallerClient({
        url: options.url,
        anonKey: options.anonKey,
        accessToken: token.accessToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const userId = String(jwtClaims(token.accessToken)["sub"] ?? "");
      const identity = await identityOf(db, userId);
      if (identity === null) {
        throw new Error("Cannot read the service account's person: not found.");
      }
      return admit(
        {
          user: { id: userId, email: null },
          personId: identity.personId,
          org: resolveOrg(identity.orgs, [{ id: token.orgId }]),
          locale: negotiateLocale(request.headers.get("accept-language"), locales),
          db,
          credential: "api_key",
          scopes: token.scopes,
          requestId,
        },
        request,
        identity.orgs,
      );
    }
    const db = createCallerClient({
      url: options.url,
      anonKey: options.anonKey,
      accessToken: credential.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    let user: { readonly id: string; readonly email: string | null };
    const verified = await verify(credential.token);
    if (verified === null) return null;
    if (verified !== undefined) {
      user = { id: verified.sub, email: verified.email };
    } else {
      const { data, error } = await db.auth.getUser(credential.token);
      if (error !== null || data.user === null) return null;
      user = { id: data.user.id, email: data.user.email ?? null };
    }

    const identity = await identityOf(db, user.id);
    const personId = identity?.personId ?? null;
    if (typeof jwtClaims(credential.token)["client_id"] === "string") {
      // An OAuth app's token (A99): its registered org and the person's live grant, nothing else. A client no
      // registered app owns, or a revoked grant, is not a credential.
      const access = await oauthAccess(db, credential.token);
      if (access === null || access.scopes.length === 0) return null;
      const appOrgs = (identity?.orgs ?? []).filter((o) => o.id === access.orgId);
      return admit(
        {
          user,
          personId,
          org: resolveOrg(appOrgs, [{ id: access.orgId }]),
          locale: negotiateLocale(request.headers.get("accept-language"), locales),
          db,
          credential: "oauth",
          scopes: access.scopes,
          requestId,
        },
        request,
        appOrgs,
      );
    }
    const claim = jwtClaims(credential.token)["org_id"];
    const lastOrg =
      credential.kind === "session-cookie"
        ? credential.cookies.get(options.lastOrgCookie ?? LAST_ORG_COOKIE)
        : undefined;
    const org =
      identity === null
        ? null
        : resolveOrg(identity.orgs, [
            ...(typeof claim === "string" ? [{ id: claim }] : []),
            ...(lastOrg === undefined ? [] : [{ slug: lastOrg }]),
          ]);
    // A token the api-token function minted for an API key keeps that key's scope limit even when the
    // client presents the JWT itself instead of the xos_live_ key.
    const keyScopes = apiKeyTokenScopes(jwtClaims(credential.token));
    return admit(
      {
        user,
        personId,
        org,
        locale: negotiateLocale(request.headers.get("accept-language"), locales),
        db,
        ...(keyScopes === null
          ? { credential: "session" as const }
          : { credential: "api_key" as const, scopes: keyScopes }),
        requestId,
      },
      request,
      identity?.orgs ?? [],
      credential.token,
    );
  };
}
