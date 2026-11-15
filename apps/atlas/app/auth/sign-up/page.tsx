import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignUpForm } from "@/components/auth/forms";
import { ProviderButtons } from "@/components/auth/providers";
import { planIntent, planIntentEntry, planIntentOfEntry } from "@/lib/auth/plan-intent";
import { safeNext } from "@/lib/auth/redirect";
import { offeredTerritoriesPhrase } from "@/lib/auth/territory";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.signUp");
  return { title: t("title") };
}

/**
 * Create an account. Without a `next` (an invitation link sets one), a new account goes on to
 * create its organization, where the Owner accepts the Terms of Service and the DPA. A `plan` naming a self-serve plan
 * (docs/sign-up-links.md) rides in `next` to Billing and Plan, where the new Owner sees it marked; an invitation's `next`
 * wins, since an invited person creates no organization. The plan is named whenever `next` is that entry address, so a
 * link that carries it only inside `next` names it too.
 */
export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const query = await searchParams;
  const intent = planIntent(query["plan"]);
  const start = intent === null ? "/auth/organization" : planIntentEntry(intent);
  const next = safeNext(query["next"], start);
  const shown = planIntentOfEntry(next);
  const t = await getTranslations("shell.auth");
  const tPlans = await getTranslations("shell.plans");
  const signInHref = `/auth/sign-in?next=${encodeURIComponent(next)}`;
  const territories = await offeredTerritoriesPhrase();
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("signUp.title")}</h1>
      <p className="m-0 text-text-13 text-text-secondary">
        {t("organization.availability", { territories })}
      </p>
      {shown !== null ? (
        <p className="m-0 text-text-13 text-text-secondary" data-testid="plan-intent">
          {t("planIntent", { plan: tPlans(`${shown}.name` as never) })}
        </p>
      ) : null}
      <ProviderButtons next={next} />
      <SignUpForm next={next} />
      <p className="text-text-13 text-text-secondary">
        {t("signUp.haveAccount")}{" "}
        <Link href={signInHref as "/auth/sign-in"} className="text-accent-text underline">
          {t("signUp.toSignIn")}
        </Link>
      </p>
    </div>
  );
}
