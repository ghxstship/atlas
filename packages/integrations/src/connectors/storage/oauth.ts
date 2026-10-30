import { IntegrationError } from "../../framework/errors.ts";
import type { HttpClient } from "../../framework/http.ts";

/**
 * OAuth 2.0 for the storage connections that sign in (B16, ADR 0155 D5; migration 3053): authorization code with
 * PKCE S256 and refresh tokens, on the platform apps the owner registers with Google and Microsoft.
 *
 * - Google Drive asks for drive.readonly with access_type offline and prompt consent, so Google returns a refresh
 *   token every time. drive.readonly is a restricted scope: until Google verifies the app it runs in Testing mode, with
 *   refresh tokens that lapse after 7 days (an owner step).
 * - Microsoft (OneDrive and SharePoint) uses the common tenant and offline_access Files.Read.All User.Read.
 *
 * The connection's credential is the JSON of credentialJson, stored in Vault by app.store_integration_credential; the
 * access token's expiry lives inside it. The worker and storage-browse refresh it 5 minutes before it expires and store
 * the rotated tokens. A refresh Google or Microsoft answers invalid_grant raises credential_revoked, which moves the
 * connection to Error with the reconnect copy. Client secrets, codes and tokens are cut from every error.
 */

export type OAuthStorageProvider = "google_drive" | "onedrive_sharepoint";

export const OAUTH_STORAGE_PROVIDERS: readonly OAuthStorageProvider[] = [
  "google_drive",
  "onedrive_sharepoint",
];

export function isOAuthStorageProvider(code: string): code is OAuthStorageProvider {
  return (OAUTH_STORAGE_PROVIDERS as readonly string[]).includes(code);
}

interface ProviderConfig {
  readonly label: string;
  readonly authorize: string;
  readonly token: string;
  readonly scope: string;
  readonly extra: Readonly<Record<string, string>>;
}

export const OAUTH_PROVIDERS: Readonly<Record<OAuthStorageProvider, ProviderConfig>> = {
  google_drive: {
    label: "Google Drive",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  onedrive_sharepoint: {
    label: "OneDrive",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access Files.Read.All User.Read",
    extra: { response_mode: "query" },
  },
};

/** The platform app's client pair for one provider, from the environment. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The stored credential: what a token answer carries, with the access token's expiry as an ISO instant. */
export interface OAuthCredential {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
}

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The provider's authorization URL for one state and PKCE challenge. */
export function authorizeUrl(
  provider: OAuthStorageProvider,
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const config = OAUTH_PROVIDERS[provider];
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...config.extra,
  });
  return `${config.authorize}?${query.toString()}`;
}

/** The credential as stored in Vault. */
export function credentialJson(credential: OAuthCredential): string {
  return JSON.stringify({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
    expires_at: credential.expires_at,
    scope: credential.scope,
  });
}

