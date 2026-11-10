import {
  isDraftVersion,
  LegalContents,
  LegalHistory,
  LegalText,
  legalDay,
  legalVersionInEffect,
  legalVersionState,
  parseLegalMarkdown,
  type LegalVersion,
} from "@xos/ui/legal-text";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { CookieSettings } from "@/components/privacy/cookie-settings";
import { ButtonLink, InlineAlert } from "@/components/ui";
import { gatewayLegalDocument } from "@/lib/auth/legal";
import { LEGAL_HISTORY, LEGAL_SLUGS, LEGAL_TEXT } from "@/lib/legal-text.generated";

/**
 * The legal documents Gateway serves (Section 14.4, finding A59-025, lib/auth/legal.ts), public and
 * server-rendered from the text generate:legal puts in lib/legal-text.generated.ts. The public
 * layout is already the reading column, so the outline sits in the page's flow. While a document's
 * version ends in -draft the page opens by saying it is a draft and not in effect. A final version
 * opens with its effective date, from the document's frontmatter: before that day, the notice
 * period of Terms of Service 15, the page says it is not yet in effect and names the version that
 * stays in effect until then; from that day it says the version is in effect. The page renders on
 * each request, so the change comes on the day. It ends with every version, newest first, with its
 * effective date and summary of changes (Terms of Service 15). A public document Gateway does not
 * serve is on Atlas, the address the documents themselves give for it (legal/privacy-policy.md,
 * Contact Page).
 * `/legal/cookie-settings` is the Cookie settings page the Cookie Policy names (Section 14.3, A82).
 * Any other slug answers 404.
 */
const COOKIE_SETTINGS = "cookie-settings";
const ATLAS = "https://atlas.ghxstship.tech";

function documentHref(slug: string): string | null {
  if (slug === COOKIE_SETTINGS || gatewayLegalDocument(slug)) return `/legal/${slug}`;
  return LEGAL_SLUGS.includes(slug) ? `${ATLAS}/legal/${slug}` : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/legal/[document]">): Promise<Metadata> {
  const slug = (await params).document;
  if (slug === COOKIE_SETTINGS) {
    return { title: (await getTranslations("compliance.cookies"))("settingsTitle") };
  }
  const doc = gatewayLegalDocument(slug);
  return doc ? { title: doc.title } : {};
}

export default async function LegalPage({ params }: PageProps<"/legal/[document]">) {
  const slug = (await params).document;
  if (slug === COOKIE_SETTINGS) return <CookieSettings />;
  const doc = gatewayLegalDocument(slug);
  const text = LEGAL_TEXT[slug];
  if (!doc || text === undefined) notFound();
  const [t, locale, format] = await Promise.all([
    getTranslations("gateway.legal"),
    getLocale(),
    getFormatter(),
  ]);
  const history = LEGAL_HISTORY[slug] ?? [];
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" });
  // Rendered on each request, so a version is called upcoming only until its effective date.
  await connection();
  const today = legalDay(new Date());
  const describe = (v: LegalVersion) => {
    const state = legalVersionState(v, today);
    if (state === "draft" || v.effectiveDate === null) {
      return t("versionDraft", { version: v.version });
    }
    const values = { version: v.version, date: day(v.effectiveDate) };
    return state === "upcoming" ? t("versionUpcoming", values) : t("versionInEffect", values);
  };
  // The current version opens the page: a draft, final but before its date, or in effect.
  const standing = () => {
    const current = history[0];
    if (isDraftVersion(doc.version)) {
      return (
        <InlineAlert tone="warning" title={t("draftTitle")}>
          {t("draftNotice", { version: doc.version })}
        </InlineAlert>
      );
    }
    if (current === undefined || current.effectiveDate === null) return null;
    const date = day(current.effectiveDate);
    if (legalVersionState(current, today) === "inEffect") {
      return (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("inEffect", { version: doc.version, date })}
        </p>
      );
    }
    const earlier = legalVersionInEffect(history, today);
    return (
      <InlineAlert tone="info" title={t("upcomingTitle")}>
        {t("upcomingNotice", { version: doc.version, date })}
        {earlier ? ` ${t("upcomingEarlier", { version: earlier.version })}` : null}
      </InlineAlert>
    );
  };
  const blocks = parseLegalMarkdown(text);
  return (
    <article className="flex min-w-0 flex-col gap-16 leading-relaxed">
      {standing()}
      {locale.startsWith("en") ? null : (
        <p className="m-0 text-text-14 text-text-secondary">{t("englishOnly")}</p>
      )}
      <LegalContents blocks={blocks} label={t("contents")} />
      <LegalText blocks={blocks} hrefFor={documentHref} />
      <LegalHistory history={history} title={t("history")} describe={describe} />
      <div>
        <ButtonLink href="/">{t("back")}</ButtonLink>
      </div>
    </article>
  );
}
