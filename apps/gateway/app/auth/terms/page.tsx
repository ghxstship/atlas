import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { TermsForm } from "@/components/auth/forms";
import { missingSignUpAcceptances } from "@/lib/auth/legal";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.terms");
  return { title: t("title") };
}

/**
 * The Worker Terms for an account a provider created (ADR 0036, finding A59-025). Signing in with
 * Google creates the account before any form, so /auth/callback sends a new account here to accept
 * the Worker Terms and read the Privacy Policy, as the sign-up form asks. Someone who has accepted
 * them goes straight on to `next`.
 */
export default async function TermsPage({ searchParams }: PageProps<"/auth/terms">) {
  const next = safeNext((await searchParams)["next"], "/home");
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) {
    const here = `/auth/terms?next=${encodeURIComponent(next)}`;
    redirect(`/auth/sign-in?next=${encodeURIComponent(here)}` as Route);
  }
  if ((await missingSignUpAcceptances(db)).length === 0) redirect(next as Route);
  const t = await getTranslations("gateway.auth");
  const legalLink = (href: string) =>
    function LegalLink(chunks: ReactNode) {
      return (
        <Link
          href={href as Route}
          target="_blank"
          rel="noopener"
          className="text-accent-text underline"
        >
          {chunks}
        </Link>
      );
    };
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("terms.title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">{t("terms.lead")}</p>
      </div>
      <TermsForm
        next={next}
        termsLabel={t.rich("signUp.terms", {
          terms: legalLink("/legal/worker-terms"),
          privacy: legalLink("/legal/privacy-policy"),
        })}
      />
    </div>
  );
}
