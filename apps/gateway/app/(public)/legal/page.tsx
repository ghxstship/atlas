import { legalDay, legalVersionState, type LegalVersion } from "@xos/ui/legal-text";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { GATEWAY_LEGAL_DOCUMENTS } from "@/lib/auth/legal";
import { LEGAL_HISTORY, LEGAL_TEXT } from "@/lib/legal-text.generated";

const ATLAS_LEGAL = "https://atlas.ghxstship.tech/legal";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("gateway.legal"))("indexTitle") };
}

/**
 * Legal (Section 14.4): the documents Gateway serves at /legal/{document} (lib/auth/legal.ts), each with its current
 * version and whether it is a draft, takes effect later or is in effect, the Cookie settings page (A82), and where the
 * public documents Gateway does not serve are: Atlas's own legal page. Someone who trims a document's address finds
 * the rest here instead of a 404 (crawl 4.9). It renders on each request, as the documents do.
 */
export default async function LegalIndexPage() {
  const [t, cookies, format] = await Promise.all([
    getTranslations("gateway.legal"),
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
  const documents = GATEWAY_LEGAL_DOCUMENTS.filter((d) => LEGAL_TEXT[d.slug] !== undefined);
  const link =
    "inline-flex min-h-target-fine items-center text-text-14 font-medium text-accent-text underline";
  return (
    <article className="flex min-w-0 flex-col gap-16">
      <h1 className="m-0 text-heading-24 font-semibold">{t("indexTitle")}</h1>
      <ul className="m-0 flex list-none flex-col gap-12 p-0">
        {documents.map((d) => (
          <li key={d.slug} className="flex flex-col gap-2">
            <Link href={`/legal/${d.slug}` as Route} className={link}>
              {d.title}
            </Link>
            <span className="text-text-13 text-text-secondary">
              {describe(d.version, LEGAL_HISTORY[d.slug]?.[0])}
            </span>
          </li>
        ))}
        <li>
          <Link href={"/legal/cookie-settings" as Route} className={link}>
            {cookies("settingsTitle")}
          </Link>
        </li>
      </ul>
      <p className="m-0 text-text-14 text-text-secondary">
        {t("indexOnAtlas")}{" "}
        <a href={ATLAS_LEGAL} className="text-accent-text underline">
          {t("indexOnAtlasLink")}
        </a>
      </p>
    </article>
  );
}
