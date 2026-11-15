import {
  CONSENT_COOKIE,
  consentCookieOptions,
  newVisitorId,
  parseConsent,
  preferenceCookieOptions,
  recordCookieConsent,
  serializeConsent,
} from "@xos/data/consent";
import type { XosClient } from "@xos/data";
import type { ConsentAdapter } from "@xos/ui/consent";
import { LOCALE_COOKIE } from "@/i18n/negotiate";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { WORKSPACE_COOKIE } from "@/lib/shell/workspace";
import { THEME_COOKIE } from "@/lib/theme";

/** The optional cookie categories Atlas offers (legal/cookie-policy.md section 3). */
export const CONSENT_CATEGORIES = ["preferences", "performance"] as const;

/** The Preferences cookies Atlas sets (legal/cookie-policy.md section 3). */
const PREFERENCE_COOKIES = [
  LOCALE_COOKIE,
  THEME_COOKIE,
  WORKSPACE_COOKIE,
  LAST_ORG_COOKIE,
] as const;

/** The request's cookies, as `cookies()` from next/headers gives them. */
interface CookieJar {
  get(name: string): { readonly value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): unknown;
}

export interface AtlasConsentContext {
  readonly db: XosClient;
  readonly cookies: CookieJar;
  /** The site is served over https, so cookies are marked Secure. */
  readonly secure: boolean;
  /** Told when the consent log refused the write; the choice still takes effect in the browser. */
  readonly onUnrecorded?: (error: unknown) => void;
}

/**
 * Atlas's `ConsentAdapter` (Section 14.3, finding A65-014), the database-backed side of the banner
 * in @xos/ui. A decision goes to the server-side consent log (api_public.record_cookie_consent)
 * with the visitor id the consent cookie holds, the policy version and the Global Privacy Control
 * flag; the database stamps the time of the write. Then the consent cookie is set, and refusing
 * Preferences turns the existing Preferences cookies into cookies that end with the visit.
 */
export function atlasConsentAdapter(context: AtlasConsentContext): ConsentAdapter {
  const { db, cookies, secure } = context;
  const current = () => parseConsent(cookies.get(CONSENT_COOKIE)?.value);
  return {
    read() {
      const consent = current();
      return Promise.resolve(
        consent === null
          ? null
          : {
              categories: { preferences: consent.preferences, performance: consent.performance },
              gpc: consent.gpc,
            },
      );
    },
    async write(decision) {
      const consent = {
        visitorId: current()?.visitorId ?? newVisitorId(),
        preferences: !decision.gpc && decision.categories["preferences"] === true,
        performance: !decision.gpc && decision.categories["performance"] === true,
        gpc: decision.gpc,
      };
      const recorded = await recordCookieConsent(db, consent, null, decision.policyVersion);
      if (!recorded.ok) context.onUnrecorded?.(recorded.error);
      cookies.set(CONSENT_COOKIE, serializeConsent(consent), consentCookieOptions(secure));
      if (!consent.preferences) {
        for (const name of PREFERENCE_COOKIES) {
          const value = cookies.get(name)?.value;
          if (value !== undefined) cookies.set(name, value, preferenceCookieOptions(false, secure));
        }
      }
    },
  };
}
