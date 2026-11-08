import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { legalLinks } from "@/lib/legal-links";

/**
 * The public legal links (RRR-248) on the homepage and the sign-in page: each document in
 * lib/legal-links.ts whose page Atlas serves. A server component of plain links, so it adds no
 * script to the page it sits on.
 */
export async function LegalLinks() {
  const t = await getTranslations("shell.legalLinks");
  return (
    <nav aria-label={t("label")}>
      <ul className="m-0 flex list-none flex-wrap gap-x-16 gap-y-4 p-0">
        {legalLinks().map(({ key, href }) => (
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
