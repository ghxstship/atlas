import {
  isDraftVersion,
  LegalContents,
  LegalHistory,
  LegalOutline,
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
import { ConsentSettings } from "@/components/privacy/consent-settings";
import { SubprocessorNotices } from "@/components/privacy/subprocessor-notices";
import { ButtonLink, InlineAlert, TemplateDocument } from "@/components/ui";
import { LEGAL_HISTORY, LEGAL_SLUGS, LEGAL_TEXT } from "@/lib/legal-text.generated";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Published legal documents (Section 14.4), public, server-rendered in the Document template from
 * the text generate:routes puts in lib/legal-text.generated.ts. While a document's version in
 * legal/index.yaml ends in -draft the page opens by saying it is a draft and not in effect. A final
 * version opens with its effective date, from the document's frontmatter: before that day, the
 * notice period of Terms of Service 15, the page says it is not yet in effect and names the version
 * that stays in effect until then; from that day it says the version is in effect. The page renders
 * on each request, so the change comes on the day. It ends with every version, newest first, with
 * its effective date and summary of changes (Terms of Service 15). Internal documents are never served.
 * `/legal/cookie-settings` is the Cookie settings page the Cookie Policy names (Section 14.3, A82).
 * The Subprocessor List carries the change notice subscription (Section 14.4, A82); its emailed
 * links bring a token, so that page keeps the referrer to this site.
 */
const COOKIE_SETTINGS = "cookie-settings";
const SUBPROCESSORS = "subprocessors";
function publicDocument(slug: string) {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug && d.publish === "public");
}

/** Every public document is on this app; any other path in the text stays as written. */
function documentHref(slug: string): string | null {
  return slug === COOKIE_SETTINGS || LEGAL_SLUGS.includes(slug) ? `/legal/${slug}` : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/legal/[document]">): Promise<Metadata> {
  const slug = (await params).document;
  if (slug === COOKIE_SETTINGS) {
    return { title: (await getTranslations("compliance.cookies"))("settingsTitle") };
  }
  const doc = publicDocument(slug);
  if (!doc) return {};
  return slug === SUBPROCESSORS
    ? { title: doc.title, referrer: "same-origin" }
    : { title: doc.title };
}

function param(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

export default async function LegalPage({ params, searchParams }: PageProps<"/legal/[document]">) {
  const slug = (await params).document;
  if (slug === COOKIE_SETTINGS) return <ConsentSettings />;
  const doc = publicDocument(slug);
  const text = LEGAL_TEXT[slug];
  if (!doc || text === undefined) notFound();
  const [t, locale, format] = await Promise.all([
    getTranslations("shell.legal"),
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
  const query = slug === SUBPROCESSORS ? await searchParams : {};
  const blocks = parseLegalMarkdown(text);
  const confirm = param(query["confirm"]);
  const unsubscribe = param(query["unsubscribe"]);
  const notice = param(query["notice"]);
  const notices =
    slug === SUBPROCESSORS ? (
      <SubprocessorNotices confirm={confirm} unsubscribe={unsubscribe} notice={notice} />
    ) : null;
  // Someone an emailed link or a form's answer brought here should not have to find it below the list.
  const noticesFirst = Boolean(confirm ?? unsubscribe ?? notice);
  return (
    <main id="content" className="flex justify-center p-16 md:p-24">
      <div className="w-full min-w-0 lg:w-auto">
        <TemplateDocument outline={<LegalOutline blocks={blocks} label={t("contents")} />}>
          <div>
            <ButtonLink href="/">{t("action")}</ButtonLink>
          </div>
          {standing()}
          {locale.startsWith("en") ? null : (
            <p className="m-0 text-text-14 text-text-secondary">{t("englishOnly")}</p>
          )}
          {noticesFirst ? notices : null}
          <div className="lg:hidden">
            <LegalContents blocks={blocks} label={t("contents")} />
          </div>
          <LegalText blocks={blocks} hrefFor={documentHref} />
          <LegalHistory history={history} title={t("history")} describe={describe} />
          {noticesFirst ? null : notices}
        </TemplateDocument>
      </div>
    </main>
  );
}
