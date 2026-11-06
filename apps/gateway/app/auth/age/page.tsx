import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { minimumAgeConfirmed } from "@xos/data/consent";
import { AgeQuestionForm } from "@/components/auth/forms";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.ageQuestion");
  return { title: t("title") };
}

/**
 * The age question on its own (ADR 0156): the minimum age is 18 in every app, so someone who confirmed the earlier age of
 * 16 answers again at their next sign-in. Someone who has answered goes straight on.
 */
export default async function AgeQuestionPage({ searchParams }: PageProps<"/auth/age">) {
  const next = safeNext((await searchParams)["next"], "/home");
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const age = await minimumAgeConfirmed(db);
  if (age.ok && age.data) redirect(next as Route);
  const t = await getTranslations("gateway.auth.ageQuestion");
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
