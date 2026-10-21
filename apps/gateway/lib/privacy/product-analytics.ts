import "server-only";
import { productAnalyticsAllowed, sendsGlobalPrivacyControl } from "@xos/data/product-analytics";
import { headers } from "next/headers";

/**
 * The consent seam for product analytics (Section 11.14, A96, ADR 0052): the one function Gateway asks before any
 * event is collected or recorded. A82's cookie banner feeds it: once its consent cookie lands, `performance` here
 * reads the person's choice for performance cookies. Until then no choice is read, so the answer is always no, and
 * a browser sending Global Privacy Control is always no.
 */
export async function productAnalyticsConsent(): Promise<boolean> {
  const requestHeaders = await headers();
  return productAnalyticsAllowed({
    performance: null,
    gpc: sendsGlobalPrivacyControl(requestHeaders),
  });
}
