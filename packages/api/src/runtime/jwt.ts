import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

/**
 * Local verification of Supabase session JWTs against the project's JSON Web Key Set (A24-010).
 *
 * Supabase Auth signs sessions with an asymmetric key (ES256, or RS256) and publishes the public
 * keys at `/auth/v1/.well-known/jwks.json`. Verifying the signature here, with the key set cached
 * in the process, replaces a round trip to Auth on every API request. PostgREST accepts the same
 * token on the same terms (signature and expiry), so this grants nothing RLS would not.
 *
 * A token this cannot judge (a symmetric HS256 token, or a key id the set does not hold even after
 * one refetch) returns `undefined`, and the caller asks Auth instead.
 */

export interface VerifiedClaims {
  readonly sub: string;
  readonly email: string | null;
  readonly claims: Record<string, unknown>;
}

export interface JwksVerifierOptions {
  /** Supabase API origin. */
  readonly url: string;
  readonly anonKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long a fetched key set is trusted before it is fetched again; 10 minutes by default. */
  readonly ttlMs?: number;
}

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly [key: string]: unknown;
}

/** The signature checks each supported algorithm needs from node:crypto. */
const ALGORITHMS: Record<string, { readonly kty: string; readonly dsaEncoding?: "ieee-p1363" }> = {
  ES256: { kty: "EC", dsaEncoding: "ieee-p1363" },
  RS256: { kty: "RSA" },
};

/** Clock skew tolerated on `exp` and `nbf`, in seconds. */
const LEEWAY_SECONDS = 30;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * A verifier bound to one Supabase project. Answers the verified claims, `null` for a token that
 * is malformed, badly signed or expired, or `undefined` when only Auth can judge it.
 */
export function createJwksVerifier(options: JwksVerifierOptions) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 600_000;
  const jwksUrl = `${options.url.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  const issuer = `${options.url.replace(/\/$/, "")}/auth/v1`;
  let keys: Map<string, KeyObject> | null = null;
  let fetchedAt = 0;
  /** No fetch, forced or not, before this time: 5 seconds after a fetch, 30 after a failure. */
  let retryAfter = 0;
  let pending: Promise<Map<string, KeyObject>> | null = null;

  async function load(): Promise<Map<string, KeyObject>> {
    const response = await fetcher(jwksUrl, { headers: { apikey: options.anonKey } });
    if (!response.ok) throw new Error(`The JWKS endpoint answered ${response.status}.`);
    const body = (await response.json()) as { keys?: Jwk[] };
    const out = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      const alg = jwk.alg ?? (jwk.kty === "EC" ? "ES256" : jwk.kty === "RSA" ? "RS256" : "");
      const spec = ALGORITHMS[alg];
      if (spec === undefined || jwk.kid === undefined || jwk.kty !== spec.kty) continue;
      out.set(`${alg}:${jwk.kid}`, createPublicKey({ key: { ...jwk }, format: "jwk" }));
    }
    keys = out;
    fetchedAt = now();
    retryAfter = fetchedAt + 5_000;
    return out;
  }

  /**
   * The key set, fetched once per TTL however many requests arrive together. When the endpoint
   * cannot answer, the failure is reported, the last good set (or none, so Auth decides) stands,
   * and the fetch is retried after 30 seconds rather than on every request.
   */
  async function keySet(force: boolean): Promise<Map<string, KeyObject>> {
    if (now() < retryAfter) return keys ?? new Map();
    if (!force && keys !== null && now() - fetchedAt < ttl) return keys;
    pending ??= load()
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: "warn",
            source: "api.jwks",
            message: "JWKS unavailable; Supabase Auth verifies tokens until it answers",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        retryAfter = now() + 30_000;
        return keys ?? new Map<string, KeyObject>();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return async (token: string): Promise<VerifiedClaims | null | undefined> => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, signature] = parts as [string, string, string];
    const header = decodeJson(head);
    if (header === null) return null;
    const alg = typeof header["alg"] === "string" ? header["alg"] : "";
    const kid = typeof header["kid"] === "string" ? header["kid"] : "";
    const spec = ALGORITHMS[alg];
    if (spec === undefined || kid === "") return undefined;

    let key = (await keySet(false)).get(`${alg}:${kid}`);
    // A key id the cached set lacks may be a rotated-in key: refetch once before giving up.
    if (key === undefined) key = (await keySet(true)).get(`${alg}:${kid}`);
    if (key === undefined) return undefined;

    const valid = verifySignature(
      "sha256",
      Buffer.from(`${head}.${body}`),
      spec.dsaEncoding === undefined ? key : { key, dsaEncoding: spec.dsaEncoding },
      Buffer.from(signature, "base64url"),
    );
    if (!valid) return null;
    const claims = decodeJson(body);
    if (claims === null) return null;
    const seconds = now() / 1000;
    const exp = claims["exp"];
    if (typeof exp !== "number" || exp + LEEWAY_SECONDS < seconds) return null;
    const nbf = claims["nbf"];
    if (typeof nbf === "number" && nbf - LEEWAY_SECONDS > seconds) return null;
    // Another issuer (a custom Auth domain in front of this origin) is for Auth to judge.
    if (claims["iss"] !== undefined && claims["iss"] !== issuer) return undefined;
    const sub = claims["sub"];
    if (typeof sub !== "string" || sub === "" || claims["role"] === "anon") return null;
    const email = claims["email"];
    return { sub, email: typeof email === "string" && email !== "" ? email : null, claims };
  };
}
