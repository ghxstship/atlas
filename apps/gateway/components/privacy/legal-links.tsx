import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * The public legal links (RRR-248): the Privacy Policy, the Consumer Health Data Privacy Policy
 * (Washington's My Health My Data Act and Nevada SB 370 want it linked from the homepage), the Terms
 * of Service, Cookie settings and Contact. The slugs are the legal/index.yaml documents the legal
 * page serves. A server component of plain links, so it adds no script to the page it sits on.
 */
export const LEGAL_LINKS = [
  { key: "privacy", href: "/legal/privacy-policy" },
  { key: "healthData", href: "/legal/consumer-health-data-privacy-policy" },
  { key: "terms", href: "/legal/terms-of-service" },
  { key: "cookies", href: "/legal/cookie-settings" },
  { key: "contact", href: "/legal/contact" },
] as const;

export async function LegalLinks() {
  const t = await getTranslations("shell.legalLinks");
  return (
    <nav aria-label={t("label")}>
      <ul className="m-0 flex list-none flex-wrap gap-x-16 gap-y-4 p-0">
        {LEGAL_LINKS.map(({ key, href }) => (
          <li key={key}>
            <Link
              href={href as Route}
              className="inline-flex min-h-target-fine items-center text-text-12 text-text-secondary underline hover:text-text-primary pointer-coarse:min-h-target-coarse"
            >
              {t(key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
