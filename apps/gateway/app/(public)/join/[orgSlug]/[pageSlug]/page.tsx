import { brandForSlug, getPublicRegistrationPage, myRegistrations } from "@xos/data/gateway";
import { resolveSettings } from "@xos/data/settings";
import { PARAM_TYPES } from "@xos/ia";
import { Tag } from "@xos/ui";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { RegistrationForm } from "@/components/tokens/registration-form";
import { BrandMark, ButtonLink } from "@/components/ui";
import { withdrawRegistrationAction } from "@/lib/actions/registration";
import { inBrandScope } from "@/lib/brand/brand";
import { getGatewayContext, getRequestFacts } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.registration");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * A crew registration page (B10, G-129, ADR 0149 decision 3). Signed out, it shows its copy and asks the visitor to sign up
 * or sign in; signed in, it takes the registration and then shows its state, with Withdraw. It never names the pool. A
 * closed page, a dead pool, a read-only org and a flagged person all read the same neutral message.
 */
export default async function RegistrationPage({ params }: PageProps<"/join/[orgSlug]/[pageSlug]">) {
  const { orgSlug, pageSlug } = await params;
  if (!PARAM_TYPES.slug.test(orgSlug) || !PARAM_TYPES.slug.test(pageSlug)) notFound();
  const t = await getTranslations("gateway.registration");
  const db = await createServerSupabase();
  const found = await getPublicRegistrationPage(db, { orgSlug, pageSlug });
  if (!found.ok || found.data.refused) {
    return <p className="m-0 text-text-14">{t("closed")}</p>;
  }
  const page = found.data;
  const facts = await getRequestFacts();
  if (!inBrandScope(facts.brand, page.orgId)) notFound();
  const brand = await brandForSlug(db, orgSlug);
  const ctx = await getGatewayContext();
  const path = `/join/${orgSlug}/${pageSlug}`;
  const next = encodeURIComponent(path);
  const intro = (
    <div className="flex flex-col gap-8">
      <BrandMark name={brand.ok ? (brand.data?.name ?? page.orgName) : page.orgName} size="sm" />
      <h1 className="m-0 text-heading-20 font-semibold">{page.title}</h1>
      {page.intro ? <p className="m-0 whitespace-pre-wrap text-text-14">{page.intro}</p> : null}
      <p className="m-0 text-text-13 text-text-secondary">{t("minimumAge", { age: page.minimumAge })}</p>
    </div>
  );
  if (!ctx) {
    return (
      <>
        {intro}
        <p className="m-0 text-text-14">{t("signedOut")}</p>
        <div className="flex flex-wrap items-center gap-12">
          <ButtonLink href={`/auth/sign-up?next=${next}` as Route} variant="primary">
            {t("signUp")}
          </ButtonLink>
          <Link href={`/auth/sign-in?next=${next}` as Route} className="text-text-13 font-medium text-accent-text">
            {t("signIn")}
          </Link>
        </div>
      </>
    );
  }
  const mine = await myRegistrations(ctx.db);
  const existing = mine.ok
    ? mine.data.find(
        (r) => r.orgSlug === orgSlug && r.pageSlug === pageSlug && (r.state === "Submitted" || r.state === "Approved"),
      )
    : undefined;
  if (existing) {
    return (
      <>
        {intro}
        <div className="flex flex-wrap items-center gap-12">
          <p role="status" className="m-0 text-text-14">
            {t(existing.state === "Approved" ? "state.Approved" : "state.Submitted")}
          </p>
          <Tag tone={existing.state === "Approved" ? "success" : "neutral"}>{t(existing.state === "Approved" ? "states.Approved" : "states.Submitted")}</Tag>
        </div>
        <div>
          <ActionButton action={withdrawRegistrationAction.bind(null, existing.id, path)} label={t("withdraw")} variant="secondary" />
        </div>
      </>
    );
  }
  const settings = await resolveSettings(ctx.db, { orgId: page.orgId });
  const phone = settings.ok ? settings.data.get("workforce.work_phone")?.value : null;
  return (
    <>
      {intro}
      <RegistrationForm
        orgId={page.orgId}
        orgSlug={orgSlug}
        pageSlug={pageSlug}
        minimumAge={page.minimumAge}
        questions={page.questions}
        phone={typeof phone === "string" ? phone : ""}
      />
    </>
  );
}
