import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { minimumAgeConfirmed } from "@xos/data/consent";
import { AgeQuestionForm, AgeUnderConfirmForm } from "@/components/auth/forms";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.ageQuestion");
  return { title: t("title") };
}

/**
 * The age question on its own (ADR 0156): the minimum age is 18 in every app, so the proxy sends anyone who has not
 * answered at 18 here before any signed-in page: an earlier 16, or an account a provider made. Someone who has answered
 * goes straight on. With `under=1` they chose under 18, and this says what closing the account means and asks them to
 * confirm it.
 */
export default async function AgeQuestionPage({ searchParams }: PageProps<"/auth/age">) {
  const query = await searchParams;
  const next = safeNext(query["next"], "/home");
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const age = await minimumAgeConfirmed(db);
  if (age.ok && age.data) redirect(next as Route);
  const t = await getTranslations("gateway.auth.ageQuestion");
  if (query["under"] === "1") {
    return (
      <div className="flex flex-col gap-16">
        <div className="flex flex-col gap-4">
          <h1 className="m-0 text-heading-20 font-semibold">{t("under.title")}</h1>
          <p className="m-0 text-text-14">{t("under.sentence")}</p>
        </div>
        <p className="m-0 text-text-13 text-text-secondary">{t("under.consequences")}</p>
        <AgeUnderConfirmForm back={next} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">{t("lead")}</p>
      </div>
      <AgeQuestionForm next={next} />
    </div>
  );
}
