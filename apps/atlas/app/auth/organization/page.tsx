import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { minimumAgeConfirmed } from "@xos/data/consent";
import { listSubscribableAccounts } from "@xos/data/identity";
import { OrganizationForm } from "@/components/auth/organization-form";
import { SubscribeAccounts } from "@/components/auth/subscribe-account";
import { createServerSupabase } from "@/lib/supabase/server";
import { ownerSignupDocuments } from "@/lib/auth/legal";
import { organizationStepPath, planIntent } from "@/lib/auth/plan-intent";
import { offeredTerritoriesPhrase, signupCountryOptions } from "@/lib/auth/territory";
import { getViewer } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.organization");
  return { title: t("title") };
}

/**
 * Create an organization (app.create_organization): the signed-in person becomes its Owner on the
 * Access plan and accepts the documents legal/index.yaml requires of an Owner at signup. A `plan` naming a self-serve
 * plan (docs/sign-up-links.md) goes into both forms, so the new Owner lands on Billing and Plan with it marked.
 */
export default async function OrganizationPage({ searchParams }: PageProps<"/auth/organization">) {
  const intent = planIntent((await searchParams)["plan"]);
  const viewer = await getViewer();
  if (!viewer) {
    redirect(`/auth/sign-in?next=${encodeURIComponent(organizationStepPath(intent))}` as Route);
  }
  const t = await getTranslations("shell.auth.organization");
  const tAuth = await getTranslations("shell.auth");
  const tPlans = await getTranslations("shell.plans");
  const [terms, dpa] = ownerSignupDocuments();
  // Journey 60: company accounts the person owns in Gateway start Atlas as the same organization.
  const db = await createServerSupabase();
  const [accounts, age, territories, countries] = await Promise.all([
    listSubscribableAccounts(db),
    minimumAgeConfirmed(db),
    offeredTerritoriesPhrase(),
    signupCountryOptions(),
  ]);
  if (!terms || !dpa) {
    throw new Error("legal/index.yaml must list the Terms of Service and the DPA for Owners.");
  }
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
        <p className="text-text-13 text-text-secondary">{t("lead")}</p>
        <p className="text-text-13 text-text-secondary">{t("availability", { territories })}</p>
        {intent !== null ? (
          <p className="text-text-13 text-text-secondary" data-testid="plan-intent">
            {tAuth("planIntent", { plan: tPlans(`${intent}.name` as never) })}
          </p>
        ) : null}
      </div>
      <SubscribeAccounts
        accounts={accounts.ok ? accounts.data : []}
        terms={{ href: `/legal/${terms.slug}`, title: terms.title }}
        dpa={{ href: `/legal/${dpa.slug}`, title: dpa.title }}
        countries={countries}
        plan={intent}
      />
      <OrganizationForm
        terms={{ href: `/legal/${terms.slug}`, title: terms.title }}
        dpa={{ href: `/legal/${dpa.slug}`, title: dpa.title }}
        countries={countries}
        askAge={!(age.ok && age.data)}
        plan={intent}
      />
    </div>
  );
}
