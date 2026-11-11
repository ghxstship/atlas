/**
 * Revoking Compass's Sign in with Apple tokens when a person deletes their account (ADR 0033 decision 58; App Store
 * Review Guideline 5.1.1(v); ADR 0036, amendment of 2026-10-23). Just before the deletion Compass asks Apple's sheet
 * once more for a fresh authorization code and posts it to the apple-revoke Edge Function, which exchanges it at
 * Apple's token endpoint and revokes the refresh token Apple returns. Nothing is stored: the code is good once and for
 * five minutes, and the tokens leave with the request.
 *
 * Apple's endpoints take a client secret: an ES256 JWT that the Sign in with Apple key signs, with the team as issuer
 * and the app's bundle ID as subject. The key is an owner secret (APPLE_SIGN_IN_KEY_PEM, with APPLE_SIGN_IN_KEY_ID,
 * APPLE_TEAM_ID and the bundle IDs in APPLE_SIGN_IN_CLIENT_IDS); until it is set the function answers 503
 * apple_revoke_not_configured, and Compass tells the person how to remove Compass from their Apple Account themselves.
 * Signing is a seam (AppleSecretSigner), so tests use a fake.
 *
 * Only the Apple account the caller signed in with is revoked: the identity token Apple returns with the tokens must
 * name the subject of the caller's own Apple identity in Supabase Auth, read with the caller's token. It loads no npm
 * package (A85).
 */
export const APPLE_ID_ORIGIN = "https://appleid.apple.com";

/** How long a client secret lives. Apple allows six months; each one here signs a single request. */
export const CLIENT_SECRET_SECONDS = 300;

export interface AppleRevokeConfig {
  /** The Apple Developer team that owns the key: the client secret's issuer. */
  readonly teamId: string;
  /** The Sign in with Apple key's ID: the client secret's kid. */
  readonly keyId: string;
  /** The bundle IDs whose authorization codes the key may exchange, Compass's first. */
  readonly clientIds: readonly string[];
}

