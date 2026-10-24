import { headers } from "next/headers";
import { cache } from "react";
import { env, platformHosts } from "@/lib/env";
import { isPlatformHost } from "@/lib/shell/standing";

/**
 * OAuth providers Section 9 names (Google, Apple, Microsoft). Gateway offers a provider only when
 * Supabase Auth reports it enabled (`GET /auth/v1/settings`), so the sign-in page never shows a
 * button that cannot work. Enabling one is configuration: `[auth.external.<provider>]` in
 * supabase/config.toml locally, the dashboard in hosted projects.
 */
export const OAUTH_PROVIDERS = ["google", "apple", "azure"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Extra authorization parameters per provider. Google is asked to show its account chooser, so a
 * person signed in to several Google accounts picks the one a request was sent to instead of
 * being signed in silently with another.
 */
export function providerQueryParams(provider: OAuthProvider): Record<string, string> {
  return provider === "google" ? { prompt: "select_account" } : {};
}

/**
 * Whether this request may offer OAuth providers: only on the platform Gateway hosts. The provider
 * returns to GATEWAY_SITE_URL, the one return address Supabase Auth allows, so a sign-in started on
 * an org's custom domain would come back to another host without its PKCE verifier cookie.
 */
export async function offersProviders(): Promise<boolean> {
  return isPlatformHost((await headers()).get("host"), platformHosts(env()));
}

/**
 * Providers Supabase Auth reports enabled that Gateway does not offer. Apple is turned on for Compass's native
 * sign-in (owner decision 20); its web flow needs Apple's own button, Apple's origin in the CSP form-action and a
 * client secret that expires every six months, none of which Gateway has yet (ADR 0036, amendment of 2026-10-23).
 */
const NATIVE_ONLY: readonly OAuthProvider[] = ["apple"];

export function parseEnabledProviders(settings: unknown): OAuthProvider[] {
  const external =
    typeof settings === "object" && settings !== null && "external" in settings
      ? (settings as { external: Record<string, unknown> }).external
      : {};
  return OAUTH_PROVIDERS.filter((p) => external[p] === true && !NATIVE_ONLY.includes(p));
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
