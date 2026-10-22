import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CookieSettings } from "@/components/privacy/cookie-settings";
import { ButtonLink } from "@/components/ui";
import { gatewayLegalDocument } from "@/lib/auth/legal";

/**
 * The legal documents Gateway's sign-up names (Section 14.4, finding A59-025): the Worker Terms and
 * the Privacy Policy, public. Publishing their text with version history waits on
 * legal/OWNER_INPUTS.md, as on Atlas's /legal pages; while the current version is a draft the
 * page says which version is in review. `/legal/cookie-settings` is the Cookie settings page the
 * Cookie Policy names (Section 14.3, A82). Any other slug answers 404.
 */
const COOKIE_SETTINGS = "cookie-settings";
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