function cut(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

interface TokenAnswer {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

async function tokenCall(
  http: HttpClient,
  provider: OAuthStorageProvider,
  form: Readonly<Record<string, string>>,
  secrets: readonly string[],
  now: Date,
): Promise<{ readonly answer: TokenAnswer; readonly expiresAt: string }> {
  const config = OAUTH_PROVIDERS[provider];
  const response = await http({
    method: "POST",
    url: config.token,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  let answer: TokenAnswer = {};
  try {
    answer = JSON.parse(response.body) as TokenAnswer;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (response.status < 200 || response.status >= 300 || answer.access_token === undefined) {
    if (answer.error === "invalid_grant") {
      throw new IntegrationError(
        "credential_revoked",
        `Reconnect ${config.label}: it no longer accepts this connection's sign-in.`,
        {
          connectionError: true,
          status: response.status,
        },
      );
    }
    const detail = cut(
      `${answer.error ?? ""} ${answer.error_description ?? response.body.slice(0, 300)}`.trim(),
      secrets,
    );
    throw new IntegrationError(
      response.status >= 500 ? "provider_unavailable" : "oauth_token_refused",
      `${config.label} refused the token request (${response.status})${detail ? `: ${detail}` : ""}`,
      { retryable: response.status >= 500 || response.status === 429, status: response.status },
    );
  }
  const seconds =
    typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : 3600;
  return { answer, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() };
}

/** Exchanges the authorization code (with its PKCE verifier) for the first credential. */
export async function exchangeCode(
  http: HttpClient,
  provider: OAuthStorageProvider,
  input: OAuthClient & {
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
    readonly now?: Date;
  },
): Promise<OAuthCredential> {
  const secrets = [input.clientSecret, input.code, input.verifier];
  const { answer, expiresAt } = await tokenCall(
    http,
    provider,
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    secrets,
    input.now ?? new Date(),
  );
  if (answer.refresh_token === undefined) {
    throw new IntegrationError(
      "oauth_refresh_token_missing",
      `${OAUTH_PROVIDERS[provider].label} granted no refresh token, so the connection could not stay signed in. Connect again.`,
    );
  }
  return {
    access_token: answer.access_token ?? "",
    refresh_token: answer.refresh_token,
    expires_at: expiresAt,
    scope: answer.scope ?? OAUTH_PROVIDERS[provider].scope,
  };
}

/** A fresh credential from the refresh token; the provider may rotate the refresh token, else the old one stays. */
export async function refreshCredential(
  http: HttpClient,
  provider: OAuthStorageProvider,
  client: OAuthClient,
  credential: OAuthCredential,
  now: Date = new Date(),
): Promise<OAuthCredential> {
  const secrets = [client.clientSecret, credential.refresh_token, credential.access_token];
  const { answer, expiresAt } = await tokenCall(
    http,
    provider,
    {
      grant_type: "refresh_token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: credential.refresh_token,
      ...(provider === "onedrive_sharepoint" ? { scope: OAUTH_PROVIDERS[provider].scope } : {}),
    },
    secrets,
    now,
  );
  return {
    access_token: answer.access_token ?? "",
    refresh_token: answer.refresh_token ?? credential.refresh_token,
    expires_at: expiresAt,
    scope: answer.scope ?? credential.scope,
  };
}

/** Reads a stored OAuth credential, or null when the secret is not one (a pasted token). */
export function readOAuthCredential(secret: string | null): OAuthCredential | null {
  if (secret === null || !secret.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(secret) as Partial<OAuthCredential>;
    if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string")
      return null;
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at:
        typeof parsed.expires_at === "string" ? parsed.expires_at : new Date(0).toISOString(),
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Whether the access token is within the refresh margin of its expiry. */
export function needsRefresh(credential: OAuthCredential, now: Date = new Date()): boolean {
  return Date.parse(credential.expires_at) - REFRESH_MARGIN_MS <= now.getTime();
}

/**
 * The access token to use now: the stored one while it is fresh, else a refreshed one, stored before it is returned
 * (the rotated refresh token with it). A pasted token passes through unchanged.
 */
export async function freshAccessToken(
  http: HttpClient,
  provider: OAuthStorageProvider,
  client: OAuthClient | null,
  secret: string,
  store: (json: string) => Promise<void>,
  now: Date = new Date(),
): Promise<string> {
  const credential = readOAuthCredential(secret);
  if (credential === null) return secret.trim();
  if (!needsRefresh(credential, now)) return credential.access_token;
  if (client === null) {
    throw new IntegrationError(
      "oauth_not_configured",
      `${OAUTH_PROVIDERS[provider].label} is not set up on this XOS, so the connection cannot renew its sign-in.`,
    );
  }
  const next = await refreshCredential(http, provider, client, credential, now);
  await store(credentialJson(next));
  return next.access_token;
}

/** The provider account the sign-in reached, for the connection's external account. */
export interface OAuthAccount {
  readonly id: string;
  readonly name: string;
  /** For OneDrive, the person's drive (provider_settings.drive_id). */
  readonly driveId: string | null;
}

async function getJson<T>(http: HttpClient, label: string, url: string, token: string): Promise<T> {
  const response = await http({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new IntegrationError(
      response.status === 401 || response.status === 403
        ? "credential_refused"
        : "provider_rejected",
      `${label} did not return the signed-in account (${response.status}).`,
      {
        status: response.status,
        connectionError: response.status === 401 || response.status === 403,
      },
    );
  }
  return JSON.parse(response.body) as T;
}

/**
 * The signed-in account: for Google, Drive's about.get (drive.readonly carries no userinfo scope); for Microsoft,
 * Graph /me and the person's drive.
 */
export async function fetchAccount(
  http: HttpClient,
  provider: OAuthStorageProvider,
  accessToken: string,
): Promise<OAuthAccount> {
  if (provider === "google_drive") {
    const about = await getJson<{
      user?: { emailAddress?: string; displayName?: string; permissionId?: string };
    }>(
      http,
      "Google Drive",
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,permissionId)",
      accessToken,
    );
    const user = about.user ?? {};
    return {
      id: user.permissionId ?? user.emailAddress ?? "google",
      name: user.emailAddress ?? user.displayName ?? "Google Drive",
      driveId: null,
    };
  }
  const me = await getJson<{
    id?: string;
    mail?: string | null;
    userPrincipalName?: string;
    displayName?: string;
  }>(
    http,
    "Microsoft",
    "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",
    accessToken,
  );
  const drive = await getJson<{ id?: string }>(
    http,
    "Microsoft",
    "https://graph.microsoft.com/v1.0/me/drive?$select=id",
    accessToken,
  );
  return {
    id: me.id ?? me.userPrincipalName ?? "microsoft",
    name: me.mail ?? me.userPrincipalName ?? me.displayName ?? "OneDrive",
    driveId: drive.id ?? null,
  };
}

/** The platform app's client pair for a provider from the environment, or null when it is not set up. */
export function oauthClientFromEnv(
  provider: OAuthStorageProvider,
  env: Readonly<Record<string, string | undefined>>,
): OAuthClient | null {
  const prefix = provider === "google_drive" ? "XOS_GOOGLE_STORAGE" : "XOS_MICROSOFT_STORAGE";
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
