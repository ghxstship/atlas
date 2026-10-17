import { getPublicOrganizationProfile, searchOpportunities } from "@xos/data/gateway";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { cache } from "react";
import { OpportunityLinkCard } from "@/components/page/opportunity-card";
import { Section } from "@/components/page/page";
import { BrandMark, Icon, Tag } from "@/components/ui";
import { getGatewayContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { createServerSupabase } from "@/lib/supabase/server";

const load = cache(async (handle: string) => {
  const result = await getPublicOrganizationProfile(await createServerSupabase(), handle);
  if (!result.ok) throw new Error(`Company profile ${handle} did not load: ${result.error.kind}`);
  return result.data;
});

export async function generateMetadata({
  params,
}: PageProps<"/c/[companyHandle]">): Promise<Metadata> {
  const { companyHandle } = await params;
  const data = await load(companyHandle);
  if (!data) return { robots: { index: false, follow: false } };
  return {
    title: data.profile.name,
    description: data.profile.about ?? undefined,
    robots: { index: data.profile.indexable, follow: data.profile.indexable },
    openGraph: {
      title: data.profile.name,
      description: data.profile.about ?? undefined,
      type: "website",
    },
  };
}

/**
 * An organization's public profile at /c/{companyHandle} (Section 4.8.2, journey 62): about, a
 * verified domain badge, capabilities by canon category, service regions, published case studies, the team it shows and
 * its open opportunities. Indexing is off by default.
 */
export default async function CompanyProfilePage({ params }: PageProps<"/c/[companyHandle]">) {
  const { companyHandle } = await params;
  const data = await load(companyHandle);
  if (!data) notFound();
  if (data.profile.redirected) permanentRedirect(`/c/${data.profile.handle}` as Route);
  const [t, locale, ctx] = await Promise.all([getTranslate(), getLocale(), getGatewayContext()]);
  const opportunities = ctx
    ? await searchOpportunities(ctx.db, { orgId: data.profile.org_id, limit: 12 })
    : null;
  const open = opportunities?.ok ? opportunities.data : [];
  const details = (kind: string) =>
    data.details.filter((d) => d.detail_kind === kind).sort((a, b) => a.sort_order - b.sort_order);
  const domains = details("verified_domain");
  return (
    <article className="flex flex-col gap-24">
      <header className="flex flex-wrap items-center gap-12">
        <BrandMark name={data.profile.name} />
        <h1 className="m-0 text-heading-24 font-semibold">{data.profile.name}</h1>
        {data.profile.verified ? (
          <Tag tone="success">
            <span className="inline-flex items-center gap-4">
              <Icon name="BadgeCheck" size={14} />
              {t("gateway.profile.company.verified")}
            </span>
          </Tag>
        ) : null}
      </header>
      {data.profile.about ? (
        <p className="m-0 max-w-layout-reading whitespace-pre-line text-text-14">
          {data.profile.about}
        </p>
      ) : null}
      <p className="m-0 flex flex-wrap gap-12 text-text-13">
        {data.profile.website_url ? (
          <a
            href={data.profile.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-text underline"
          >
            {data.profile.website_url.replace(/^https?:\/\//, "")}
          </a>
        ) : null}
        {domains.map((d) => (
          <span key={d.code} className="inline-flex items-center gap-4 text-text-secondary">
            <Icon
              name="ShieldCheck"
              size={14}
              label={t("gateway.profile.company.verifiedDomain")}
            />
            {d.label}
          </span>
        ))}
      </p>
      {details("capability").length > 0 ? (
        <Section title={t("gateway.profile.company.capabilities")}>
          <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
            {details("capability").map((c) => (
              <li
                key={c.code}
                className="inline-flex items-center gap-6 rounded-pill border border-border-subtle px-12 py-4 text-text-13"
              >
                {c.label}
                <span className="font-mono text-text-12 text-text-secondary">{c.code}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {details("service_region").length > 0 ? (
        <Section title={t("gateway.profile.company.regions")}>
          <p className="m-0 font-mono text-text-13">
            {details("service_region")
              .map((r) => r.label)
              .join(", ")}
          </p>
        </Section>
      ) : null}
      {details("case_study").length > 0 ? (
        <Section title={t("gateway.profile.company.caseStudies")}>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
            {details("case_study").map((c) => {
              // api_public.organization_profile_details labels a case study "title: summary".
              const split = c.label.indexOf(": ");
              const title = split > 0 ? c.label.slice(0, split) : c.label;
              const summary = split > 0 ? c.label.slice(split + 2) : "";
              return (
                <li
                  key={c.code}
                  className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-16"
                >
                  <h3 className="m-0 text-text-14 font-semibold">{title}</h3>
                  {summary ? (
                    <p className="m-0 text-text-13 text-text-secondary">{summary}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {details("team_member").length > 0 ? (
        <Section title={t("gateway.profile.company.team")}>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {details("team_member").map((m) => (
              <li key={`${m.code}-${m.label}`}>
                {m.code ? (
                  <Link href={`/u/${m.code}` as Route} className="text-accent-text underline">
                    {m.label}
                  </Link>
                ) : (
                  m.label
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {open.length > 0 ? (
        <Section title={t("gateway.profile.company.opportunities")}>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
            {open.map((o) => (
              <li key={o.id}>
                <OpportunityLinkCard opportunity={o} locale={locale} t={t} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}