/** Signs a JWT with ES256; the real one holds the Sign in with Apple key. */
export interface AppleSecretSigner {
  readonly configured: boolean;
  sign(
    header: Readonly<Record<string, unknown>>,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<string>;
}

export interface AppleRevokeEnv {
  readonly config: AppleRevokeConfig;
  readonly signer: AppleSecretSigner;
}

// base64url and the PEM body as wallet/google.ts and wallet/der.ts have them, kept here so this function's bundle
// shares no chunk with wallet-pass, whose colors pull in the design tokens.
function base64Url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("PEM: empty");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * ES256 with Web Crypto from the key's PKCS #8 PEM (the .p8 file Apple offers once). Web Crypto's ECDSA signature is
 * the 64-byte r and s that JWS expects.
 */
export function webCryptoEs256Signer(privateKeyPem: string): AppleSecretSigner {
  return {
    configured: true,
    async sign(header, claims) {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToDer(privateKeyPem) as BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const input = `${encode(header)}.${encode(claims)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          new TextEncoder().encode(input) as BufferSource,
        ),
      );
      return `${input}.${base64Url(signature)}`;
    },
  };
}

export const unconfiguredAppleSigner: AppleSecretSigner = {
  configured: false,
  sign: () => Promise.reject(new Error("The Sign in with Apple key is not configured.")),
};

const TEN = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The Edge Function's Apple settings, or null until every one of them is set and well formed. */
export function readAppleRevokeEnv(
  env: Readonly<Record<string, string | undefined>>,
): AppleRevokeEnv | null {
  const teamId = env["APPLE_TEAM_ID"] ?? "";
  const keyId = env["APPLE_SIGN_IN_KEY_ID"] ?? "";
  const privateKeyPem = (env["APPLE_SIGN_IN_KEY_PEM"] ?? "").replace(/\\n/g, "\n");
  const clientIds = (env["APPLE_SIGN_IN_CLIENT_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (!TEN.test(teamId) || !TEN.test(keyId)) return null;
  if (clientIds.length === 0 || !clientIds.every((id) => BUNDLE_ID.test(id))) return null;
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) return null;
  return { config: { teamId, keyId, clientIds }, signer: webCryptoEs256Signer(privateKeyPem) };
}

/** The client secret for one request to Apple on behalf of an app (its bundle ID). */
export function appleClientSecret(
  apple: AppleRevokeEnv,
  clientId: string,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return apple.signer.sign(
    { alg: "ES256", kid: apple.config.keyId },
    {
      iss: apple.config.teamId,
      iat,
      exp: iat + CLIENT_SECRET_SECONDS,
      aud: APPLE_ID_ORIGIN,
      sub: clientId,
    },
  );
}

export interface AppleRevokeRequest {
  /** The authorization code from Apple's sheet, just now. */
  readonly authorizationCode: string;
  /** The bundle ID of the app that asked for it. */
  readonly clientId: string;
}

/** The request, or null when it is not one. */
export function parseAppleRevokeRequest(body: unknown): AppleRevokeRequest | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const code = b["authorizationCode"];
  const clientId = b["clientId"];
  if (typeof code !== "string" || !/^[A-Za-z0-9._-]{8,2000}$/.test(code)) return null;
  if (typeof clientId !== "string" || clientId.length > 200 || !BUNDLE_ID.test(clientId))
    return null;
  return { authorizationCode: code, clientId };
}

/** The subject (Apple's user id) an identity token names, or null when it cannot be read. */
export function identityTokenSubject(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))),
    ) as unknown;
    const sub =
      claims !== null && typeof claims === "object"
        ? (claims as Record<string, unknown>)["sub"]
        : null;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}

export interface AppleRevokeDeps {
  readonly apple: AppleRevokeEnv | null;
  /** The subject of the caller's own Apple identity in Supabase Auth, or null when they have none. */
  readonly callerAppleSubject: () => Promise<string | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface AppleRevokeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function problem(
  status: number,
  reason: string,
  title: string,
  extra: Readonly<Record<string, string>> = {},
): AppleRevokeResponse {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({
      type: `/problems/${reason.replaceAll("_", "-")}`,
      title,
      status,
      reason,
      ...extra,
    }),
  };
}

/** Apple's error code from a failed answer ({"error": "invalid_grant"}), or the HTTP status. */
async function appleError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    const code =
      body !== null && typeof body === "object" ? (body as Record<string, unknown>)["error"] : null;
    if (typeof code === "string" && /^[a-z_]{1,60}$/.test(code)) return code;
  } catch {
    // Not JSON: the status says enough.
  }
  return `http_${String(response.status)}`;
}

function form(fields: Readonly<Record<string, string>>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** The apple-revoke function's answer to one request. */
export async function appleRevokeResponse(
  body: unknown,
  deps: AppleRevokeDeps,
): Promise<AppleRevokeResponse> {
  const request = parseAppleRevokeRequest(body);
  if (!request)
    return problem(422, "apple_revoke_request_invalid", "The revocation request is not valid.");
  const apple = deps.apple;
  if (!apple || !apple.signer.configured)
    return problem(
      503,
      "apple_revoke_not_configured",
      "Sign in with Apple revocation is not set up yet.",
    );
  if (!apple.config.clientIds.includes(request.clientId))
    return problem(
      503,
      "apple_revoke_not_configured",
      "Sign in with Apple revocation is not set up for this app.",
    );
  const subject = await deps.callerAppleSubject();
  if (subject === null)
    return problem(
      409,
      "apple_revoke_no_apple_identity",
      "This account does not sign in with Apple.",
    );

  const send = deps.fetch ?? fetch;
  const secret = await appleClientSecret(
    apple,
    request.clientId,
    (deps.now ?? (() => new Date()))(),
  );
  const exchanged = await send(
    `${APPLE_ID_ORIGIN}/auth/token`,
    form({
      client_id: request.clientId,
      client_secret: secret,
      code: request.authorizationCode,
      grant_type: "authorization_code",
    }),
  );
  if (!exchanged.ok)
    return problem(
      502,
      "apple_revoke_exchange_failed",
      "Apple did not accept the authorization code.",
      {
        appleError: await appleError(exchanged),
      },
    );
  const tokens = (await exchanged.json()) as Record<string, unknown>;
  // The code must come from the Apple account this person signed in with, never someone else's.
  if (identityTokenSubject(tokens["id_token"]) !== subject)
    return problem(
      403,
      "apple_revoke_wrong_account",
      "That Apple account is not the one this account signs in with.",
    );
  const refresh = typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : null;
  const access = typeof tokens["access_token"] === "string" ? tokens["access_token"] : null;
  const token = refresh ?? access;
  if (token === null)
    return problem(502, "apple_revoke_exchange_failed", "Apple returned no token to revoke.", {
      appleError: "no_token",
    });
  const revoked = await send(
    `${APPLE_ID_ORIGIN}/auth/revoke`,
    form({
      client_id: request.clientId,
      client_secret: secret,
      token,
      token_type_hint: refresh !== null ? "refresh_token" : "access_token",
    }),
  );
  if (!revoked.ok)
    return problem(502, "apple_revoke_failed", "Apple did not revoke the token.", {
      appleError: await appleError(revoked),
    });
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ revoked: true }),
  };
}

/**
 * The subject of the caller's own Apple identity, read from Supabase Auth with the caller's token (never the service
 * role); null when the account has no Apple identity.
 */
export function callerAppleSubjectLoader(options: {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly authorization: string;
  readonly fetch?: typeof fetch;
}): () => Promise<string | null> {
  const send = options.fetch ?? fetch;
  return async () => {
    const response = await send(`${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: {
        apikey: options.anonKey,
        authorization: options.authorization,
        accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`auth user failed: HTTP ${String(response.status)}`);
    const user = (await response.json()) as { identities?: unknown };
    const identities = Array.isArray(user.identities) ? (user.identities as unknown[]) : [];
    for (const identity of identities) {
      if (identity === null || typeof identity !== "object") continue;
      const i = identity as Record<string, unknown>;
      if (i["provider"] !== "apple") continue;
      const data = i["identity_data"];
      const sub =
        data !== null && typeof data === "object" ? (data as Record<string, unknown>)["sub"] : null;
      if (typeof sub === "string" && sub !== "") return sub;
      if (typeof i["id"] === "string" && i["id"] !== "") return i["id"];
    }
    return null;
  };
}
