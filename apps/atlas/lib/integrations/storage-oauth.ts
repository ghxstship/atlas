import "server-only";
import {
  oauthClientFromEnv,
  type OAuthClient,
  type OAuthStorageProvider,
} from "@xos/integrations/storage-oauth";
import { env } from "@/lib/env";

/**
 * The platform OAuth apps of Google Drive and OneDrive (B16, ADR 0155 D5) from Atlas's validated environment, and
 * the callback every authorization returns to: under the reserved /oauth prefix, inside the proxy so the session is
 * refreshed, and outside every org slug.
 */

export const STORAGE_CALLBACK_PATH = "/oauth/integrations/callback";

export function storageCallbackUrl(): string {
  return `${env().ATLAS_SITE_URL.replace(/\/$/, "")}${STORAGE_CALLBACK_PATH}`;
}

export function storageOAuthClient(provider: OAuthStorageProvider): OAuthClient | null {
  const config = env();
  return oauthClientFromEnv(provider, {
    XOS_GOOGLE_STORAGE_CLIENT_ID: config.XOS_GOOGLE_STORAGE_CLIENT_ID,
    XOS_GOOGLE_STORAGE_CLIENT_SECRET: config.XOS_GOOGLE_STORAGE_CLIENT_SECRET,
    XOS_MICROSOFT_STORAGE_CLIENT_ID: config.XOS_MICROSOFT_STORAGE_CLIENT_ID,
    XOS_MICROSOFT_STORAGE_CLIENT_SECRET: config.XOS_MICROSOFT_STORAGE_CLIENT_SECRET,
  });
}
