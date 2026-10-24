/**
 * Revoking Compass's Sign in with Apple tokens before an account deletion (ADR 0033 decision 58; App Store Review
 * Guideline 5.1.1(v)): the ES256 client secret, the apple-revoke function's answers and the caller's Apple identity.
 * The key is made at run time for the test, and Apple and Supabase Auth are fakes.
 */
import { describe, expect, it } from "vitest";
import {
  APPLE_ID_ORIGIN,
  CLIENT_SECRET_SECONDS,
  appleClientSecret,
  appleRevokeResponse,
  callerAppleSubjectLoader,
  identityTokenSubject,
  parseAppleRevokeRequest,
  readAppleRevokeEnv,
  unconfiguredAppleSigner,
  webCryptoEs256Signer,
  type AppleRevokeEnv,
  type AppleSecretSigner,
} from "../src/apple-sign-in/revoke.ts";

const CODE = "c1f2e3d4.0.abcd.EfGhIjKlMnOp";
const SUBJECT = "001234.abcdef0123456789abcdef0123456789.0123";
const NOW = new Date("2026-10-24T12:00:00Z");

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(sub: string): string {
  return `${b64url({ alg: "RS256", kid: "apple" })}.${b64url({ iss: APPLE_ID_ORIGIN, sub, aud: "pro.ghxstship.compass" })}.sig`;
}

