import {
  APP_ENUMS,
  bidTotal,
  listMyApplications,
  OPEN_APPLICATION_STATES,
  readView,
  type ApplicationWithOpportunity,
  type ExternalRow,
} from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { LiveRefresh } from "@/components/live/live-refresh";
import { LinkBoard, LinkTable } from "@/components/page/collections";
import { PageTitle, pickView, RegionError, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { CounterForm } from "@/components/work/counter-form";
import { Card, EmptyStateLink, PropertyList, Tag } from "@/components/ui";
import { decideApplicationAction } from "@/lib/actions/engagement";
import { acceptOfferAction, declineOfferAction } from "@/lib/actions/offers";
import { formatDate, formatDateRange, formatDateTime, formatMoney } from "@/lib/format";
import { idsTopic, personTopic, topics } from "@/lib/live/topics";
import { lensApplications } from "@/lib/shell/role-lens";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";
import { APPLICATION_STATE_STYLE, toneFor } from "@/lib/states";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.work.applications") };
}

type Offer = ExternalRow<"offers">;
type OfferVersion = ExternalRow<"offer_versions">;

function opportunityHref(a: ApplicationWithOpportunity): string {
  return a.opportunity ? `/explore/${a.opportunity.key}` : "/work/applications";
}

function OfferPanel({
  offer,
  versions,
  locale,
  t,
}: {
  offer: Offer;
  versions: readonly OfferVersion[];
  locale: string;
  t: Translate;
}) {
  const latest = [...versions].sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0))[0];
  const state = offer.offer_state ?? "Sent";
  const fromOrg = latest?.proposed_side !== "Party";
  const answerable = state === "Sent" || (state === "Countered" && fromOrg);
  return (
    <div className="flex flex-col gap-8 rounded-control border border-border-subtle p-12">
      <div className="flex flex-wrap items-center gap-8">
        <strong>{t("gateway.work.applications.offer.title")}</strong>
        <Tag tone={toneFor(state)}>{t(enumLabelKey("offerState", state))}</Tag>
        {latest?.version_number && latest.version_number > 1 ? (
          <span className="text-text-12 text-text-secondary">
            {t("gateway.work.applications.offer.version", { n: latest.version_number })}
          </span>
        ) : null}
      </div>
      {latest ? (
        <PropertyList
          items={[
            {
              label: t("gateway.work.applications.offer.amount"),
              value:
                formatMoney(locale, latest.amount_minor, latest.currency_code) ??
                t("gateway.common.unpriced"),
            },
            ...(latest.rate_type
              ? [
                  {
                    label: t("gateway.work.applications.offer.rateType"),
                    value: t(enumLabelKey("rateType", latest.rate_type)),
                  },
                ]
              : []),
            {
              label: t("gateway.work.applications.offer.dates"),
              value:
                formatDateRange(locale, latest.starts_on, latest.ends_on) ||
                t("gateway.common.noDate"),
            },
            ...(latest.expires_at
              ? [
                  {
                    label: t("gateway.work.applications.offer.expires"),
                    value: formatDateTime(locale, latest.expires_at),
                  },
                ]
              : []),
            ...(latest.proposed_side
              ? [
                  {
                    label: t("gateway.work.applications.offer.from"),
                    value: t(enumLabelKey("offerSide", latest.proposed_side)),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      {latest?.message ? (
        <p className="m-0 whitespace-pre-line text-text-13">{latest.message}</p>
      ) : null}
      {answerable && offer.id ? (
        <div className="flex flex-wrap items-start gap-8">
          <ActionButton
            action={acceptOfferAction.bind(null, offer.id)}
            label={t("gateway.work.applications.offer.accept")}
            variant="secondary"
          />
          <ActionButton
            action={declineOfferAction.bind(null, offer.id)}
            label={t("gateway.work.applications.offer.decline")}
          />
          {latest?.currency_code && latest.rate_type ? (
            <CounterForm
              offerId={offer.id}
              currency={latest.currency_code}
              rateType={latest.rate_type}
              rateTypeLabel={t(enumLabelKey("rateType", latest.rate_type))}
              startsOn={latest.starts_on ?? ""}
              endsOn={latest.ends_on ?? ""}
            />
          ) : null}
        </div>
      ) : null}
      {state === "Countered" && !fromOrg ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.work.applications.offer.waiting")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Work, Applications (Section 4.5.8): submitted applications and bids, offers to answer with
 * accept, decline or counter, interviews, and history. Sealed bids show only the person's own
 * lines (Section 8.7). In the table a selection of open applications is withdrawn at once (Section
 * 11.7); the page updates live as orgs review applications and send offers.
 */
export default async function ApplicationsPage({ searchParams }: PageProps<"/work/applications">) {
  const ctx = await requireNode("work.applications");
  const query = await searchParams;
  const views = getNode(sitemap, "work.applications").node.list?.views ?? ["list"];
  const view = pickView(query["view"], views, "list");
  const [t, locale, result] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyApplications(ctx.db),
  ]);
  const appIds = result.ok ? result.data.map((a) => a.id) : [];
  const offers = await readView(ctx.db, "offers", { in: ["application_id", appIds] });
  const offerIds = offers.ok ? offers.data.flatMap((o) => (o.id ? [o.id] : [])) : [];
  const versions = await readView(ctx.db, "offer_versions", { in: ["offer_id", offerIds] });
  // Under a role lens (A128) only applications for that role type's opportunities are listed.
  const apps = result.ok ? lensApplications(ctx.lens, result.data) : [];
  const offerFor = (appId: string) =>
    offers.ok ? offers.data.find((o) => o.application_id === appId) : undefined;

  return (
    <>
      <LiveRefresh
        topics={topics(
          personTopic("applications", "applicant_person_id", ctx.personId),
          ctx.acting
            ? personTopic("applications", "applicant_organization_id", ctx.acting.id)
            : null,
          idsTopic("offers", "application_id", appIds),
        )}
      />
      <PageTitle
        title={t("nav.gateway.primary.work")}
        action={
          <ViewSwitcher views={views} current={view} path="/work/applications" query={query} />
        }
      />
      <DestinationTabs ctx={ctx} destination="work" active="work.applications" t={t} />
      {!result.ok || !offers.ok || !versions.ok ? (
        <RegionError />
      ) : apps.length === 0 ? (
        <EmptyStateLink
          icon="Send"
          sentence={t("gateway.work.applications.empty")}
          actionLabel={t("gateway.work.applications.emptyAction")}
          href="/explore"
        />
      ) : view === "board" ? (
        <LinkBoard
          columns={APP_ENUMS.application_state.map((state) => ({
            state: APPLICATION_STATE_STYLE[state],
            label: t(enumLabelKey("applicationState", state)),
            cards: apps
              .filter((a) => a.state === state)
              .map((a) => ({
                key: a.id,
                title: a.opportunity?.title ?? a.key,
                meta: a.opportunity?.orgName ?? "",
                href: opportunityHref(a),
              })),
          }))}
        />
      ) : view === "table" ? (
        <LinkTable
          caption={t("nav.gateway.work.applications")}
          action="withdraw"
          columns={[
            { key: "title", label: t("gateway.work.applications.opportunity") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "submitted", label: t("gateway.work.applications.submitted") },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={apps.map((a) => ({
            id: a.id,
            label: a.opportunity?.title ?? a.key,
            // As the card's Withdraw: open applications; an offer is answered on its own.
            eligible: OPEN_APPLICATION_STATES.includes(a.state) && a.state !== "Offered",
            href: opportunityHref(a),
            title: a.opportunity?.title ?? a.key,
            org: a.opportunity?.orgName ?? "",
            submitted: formatDate(locale, a.submittedAt),
            state: t(enumLabelKey("applicationState", a.state)),
          }))}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {apps.map((a) => {
            const offer = offerFor(a.id);
            const total = a.bid ? bidTotal(a.bid.lines) : null;
            return (
              <li key={a.id}>
                <Card
                  title={a.opportunity?.title ?? a.key}
                  meta={
                    <Tag tone={toneFor(a.state)}>
                      {t(enumLabelKey("applicationState", a.state))}
                    </Tag>
                  }
                >
                  <PropertyList
                    items={[
                      ...(a.opportunity
                        ? [
                            {
                              label: t("gateway.work.engagements.org"),
                              value: a.opportunity.orgName,
                            },
                          ]
                        : []),
                      {
                        label: t("gateway.work.applications.submitted"),
                        value: formatDate(locale, a.submittedAt),
                      },
                      ...(a.proposedFeeMinor !== null
                        ? [
                            {
                              label: t("gateway.work.applications.fee"),
                              value: formatMoney(locale, a.proposedFeeMinor, a.currency) ?? "",
                            },
                          ]
                        : []),
                      ...(a.bid
                        ? [
                            {
                              label: t("gateway.work.applications.bid"),
                              value: t("gateway.work.applications.bidSummary", {
                                n: a.bid.lines.length,
                                total:
                                  formatMoney(locale, total, a.bid.currency) ??
                                  t("gateway.common.unpriced"),
                              }),
                            },
                          ]
                        : []),
                      ...a.interviews.map((i) => ({
                        label: t(enumLabelKey("interviewKind", i.kind)),
                        value: [formatDateTime(locale, i.scheduledAt), i.location]
                          .filter(Boolean)
                          .join(" · "),
                      })),
                    ]}
                  />
                  {offer ? (
                    <OfferPanel
                      offer={offer}
                      versions={
                        versions.ok ? versions.data.filter((v) => v.offer_id === offer.id) : []
                      }
                      locale={locale}
                      t={t}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-8">
                    {a.opportunity ? (
                      <Link
                        href={opportunityHref(a) as Route}
                        className="text-text-13 text-accent-text underline"
                      >
                        {t("gateway.work.applications.viewOpportunity")}
                      </Link>
                    ) : null}
                    {OPEN_APPLICATION_STATES.includes(a.state) && a.state !== "Offered" ? (
                      <ActionButton
                        action={decideApplicationAction.bind(null, a.id, a.state, "Withdrawn")}
                        label={t("gateway.work.applications.withdraw")}
                        variant="ghost"
                        done={t("gateway.work.applications.withdrawn")}
                      />
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
