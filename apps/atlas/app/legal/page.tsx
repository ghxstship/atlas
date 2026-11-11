import { legalDay, legalVersionState, type LegalVersion } from "@xos/ui/legal-text";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";
import { LEGAL_HISTORY, LEGAL_TEXT } from "@/lib/legal-text.generated";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("shell.legal"))("indexTitle") };
}

/**
 * Legal (Section 14.4): every public document Atlas serves at /legal/{document}, in the order legal/index.yaml lists
 * them, each with its current version and whether that version is a draft, takes effect later or is in effect, and
 * the Cookie settings page (A82). Someone who trims a document's address finds the rest here instead of a 404
 * (crawl 4.9). Internal documents are never listed. It renders on each request, as the documents do.
 */
export default async function LegalIndexPage() {
  const [t, cookies, format] = await Promise.all([
    getTranslations("shell.legal"),
    getTranslations("compliance.cookies"),
    getFormatter(),
  ]);
  await connection();
  const today = legalDay(new Date());
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" });
  const describe = (version: string, current: LegalVersion | undefined) => {
    if (current === undefined || current.effectiveDate === null) {
      return t("versionDraft", { version });
    }
    const state = legalVersionState(current, today);
    if (state === "draft") return t("versionDraft", { version });
    const values = { version, date: day(current.effectiveDate) };
    return state === "upcoming" ? t("versionUpcoming", values) : t("versionInEffect", values);
  };
  const documents = LEGAL_DOCUMENTS.filter(
    (d) => d.publish === "public" && LEGAL_TEXT[d.slug] !== undefined,
  );
  return (
    <main id="content" className="flex justify-center p-16 md:p-24">
      <div className="flex w-full max-w-layout-reading min-w-0 flex-col gap-16">
        <div>
          <ButtonLink href="/">{t("action")}</ButtonLink>
        </div>
        <h1 className="m-0 text-heading-24 font-semibold">{t("indexTitle")}</h1>
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {documents.map((d) => (
            <li key={d.slug} className="flex flex-col gap-2">
              <Link
                href={`/legal/${d.slug}` as Route}
                className="inline-flex min-h-target-fine items-center text-text-14 font-medium text-accent-text underline"
              >
                {d.title}
              </Link>
              <span className="text-text-13 text-text-secondary">
                {describe(d.version, LEGAL_HISTORY[d.slug]?.[0])}
              </span>
            </li>
          ))}
          <li>
            <Link
              href={"/legal/cookie-settings" as Route}
              className="inline-flex min-h-target-fine items-center text-text-14 font-medium text-accent-text underline"
            >
              {cookies("settingsTitle")}
            </Link>
          </li>
        </ul>
      </div>
    </main>
  );
}
