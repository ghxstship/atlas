import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CookieSettings } from "@/components/privacy/cookie-settings";
import { SubprocessorNotices } from "@/components/privacy/subprocessor-notices";
import { SystemPage } from "@/components/system-page";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Published legal documents (Section 14.4), public. Publishing the text with version history
 * belongs to A21 and waits on legal/OWNER_INPUTS.md; while a document's current version is a
 * draft the page states which version is in review. Internal documents are never served.
 * `/legal/cookie-settings` is the Cookie settings page the Cookie Policy names (Section 14.3, A82).
 * The Subprocessor List carries the change notice subscription (Section 14.4, A82); its emailed
 * links bring a token, so that page keeps the referrer to this site.
 */
const COOKIE_SETTINGS = "cookie-settings";
const SUBPROCESSORS = "subprocessors";
function publicDocument(slug: string) {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug && d.publish === "public");
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
  if (slug === COOKIE_SETTINGS) return <CookieSettings />;
  const doc = publicDocument(slug);
  if (!doc) notFound();
  const t = await getTranslations("shell.legal");
  const query = slug === SUBPROCESSORS ? await searchParams : {};
  return (
    <main id="content">
      <SystemPage
        icon="FileText"
        title={doc.title}
        sentence={t("inReview", { version: doc.version })}
        actionLabel={t("action")}
        href="/"
      />
      {slug === SUBPROCESSORS ? (
        <SubprocessorNotices
          confirm={param(query["confirm"])}
          unsubscribe={param(query["unsubscribe"])}
          notice={param(query["notice"])}
        />
      ) : null}
    </main>
  );
}
