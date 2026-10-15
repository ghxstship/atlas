import {
  acceptsApplications,
  APP_ENUMS,
  applicationMode,
  fromDisplayKey,
  getOpportunity,
  listAccountMembers,
  listMyApplications,
} from "@xos/data";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { ApplyForm, ReportListing } from "@/components/explore/forms";
import { PageTitle, Section } from "@/components/page/page";
import { BrandMark, ButtonLink, Card, InlineAlert, PropertyList, RefusalLink, Tag } from "@/components/ui";
import { formatDate, formatDateRange, formatDateTime, formatMoney, formatPayRange } from "@/lib/format";
import { requireNode } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata({ params }: PageProps<"/explore/[opportunityKey]">): Promise<Metadata> {
  const t = await getTranslate();
  const { opportunityKey } = await params;
  return { title: `${t("nav.gateway.explore.opportunity")} ${opportunityKey}` };
}

/**
 * Opportunity detail (Section 4.4.3): role, pay, dates and place first, the requirements, then
 * Apply in one step for the role type's way of applying. A listing the person may not see is 404,
 * the same answer as one that does not exist.
 */
export default async function OpportunityPage({ params }: PageProps<"/explore/[opportunityKey]">) {
  const { opportunityKey } = await params;
  const ctx = await requireNode("explore.opportunity", { opportunityKey });
  const id = fromDisplayKey("opportunity", opportunityKey);
  if (!id) notFound();
  const [t, locale, detail, applications] = await Promise.all([
    getTranslate(),
    getLocale(),
    getOpportunity(ctx.db, id),
    listMyApplications(ctx.db),
  ]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Opportunity ${opportunityKey} did not load: ${detail.error.kind}`);
  }
  const o = detail.data;
  const applied = applications.ok ? applications.data.find((a) => a.opportunityId === o.id) : undefined;
  const mode = applicationMode(o.roleType, o.rateType, ctx.acting !== null);
  const roster =
    mode === "slate" && ctx.acting
      ? await listAccountMembers(ctx.db, ctx.acting.id)
      : null;
  const pay = o.rateOnRequest
    ? t("gateway.common.rateOnRequest")
    : (formatPayRange(locale, o.payMinMinor, o.payMaxMinor, o.currency) ?? t("gateway.common.rateOnRequest"));
  const open = acceptsApplications(o);

  return (
    <>
      <PageTitle
        eyebrow={
          <span className="inline-flex items-center gap-6">
            <BrandMark name={o.orgName} size="sm" iconOnly />
            {o.orgName}
          </span>
        }
        title={o.title}
        lead={
          <span className="flex flex-wrap gap-x-12 gap-y-4">
            <strong className="text-text-primary tabular-nums">{pay}</strong>
            <span>{formatDateRange(locale, o.startsOn, o.endsOn) || t("gateway.common.noDate")}</span>
            {o.venueName ? <span>{o.venueName}</span> : null}
          </span>
        }
        action={<Tag>{t(enumLabelKey("externalRoleType", o.roleType))}</Tag>}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_var(--layout-property-column)] gap-24 max-lg:grid-cols-[minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-24">
          {o.description ? (
            <Section title={t("gateway.explore.detail.about")}>
              <p className="m-0 whitespace-pre-line text-text-14">{o.description}</p>
            </Section>
          ) : null}

          <Section title={t("gateway.explore.detail.requirements")}>
            {o.requirements.length === 0 ? (
              <p className="m-0 text-text-14 text-text-secondary">{t("gateway.explore.detail.requirementsNone")}</p>
            ) : (
              <>
                <ul className="m-0 flex list-none flex-col gap-8 p-0">
                  {o.requirements.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-8">
                      <Tag>{t(enumLabelKey("opportunityRequirementKind", r.kind))}</Tag>
                      <span>
                        {r.certificationName ??
                          (r.insuranceMinimumMinor !== null
                            ? t("gateway.explore.detail.insuranceMinimum", {
                                amount: formatMoney(locale, r.insuranceMinimumMinor, r.currency) ?? "",
                              })
                            : (r.description ?? ""))}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 text-text-13 text-text-secondary">{t("gateway.explore.detail.requirementsCheck")}</p>
              </>
            )}
          </Section>

          {o.positions.some((p) => p.callAt) ? (
            <Section title={t("gateway.explore.detail.schedule")}>
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {o.positions.map((p) => (
                  <li key={p.id} className="flex flex-wrap gap-8">
                    <span className="font-medium">{p.label}</span>
                    {p.callAt ? <span className="text-text-secondary">{formatDateTime(locale, p.callAt)}</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <section aria-labelledby="apply-heading" className="flex flex-col gap-12">
            <h2 id="apply-heading" className="m-0 text-heading-16 font-semibold">
              {t("gateway.explore.detail.applyNow")}
            </h2>
            {applied ? (
              <InlineAlert tone="success">
                {t("gateway.explore.detail.applied", { date: formatDate(locale, applied.submittedAt) })}{" "}
                <a href="/work/applications" className="text-accent-text underline">
                  {t("gateway.explore.detail.appliedAction")}
                </a>
              </InlineAlert>
            ) : !open ? (
              <RefusalLink
                title={t("gateway.explore.detail.closed")}
                reason={t("gateway.outcomes.refusals.application_deadline_passed")}
                actionLabel={t("gateway.explore.detail.closedAction")}
                href="/explore"
              />
            ) : mode === "bid" && !ctx.acting ? (
              <RefusalLink
                title={t("gateway.explore.applyForm.bidTitle")}
                reason={t("gateway.explore.applyForm.bidNeedsAccount")}
                actionLabel={t("gateway.explore.applyForm.bidNeedsAccountAction")}
                href="/settings/company"
              />
            ) : (
              <Card title={t("gateway.explore.applyForm.title", { role: o.title })} meta={o.orgName}>
                <ApplyForm
                  opportunityId={o.id}
                  role={o.title}
                  org={o.orgName}
                  mode={mode}
                  personName={ctx.personName}
                  email={ctx.email}
                  accountName={ctx.acting?.name ?? null}
                  questions={o.questions}
                  feePosted={!o.rateOnRequest}
                  currency={o.currency ?? "USD"}
                  roster={
                    roster?.ok
                      ? roster.data
                          .filter((m) => m.personId !== ctx.personId)
                          .map((m) => ({ personId: m.personId, name: m.fullName ?? m.personId }))
                      : []
                  }
                />
              </Card>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-16">
          <Card>
            <PropertyList
              items={[
                { label: t("gateway.explore.detail.pay"), value: pay },
                ...(o.rateType ? [{ label: t("gateway.explore.detail.rateType"), value: t(enumLabelKey("rateType", o.rateType)) }] : []),
                {
                  label: t("gateway.explore.detail.dates"),
                  value: formatDateRange(locale, o.startsOn, o.endsOn) || t("gateway.common.noDate"),
                },
                ...(o.venueName ? [{ label: t("gateway.explore.detail.place"), value: o.venueName }] : []),
                { label: t("gateway.explore.detail.positions"), value: String(o.positionCount) },
                ...(o.deadlineAt ? [{ label: t("gateway.explore.detail.deadline"), value: formatDateTime(locale, o.deadlineAt) }] : []),
                { label: t("gateway.explore.detail.visibility"), value: t(enumLabelKey("opportunityVisibility", o.visibility)) },
                ...(o.minimumAge
                  ? [{ label: t("gateway.explore.detail.minimumAge"), value: t("gateway.explore.detail.minimumAgeValue", { n: o.minimumAge }) }]
                  : []),
              ]}
            />
          </Card>
          <ButtonLink href="/explore">{t("gateway.common.back")}</ButtonLink>
          <ReportListing
            opportunityId={o.id}
            reasons={APP_ENUMS.listing_report_reason.map((r) => ({
              value: r,
              label: t(enumLabelKey("listingReportReason", r)),
            }))}
          />
        </aside>
      </div>
    </>
  );
}
