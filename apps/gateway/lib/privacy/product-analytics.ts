import "server-only";
import { productAnalyticsAllowed } from "@xos/data/product-analytics";
import { consentState } from "@/lib/privacy/consent";

/**
 * The consent seam for product analytics (Section 11.14, A96, ADR 0052): the one function Gateway asks before any
 * event is collected or recorded. It reads A82's cookie consent (lib/privacy/consent.ts): only a recorded yes to
 * performance cookies allows analytics, and a Global Privacy Control signal, sent now or behind the stored decision,
 * always refuses. A visitor who never chose gets none.
 */
export async function productAnalyticsConsent(): Promise<boolean> {
  const { consent, gpc } = await consentState();
  return productAnalyticsAllowed({
    performance: consent ? consent.performance : null,
    gpc: gpc || (consent?.gpc ?? false),
  });
}
