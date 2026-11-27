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
import { hidesCookieBanner } from "@/lib/shell/public-live-path";

/**
 * The visitor's cookie consent in Atlas (Section 14.3, finding A65-014): the decision in the
 * consent cookie and whether the browser sends Global Privacy Control. Server only.
 */
export interface ConsentState {
  readonly consent: CookieConsent | null;
  /** The request carries `Sec-GPC: 1`. */
  readonly gpc: boolean;
  /** Preferences cookies may outlast the visit. */
  readonly preferences: boolean;
}

export async function consentState(): Promise<ConsentState> {
  const [store, headerStore] = await Promise.all([cookies(), headers()]);
  const consent = parseConsent(store.get(CONSENT_COOKIE)?.value);
  const gpc = sendsGpc(headerStore);
  return { consent, gpc, preferences: preferencesAllowed(consent, gpc) };
}

/**
 * Whether the cookie banner asks this visitor: until they choose, and never under Global Privacy
 * Control. The banner (components/privacy/consent-banner.tsx) and the shell, which keeps the help
 * tour offer and tips off the bar while it shows, read the same answer.
 */
export function bannerPending(state: ConsentState): boolean {
  return state.consent === null && !state.gpc;
}

/** Whether the cookie bar is on the page at `path`: the banner asks, and the page keeps it on. */
export async function cookieBarShows(path: string): Promise<boolean> {
  return !hidesCookieBanner(path) && bannerPending(await consentState());
}

export function secureCookies(): boolean {
  return env().ATLAS_SITE_URL.startsWith("https:");
}

/** Options for a Preferences cookie under the visitor's current consent. */
export async function preferenceOptions() {
  return preferenceCookieOptions((await consentState()).preferences, secureCookies());
}
