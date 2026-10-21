import { getAssurance, listSecondFactors } from "@xos/data/auth-assurance";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SecondFactorChallenge } from "@/components/auth/security/second-factor-challenge";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { safeNext } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.challenge");
  return { title: t("title") };
}

/**
 * The second factor after the first (Section 9, A77). The proxy sends a person here when they hold a verified
 * second factor this session has not passed; they verify it and continue to `next`.
 */
export default async function SecondFactorPage({ searchParams }: PageProps<"/auth/mfa">) {
  const next = safeNext((await searchParams)["next"], "/home");
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const [factors, assurance] = await Promise.all([listSecondFactors(db), getAssurance(db)]);
  if (!factors.ok) throw new Error(`Cannot list second factors: ${JSON.stringify(factors.error)}`);
  const verified = factors.data.filter((f) => f.verified);
  if (verified.length === 0 || (assurance.ok && assurance.data.current === "aal2")) {
    redirect(next as Route);
  }
  const t = await getTranslations("authSecurity");
  return (
    <div className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-20 font-semibold">{t("challenge.title")}</h1>
      <SecondFactorChallenge
        options={{
          factors: verified.map((f) => ({ id: f.id, type: f.type, label: f.label })),
          securityKeys: relyingPartyFrom(env()) !== null,
        }}
        mode="sign-in"
        next={next}
      />
      <p className="m-0 text-text-12 text-text-secondary">{t("challenge.lost")}</p>
      <form method="post" action="/auth/sign-out">
        <button
          type="submit"
          className="min-h-touch-min text-text-13 font-medium text-accent-text underline"
        >
          {t("challenge.signOut")}
        </button>
      </form>
    </div>
  );
}
