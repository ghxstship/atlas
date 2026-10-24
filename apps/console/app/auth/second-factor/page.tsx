import { getAssurance, listSecondFactors } from "@xos/data/auth-assurance";
import { getOperator } from "@xos/data/console";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EnrollSecondFactor, VerifySecondFactor } from "@/components/auth-forms";
import { InlineAlert } from "@/components/ui";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("console.auth.secondFactor");
  return { title: t("title") };
}

/**
 * The second factor every operator passes before any console page (A77, ADR 0046). With an authenticator app they
 * enter its code; without one they set one up here. Security keys enrolled in Atlas do not open the console yet
 * (a follow-up), so an account with only those sets up an authenticator app too.
 */
export default async function SecondFactorPage({ searchParams }: PageProps<"/auth/second-factor">) {
  const next = safeNext((await searchParams)["next"], "/tenants");
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data) redirect("/auth/refused" as Route);
  const [factors, assurance] = await Promise.all([listSecondFactors(db), getAssurance(db)]);
  if (!factors.ok) throw new Error(`Cannot list second factors: ${JSON.stringify(factors.error)}`);
  if (assurance.ok && assurance.data.current === "aal2") redirect(next as Route);
  const t = await getTranslations("console.auth.secondFactor");
  const verified = factors.data.filter((f) => f.verified);
  const totp = verified.find((f) => f.type === "totp");
  if (totp) {
    return (
      <>
        <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
        <p className="m-0 text-text-13 text-text-secondary">{totp.label || t("factor")}</p>
        <VerifySecondFactor factorId={totp.id} next={next} />
      </>
    );
  }
  return (
    <>
      <h1 className="m-0 text-heading-20 font-semibold">{t("enrollTitle")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("enrollIntro")}</p>
      {verified.length > 0 ? <InlineAlert tone="info">{t("keysOnly")}</InlineAlert> : null}
      <EnrollSecondFactor next={next} />
    </>
  );
}
