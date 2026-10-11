import { cache } from "react";
import { env } from "@/lib/env";

/**
 * OAuth providers Section 9 names (Google, Apple, Microsoft). Atlas offers a provider only when
 * Supabase Auth reports it enabled (`GET /auth/v1/settings`), so the sign-in page never shows a
 * button that cannot work. Enabling one is configuration: `[auth.external.<provider>]` in
 * supabase/config.toml locally, the dashboard in hosted projects.
 */
export const OAUTH_PROVIDERS = ["google", "apple", "azure"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function parseEnabledProviders(settings: unknown): OAuthProvider[] {
  const external =
    typeof settings === "object" && settings !== null && "external" in settings
      ? (settings as { external: Record<string, unknown> }).external
      : {};
  return OAUTH_PROVIDERS.filter((p) => external[p] === true);
}

export const enabledProviders = cache(async (): Promise<OAuthProvider[]> => {
  const config = env();
  const response = await fetch(new URL("/auth/v1/settings", config.SUPABASE_URL), {
    headers: { apikey: config.SUPABASE_ANON_KEY },
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth settings returned ${response.status}`);
  }
  return parseEnabledProviders(await response.json());
});
