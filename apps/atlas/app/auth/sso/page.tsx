import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SsoForm } from "@/components/auth/security/sso-form";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.sso");
  return { title: t("title") };
}

/**
 * Enterprise single sign-on (Section 9, Enterprise plan): the work email's domain picks the organization's SAML
 * identity provider, configured in Supabase Auth SSO. The provider returns to /auth/callback like OAuth.
 */
export default async function SsoPage({ searchParams }: PageProps<"/auth/sso">) {
  const next = safeNext((await searchParams)["next"]);
  const t = await getTranslations("authSecurity.sso");
  const back = next === "/" ? "/auth/sign-in" : `/auth/sign-in?next=${encodeURIComponent(next)}`;
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("sentence")}</p>
      <SsoForm next={next} />
      <Link href={back as "/auth/sign-in"} className="text-text-13 text-accent-text underline">
        {t("back")}
      </Link>
    </div>
  );
}
