// API key token exchange (ADR 0003; orchestrator decision on API key access, option a). Pure logic with
// Web Crypto only, so it runs in Deno and in the @xos/api tests: a presented `xos_live_` key is resolved
// by app.exchange_api_key and answered with a short-lived Supabase JWT whose subject is the key's service
// account, carrying the key's org and scopes. PostgREST verifies the signature, and RLS sees an ordinary
// member. The function is handed a signer (packages/platform/src/jwt/project-token.ts, ADR 0168): a private JWK
// imported as one of the project's JWT signing keys, never the legacy JWT secret; the key never appears here. A personal API token
// (`xos_pat_`, A86, migration 1432) takes the same exchange: its subject is the token's own person, and
// xos_service_account_id is null.

export const API_KEY_PATTERN = /^xos_(live|pat)_[0-9a-f]{48}$/;
export const TOKEN_TTL_SECONDS = 300;

export interface ExchangeRow {
  readonly api_key_id: string;
  readonly org_id: string;
  readonly scopes: readonly string[];
  readonly user_id: string;
  /** Null for a personal API token, which acts as its person. */
  readonly service_account_id: string | null;
}

/** Null for a key that resolves to nothing; `refusal` when a rule refuses it. */
export type ExchangeResult =
  ExchangeRow | null | { readonly refusal: string; readonly reason: string };

export interface TokenDeps {
  readonly exchange: (secret: string) => Promise<ExchangeResult>;
  /** Signs the token's claims with the project signing key (project-token.ts). */
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
  readonly issuer: string;
  readonly now?: () => number;
}

/** Claims of the token minted for one exchange. */
export function tokenClaims(
  row: ExchangeRow,
  issuer: string,
  nowSeconds: number,
): Record<string, unknown> {
  return {
    iss: issuer,
    sub: row.user_id,
    aud: "authenticated",
    role: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
    org_id: row.org_id,
    scopes: [...row.scopes],
    xos_api_key_id: row.api_key_id,
    xos_service_account_id: row.service_account_id,
    is_anonymous: false,
    amr: [{ method: "xos_api_key", timestamp: nowSeconds }],
  };
}

function problem(
  status: number,
  slug: string,
  title: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ type: `/problems/${slug}`, title, status, detail, ...extra }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="xos"' } : {}),
      },
    },
  );
}

/** POST with `Authorization: Bearer xos_live_...`; answers `{ access_token, token_type, expires_in, org_id, scopes }`. */
export async function handleTokenRequest(request: Request, deps: TokenDeps): Promise<Response> {
  if (request.method !== "POST") {
    return problem(405, "method-not-allowed", "Method Not Allowed", "Exchange a key with POST.");
  }
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  const secret = match?.[1];
  if (secret === undefined || !API_KEY_PATTERN.test(secret)) {
    return problem(
      401,
      "unauthorized",
      "Unauthorized",
      "Send the API key as Authorization: Bearer xos_live_...",
    );
  }
  const result = await deps.exchange(secret);
  if (result === null) {
    return problem(
      401,
      "unauthorized",
      "Unauthorized",
      "This API key is unknown, revoked or expired.",
    );
  }
  if ("refusal" in result) {
    return problem(422, "refused", "Refused", result.reason, {
      refusal: "REFUSE",
      reason: result.reason,
      rule: result.refusal,
    });
  }
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const accessToken = await deps.sign(tokenClaims(result, deps.issuer, nowSeconds));
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: TOKEN_TTL_SECONDS,
      org_id: result.org_id,
      scopes: [...result.scopes],
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

/** Maps the RPC answer: a refusal (SQLSTATE XR001, message `<rule>: <sentence>`) or the first row. */
export function exchangeResult(
  data: unknown,
  error: { code?: string; message: string; hint?: string | null } | null,
): ExchangeResult {
  if (error !== null) {
    if (error.code === "XR001") {
      const rule = error.hint ?? error.message.split(":")[0] ?? "refused";
      const reason = error.message.startsWith(`${rule}: `)
        ? error.message.slice(rule.length + 2)
        : error.message;
      return { refusal: rule, reason };
    }
    throw new Error(`exchange_api_key failed: ${error.message}`);
  }
  const rows = Array.isArray(data) ? (data as ExchangeRow[]) : [];
  return rows[0] ?? null;
}
