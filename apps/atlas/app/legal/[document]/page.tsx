import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CookieSettings } from "@/components/privacy/cookie-settings";
import { SystemPage } from "@/components/system-page";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Published legal documents (Section 14.4), public. Publishing the text with version history
 * belongs to A21 and waits on legal/OWNER_INPUTS.md; while a document's current version is a
 * draft the page states which version is in review. Internal documents are never served.
 * `/legal/cookie-settings` is the Cookie settings page the Cookie Policy names (Section 14.3, A82).
 */
const COOKIE_SETTINGS = "cookie-settings";
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
  return doc ? { title: doc.title } : {};
}

export default async function LegalPage({ params }: PageProps<"/legal/[document]">) {
  const slug = (await params).document;
  if (slug === COOKIE_SETTINGS) return <CookieSettings />;
  const doc = publicDocument(slug);
  if (!doc) notFound();
  const t = await getTranslations("shell.legal");
  return (
    <main id="content">
      <SystemPage
        icon="FileText"
        title={doc.title}
        sentence={t("inReview", { version: doc.version })}
        actionLabel={t("action")}
        href="/"
      />
    </main>
  );
}
