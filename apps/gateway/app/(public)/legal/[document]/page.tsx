import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";
import { gatewayLegalDocument } from "@/lib/auth/legal";

/**
 * The legal documents Gateway's sign-up names (Section 14.4, finding A59-025): the Worker Terms and
 * the Privacy Policy, public. Publishing their text with version history waits on
 * legal/OWNER_INPUTS.md, as on Atlas's /legal pages; while the current version is a draft the
 * page says which version is in review. Any other slug answers 404.
 */
export async function generateMetadata({
  params,
}: PageProps<"/legal/[document]">): Promise<Metadata> {
  const doc = gatewayLegalDocument((await params).document);
  return doc ? { title: doc.title } : {};
}

export default async function LegalPage({ params }: PageProps<"/legal/[document]">) {
  const doc = gatewayLegalDocument((await params).document);
  if (!doc) notFound();
  const t = await getTranslations("gateway.legal");
  return (
    <article className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-24 font-semibold">{doc.title}</h1>
      <p className="m-0 text-text-14 text-text-secondary">
        {t("inReview", { version: doc.version })}
      </p>
      <div>
        <ButtonLink href="/">{t("back")}</ButtonLink>
      </div>
    </article>
  );
}
