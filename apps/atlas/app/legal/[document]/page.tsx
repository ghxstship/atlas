import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SystemPage } from "@/components/ui";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Published legal documents (Section 14.4), public. Publishing the text with version history
 * belongs to A21 and waits on legal/OWNER_INPUTS.md; while a document's current version is a
 * draft the page states which version is in review. Internal documents are never served.
 */
function publicDocument(slug: string) {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug && d.publish === "public");
}

export async function generateMetadata({
  params,
}: PageProps<"/legal/[document]">): Promise<Metadata> {
  const doc = publicDocument((await params).document);
  return doc ? { title: doc.title } : {};
}

export default async function LegalPage({ params }: PageProps<"/legal/[document]">) {
  const doc = publicDocument((await params).document);
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
