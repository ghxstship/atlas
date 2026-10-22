import {
  CONSENT_COOKIE,
  parseConsent,
  preferenceCookieOptions,
  preferencesAllowed,
  sendsGpc,
  type CookieConsent,
} from "@xos/data/consent";
import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * The visitor's cookie consent in Gateway (Section 14.3, finding A65-014): the decision in the
 * consent cookie and whether the browser sends Global Privacy Control. Server only.
 */
export interface ConsentState {
  readonly consent: CookieConsent | null;
  readonly gpc: boolean;
  readonly preferences: boolean;
}

export async function consentState(): Promise<ConsentState> {
  const [store, headerStore] = await Promise.all([cookies(), headers()]);
  const consent = parseConsent(store.get(CONSENT_COOKIE)?.value);
  const gpc = sendsGpc(headerStore);
  return { consent, gpc, preferences: preferencesAllowed(consent, gpc) };
}

export function secureCookies(): boolean {
  return env().GATEWAY_SITE_URL.startsWith("https:");
}

/** Options for a Preferences cookie under the visitor's current consent. */
export async function preferenceOptions() {
  return preferenceCookieOptions((await consentState()).preferences, secureCookies());
}