/** A PEM block; the label is a parameter, as in wallet.test.ts, so the source holds no key-shaped literal. */
function pem(label: string, base64: string): string {
  return `-----BEGIN ${label}-----\n${base64.replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
}

async function keyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { pem: pem("PRIVATE KEY", pkcs8.toString("base64")), publicKey: pair.publicKey };
}

/** A signer that writes the header and claims out, so a test can read what was signed. */
const fakeSigner: AppleSecretSigner = {
  configured: true,
  sign: (header, claims) => Promise.resolve(`${b64url(header)}.${b64url(claims)}.fake`),
};

const apple: AppleRevokeEnv = {
  config: { teamId: "AB12CD34EF", keyId: "KEY1234567", clientIds: ["pro.ghxstship.compass"] },
  signer: fakeSigner,
};

interface Call {
  readonly url: string;
  readonly form: Record<string, string>;
}

/** Apple's two endpoints, answering as told, recording what they were sent. */
function fakeApple(answers: {
  token?: { status: number; body: unknown };
  revoke?: { status: number; body?: unknown };
}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    const answer = url.endsWith("/auth/token")
      ? (answers.token ?? {
          status: 200,
          body: {
            access_token: "access-1",
            refresh_token: "refresh-1",
            id_token: idToken(SUBJECT),
            token_type: "Bearer",
            expires_in: 3600,
          },
        })
      : (answers.revoke ?? { status: 200 });
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchFake, calls };
}

const body = { authorizationCode: CODE, clientId: "pro.ghxstship.compass" };

describe("readAppleRevokeEnv", () => {
  const env = {
    APPLE_TEAM_ID: "AB12CD34EF",
    APPLE_SIGN_IN_KEY_ID: "KEY1234567",
    // As `supabase secrets set` may store it, with its line breaks written as \n.
    APPLE_SIGN_IN_KEY_PEM: pem("PRIVATE KEY", "MIGH").replace(/\n/g, "\\n"),
    APPLE_SIGN_IN_CLIENT_IDS: " pro.ghxstship.compass, com.example.tenant ",
  };

  it("reads the team, the key and the bundle IDs", () => {
    const read = readAppleRevokeEnv(env);
    expect(read?.config).toEqual({
      teamId: "AB12CD34EF",
      keyId: "KEY1234567",
      clientIds: ["pro.ghxstship.compass", "com.example.tenant"],
    });
    expect(read?.signer.configured).toBe(true);
  });

  it("is null until every value is set and well formed", () => {
    expect(readAppleRevokeEnv({})).toBeNull();
    expect(readAppleRevokeEnv({ ...env, APPLE_TEAM_ID: "short" })).toBeNull();
    expect(readAppleRevokeEnv({ ...env, APPLE_SIGN_IN_KEY_ID: "" })).toBeNull();
    expect(readAppleRevokeEnv({ ...env, APPLE_SIGN_IN_CLIENT_IDS: " , " })).toBeNull();
    expect(readAppleRevokeEnv({ ...env, APPLE_SIGN_IN_CLIENT_IDS: "not a bundle id" })).toBeNull();
    expect(
      readAppleRevokeEnv({ ...env, APPLE_SIGN_IN_KEY_PEM: pem("CERTIFICATE", "MIIB") }),
    ).toBeNull();
  });
});

describe("the client secret", () => {
  it("is an ES256 JWT for one app, from the team, to Apple, for five minutes", async () => {
    const { pem, publicKey } = await keyPair();
    const secret = await appleClientSecret(
      { ...apple, signer: webCryptoEs256Signer(pem) },
      "pro.ghxstship.compass",
      NOW,
    );
    const [header, claims, signature] = secret.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: "AB12CD34EF",
      iat,
      exp: iat + CLIENT_SECRET_SECONDS,
      aud: "https://appleid.apple.com",
      sub: "pro.ghxstship.compass",
    });
    const raw = Buffer.from(signature ?? "", "base64url");
    expect(raw).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        raw,
        new TextEncoder().encode(`${header ?? ""}.${claims ?? ""}`),
      ),
    ).toBe(true);
  });

  it("cannot be signed without the key", async () => {
    await expect(
      appleClientSecret(
        { ...apple, signer: unconfiguredAppleSigner },
        "pro.ghxstship.compass",
        NOW,
      ),
    ).rejects.toThrow(/not configured/);
  });
});

describe("parseAppleRevokeRequest and identityTokenSubject", () => {
  it("takes an authorization code and a bundle ID", () => {
    expect(parseAppleRevokeRequest(body)).toEqual(body);
    expect(parseAppleRevokeRequest(null)).toBeNull();
    expect(parseAppleRevokeRequest({ ...body, authorizationCode: "short" })).toBeNull();
    expect(parseAppleRevokeRequest({ ...body, authorizationCode: "has spaces in it" })).toBeNull();
    expect(parseAppleRevokeRequest({ ...body, clientId: "compass" })).toBeNull();
    expect(parseAppleRevokeRequest({ authorizationCode: CODE })).toBeNull();
  });

  it("reads the subject an identity token names", () => {
    expect(identityTokenSubject(idToken(SUBJECT))).toBe(SUBJECT);
    expect(identityTokenSubject("not-a-jwt")).toBeNull();
    expect(identityTokenSubject(`a.${b64url({ iss: "x" })}.c`)).toBeNull();
    expect(identityTokenSubject("a.%%%.c")).toBeNull();
    expect(identityTokenSubject(42)).toBeNull();
  });
});

describe("appleRevokeResponse", () => {
  const deps = (fetchFake: typeof fetch, subject: string | null = SUBJECT) => ({
    apple,
    callerAppleSubject: () => Promise.resolve(subject),
    fetch: fetchFake,
    now: () => NOW,
  });

  it("exchanges the code and revokes the refresh token", async () => {
    const appleFake = fakeApple({});
    const result = await appleRevokeResponse(body, deps(appleFake.fetch));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revoked: true });
    expect(appleFake.calls.map((c) => c.url)).toEqual([
      "https://appleid.apple.com/auth/token",
      "https://appleid.apple.com/auth/revoke",
    ]);
    const [exchange, revoke] = appleFake.calls;
    expect(exchange?.form).toMatchObject({
      client_id: "pro.ghxstship.compass",
      code: CODE,
      grant_type: "authorization_code",
    });
    const claims = JSON.parse(
      Buffer.from(exchange?.form["client_secret"]?.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "AB12CD34EF", sub: "pro.ghxstship.compass" });
    expect(revoke?.form).toEqual({
      client_id: "pro.ghxstship.compass",
      client_secret: exchange?.form["client_secret"],
      token: "refresh-1",
      token_type_hint: "refresh_token",
    });
  });

  it("revokes the access token when Apple returns no refresh token", async () => {
    const appleFake = fakeApple({
      token: { status: 200, body: { access_token: "access-2", id_token: idToken(SUBJECT) } },
    });
    expect((await appleRevokeResponse(body, deps(appleFake.fetch))).status).toBe(200);
    expect(appleFake.calls[1]?.form).toMatchObject({
      token: "access-2",
      token_type_hint: "access_token",
    });
  });

  it("refuses a request that is not one", async () => {
    const result = await appleRevokeResponse(
      { clientId: "pro.ghxstship.compass" },
      deps(fakeApple({}).fetch),
    );
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body)).toMatchObject({ reason: "apple_revoke_request_invalid" });
  });

  it("answers 503 until the key is set, and for an app the key does not serve", async () => {
    const appleFake = fakeApple({});
    const unset = await appleRevokeResponse(body, { ...deps(appleFake.fetch), apple: null });
    expect(unset.status).toBe(503);
    expect(JSON.parse(unset.body)).toMatchObject({ reason: "apple_revoke_not_configured" });
    const unsigned = await appleRevokeResponse(body, {
      ...deps(appleFake.fetch),
      apple: { ...apple, signer: unconfiguredAppleSigner },
    });
    expect(unsigned.status).toBe(503);
    const tenant = await appleRevokeResponse(
      { ...body, clientId: "com.example.tenant" },
      deps(appleFake.fetch),
    );
    expect(tenant.status).toBe(503);
    expect(appleFake.calls).toEqual([]);
  });

  it("answers 409 for an account that does not sign in with Apple, before calling Apple", async () => {
    const appleFake = fakeApple({});
    const result = await appleRevokeResponse(body, deps(appleFake.fetch, null));
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({ reason: "apple_revoke_no_apple_identity" });
    expect(appleFake.calls).toEqual([]);
  });

  it("never revokes another Apple account's tokens", async () => {
    const appleFake = fakeApple({
      token: {
        status: 200,
        body: { refresh_token: "r", id_token: idToken("000999.someone.else") },
      },
    });
    const result = await appleRevokeResponse(body, deps(appleFake.fetch));
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({ reason: "apple_revoke_wrong_account" });
    expect(appleFake.calls.map((c) => c.url)).toEqual(["https://appleid.apple.com/auth/token"]);
  });

  it("passes Apple's error on when the code is refused or the revocation fails", async () => {
    const refused = await appleRevokeResponse(
      body,
      deps(fakeApple({ token: { status: 400, body: { error: "invalid_grant" } } }).fetch),
    );
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toMatchObject({
      reason: "apple_revoke_exchange_failed",
      appleError: "invalid_grant",
    });
    const failed = await appleRevokeResponse(
      body,
      deps(fakeApple({ revoke: { status: 400, body: { error: "invalid_client" } } }).fetch),
    );
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toMatchObject({
      reason: "apple_revoke_failed",
      appleError: "invalid_client",
    });
    const opaque = await appleRevokeResponse(
      body,
      deps(fakeApple({ revoke: { status: 500 } }).fetch),
    );
    expect(JSON.parse(opaque.body)).toMatchObject({ appleError: "http_500" });
    const empty = await appleRevokeResponse(
      body,
      deps(fakeApple({ token: { status: 200, body: { id_token: idToken(SUBJECT) } } }).fetch),
    );
    expect(JSON.parse(empty.body)).toMatchObject({
      reason: "apple_revoke_exchange_failed",
      appleError: "no_token",
    });
  });
});

describe("callerAppleSubjectLoader", () => {
  function auth(status: number, user: unknown): { fetch: typeof fetch; seen: Request[] } {
    const seen: Request[] = [];
    return {
      seen,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(String(input), init));
        return new Response(JSON.stringify(user), { status });
      }) as typeof fetch,
    };
  }
  const options = {
    supabaseUrl: "https://project.supabase.co/",
    anonKey: "anon-key",
    authorization: "Bearer caller-token",
  };

  it("reads the caller's Apple identity with their own token", async () => {
    const fake = auth(200, {
      identities: [
        { provider: "email", id: "x", identity_data: { sub: "x" } },
        { provider: "apple", id: "fallback", identity_data: { sub: SUBJECT } },
      ],
    });
    expect(await callerAppleSubjectLoader({ ...options, fetch: fake.fetch })()).toBe(SUBJECT);
    expect(fake.seen[0]?.url).toBe("https://project.supabase.co/auth/v1/user");
    expect(fake.seen[0]?.headers.get("authorization")).toBe("Bearer caller-token");
    expect(fake.seen[0]?.headers.get("apikey")).toBe("anon-key");
  });

  it("falls back to the identity's id, and is null without an Apple identity", async () => {
    expect(
      await callerAppleSubjectLoader({
        ...options,
        fetch: auth(200, { identities: [{ provider: "apple", id: SUBJECT }] }).fetch,
      })(),
    ).toBe(SUBJECT);
    expect(
      await callerAppleSubjectLoader({
        ...options,
        fetch: auth(200, { identities: [{ provider: "google", id: "g" }, null] }).fetch,
      })(),
    ).toBeNull();
    expect(await callerAppleSubjectLoader({ ...options, fetch: auth(200, {}).fetch })()).toBeNull();
  });

  it("throws when Supabase Auth does not answer", async () => {
    await expect(
      callerAppleSubjectLoader({ ...options, fetch: auth(401, { message: "bad jwt" }).fetch })(),
    ).rejects.toThrow(/HTTP 401/);
  });
});
