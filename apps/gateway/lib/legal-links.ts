import { gatewayLegalDocument } from "@/lib/auth/legal";

/**
 * The public legal links (RRR-248) on Gateway's sign-in page, the page Gateway's root sends a
 * signed-out visitor to, in the order Atlas's homepage shows them: the Privacy Policy, the Consumer
 * Health Data Privacy Policy (Washington's My Health My Data Act and Nevada SB 370 want it linked
 * from the front door), the Terms of Service, the Worker Terms, Gateway's own agreement, Cookie
 * settings and Contact. `key` names the label in shell.legalLinks.
 */
export const LEGAL_LINK_DOCUMENTS = [
  { key: "privacy", slug: "privacy-policy" },
  { key: "healthData", slug: "consumer-health-data-privacy-policy" },
  { key: "terms", slug: "terms-of-service" },
  { key: "workerTerms", slug: "worker-terms" },
  { key: "cookies", slug: "cookie-settings" },
  { key: "contact", slug: "contact" },
] as const;

export type LegalLinkKey = (typeof LEGAL_LINK_DOCUMENTS)[number]["key"];

/** The Cookie settings page /legal/[document] serves beside Gateway's documents (A82). */
const COOKIE_SETTINGS = "cookie-settings";

/**
 * True when Gateway's /legal/[document] page answers for `slug`: a document in
 * GATEWAY_LEGAL_DOCUMENTS, or Cookie settings. It is the rule that page applies, so a link built
 * here never 404s.
 */
export function servesLegalPage(slug: string): boolean {
  return slug === COOKIE_SETTINGS || gatewayLegalDocument(slug) !== undefined;
}

/**
 * The legal links Gateway shows: those whose page Gateway serves. A document Gateway does not
 * publish stays out until GATEWAY_LEGAL_DOCUMENTS names it; test/legal-links.test.ts fails when
 * legal/index.yaml publishes the Consumer Health Data Privacy Policy and Gateway does not.
 */
export function legalLinks(): { key: LegalLinkKey; href: `/legal/${string}` }[] {
  return LEGAL_LINK_DOCUMENTS.filter((d) => servesLegalPage(d.slug)).map((d) => ({
    key: d.key,
    href: `/legal/${d.slug}`,
  }));
}
