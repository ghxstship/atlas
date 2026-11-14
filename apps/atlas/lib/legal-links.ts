import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * The public legal links (RRR-248), in the order the footer shows them: the Privacy Policy, the
 * Consumer Health Data Privacy Policy (Washington's My Health My Data Act and Nevada SB 370 want it
 * linked from the homepage), the Terms of Service, the Worker Terms, Cookie settings and Contact.
 * `key` names the label in shell.legalLinks.
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

/** The Cookie settings page /legal/[document] serves beside the registry's documents (A82). */
const COOKIE_SETTINGS = "cookie-settings";

/**
 * True when Atlas's /legal/[document] page answers for `slug`: a document legal/index.yaml publishes
 * as public, or Cookie settings. It is the rule that page applies, so a link built here never 404s.
 */
export function servesLegalPage(slug: string): boolean {
  return (
    slug === COOKIE_SETTINGS ||
    LEGAL_DOCUMENTS.some((d) => d.slug === slug && d.publish === "public")
  );
}

/**
 * The legal links Atlas shows: those whose page Atlas serves. A document the registry does not
 * publish yet, such as the Consumer Health Data Privacy Policy before its text lands, stays out of
 * the footer until it is published, and then appears without a change here.
 */
export function legalLinks(): { key: LegalLinkKey; href: `/legal/${string}` }[] {
  return LEGAL_LINK_DOCUMENTS.filter((d) => servesLegalPage(d.slug)).map((d) => ({
    key: d.key,
    href: `/legal/${d.slug}`,
  }));
}

/**
 * The pages the consent to texts links in Personal settings, Notifications (RRR-266): the Text
 * Message Terms and the Privacy Policy's section on text messages. US carriers review the consent
 * statement for both links.
 */
export const SMS_CONSENT_LINKS = {
  terms: "/legal/text-message-terms",
  privacy: "/legal/privacy-policy#section-17",
} as const;
