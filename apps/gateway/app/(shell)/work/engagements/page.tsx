import {
  APP_ENUMS,
  isCurrentEngagement,
  listMyEngagements,
  type Engagement,
} from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { LinkBoard, LinkTable } from "@/components/page/collections";
import { PageTitle, pickView, RegionError, Section, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { BrandMark, EmptyStateLink, InlineAlert, Tag } from "@/components/ui";
import { inBrandScope } from "@/lib/brand/brand";
import { formatDateRange } from "@/lib/format";
import { lensEngagements } from "@/lib/shell/role-lens";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";
import { engagementTitle } from "@/lib/engagement-state";
import { ENGAGEMENT_STATE_STYLE, toneFor } from "@/lib/states";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.work.engagements") };
}

function href(e: Engagement): string {
  return `/work/engagements/${e.key}/overview`;
}

/** Engagements grouped by org, then project, in the order they start. */
function groupByOrg(engagements: readonly Engagement[]): [string, Engagement[]][] {
  const groups = new Map<string, Engagement[]>();
  for (const e of engagements) groups.set(e.orgName, [...(groups.get(e.orgName) ?? []), e]);
  return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
}

function Row({ e, locale, t }: { e: Engagement; locale: string; t: Translate }) {
  return (
    <li>
      <Link
        href={href(e) as Route}
        className="flex min-h-touch-min flex-wrap items-center gap-x-12 gap-y-4 px-16 py-12 text-text-primary no-underline hover:bg-bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="font-medium">
            {engagementTitle(e, (r) => t(enumLabelKey("externalRoleType", r)))}
          </span>
          <span className="text-text-13 text-text-secondary">
            {e.projectName} · {formatDateRange(locale, e.startDate, e.endDate)} ·{" "}
            {t(enumLabelKey("externalRoleType", e.roleType))}
          </span>
        </span>
        <Tag tone={toneFor(e.state)}>{t(enumLabelKey("engagementState", e.state))}</Tag>
      </Link>
    </li>
  );
}

/**
 * Work, Engagements (Section 4.5.8): current engagements, then complete or canceled ones, grouped
 * by org and project, as a list, a table or a board by state. Groups follow the state, not the
 * dates, so a future-dated engagement that closed early is never called past (finding A59-021). An
 * Account Member sees only the engagements assigned to them; the api_external view decides that.
 */
export default async function EngagementsPage({ searchParams }: PageProps<"/work/engagements">) {
  const ctx = await requireNode("work.engagements");
  const query = await searchParams;
  const views = getNode(sitemap, "work.engagements").node.list?.views ?? ["list"];
  const view = pickView(query["view"], views, "list");
  const [t, locale, result] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyEngagements(ctx.db),
  ]);
  const orgFilter = typeof query["org"] === "string" ? query["org"] : null;
  // Under a role lens (A128) only that role type's engagements are listed.
  const all = result.ok
    ? lensEngagements(ctx.lens, result.data).filter((e) => inBrandScope(ctx.brand, e.orgId))
    : [];
  const shown = orgFilter ? all.filter((e) => e.orgId === orgFilter) : all;
  const current = shown.filter(isCurrentEngagement);
  const closed = shown.filter((e) => !isCurrentEngagement(e));
  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.work")}
        action={
          <ViewSwitcher views={views} current={view} path="/work/engagements" query={query} />
        }
      />
      <DestinationTabs ctx={ctx} destination="work" active="work.engagements" t={t} />
      {orgFilter && shown[0] ? (
        <InlineAlert tone="info">
          {t("gateway.common.orgFilter", { org: shown[0].orgName })}{" "}
          <Link href={"/work/engagements" as Route} className="text-accent-text underline">
            {t("gateway.common.clearFilter")}
          </Link>
        </InlineAlert>
      ) : null}
      {!result.ok ? (
        <RegionError />
      ) : shown.length === 0 ? (
        <EmptyStateLink
          icon="BriefcaseBusiness"
          sentence={t("gateway.work.engagements.empty")}
          actionLabel={t("gateway.work.engagements.emptyAction")}
          href="/explore"
        />
      ) : view === "board" ? (
        <LinkBoard
          columns={APP_ENUMS.engagement_state.map((state) => ({
            state: ENGAGEMENT_STATE_STYLE[state],
            label: t(enumLabelKey("engagementState", state)),
            cards: shown
              .filter((e) => e.state === state)
              .map((e) => ({
                key: e.id,
                title: engagementTitle(e, (r) => t(enumLabelKey("externalRoleType", r))),
                meta: `${e.orgName} · ${e.projectName}`,
                href: href(e),
              })),
          }))}
        />
      ) : view === "table" ? (
        <LinkTable
          caption={t("nav.gateway.work.engagements")}
          columns={[
            { key: "role", label: t("gateway.work.engagements.role") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "project", label: t("gateway.work.engagements.project") },
            { key: "dates", label: t("gateway.work.engagements.dates") },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={shown.map((e) => ({
            href: href(e),
            role: engagementTitle(e, (r) => t(enumLabelKey("externalRoleType", r))),
            org: e.orgName,
            project: e.projectName,
            dates: formatDateRange(locale, e.startDate, e.endDate),
            state: t(enumLabelKey("engagementState", e.state)),
          }))}
        />
      ) : (
        <>
          {[
            { id: "current", title: t("gateway.work.engagements.current"), list: current },
            { id: "closed", title: t("gateway.work.engagements.closed"), list: closed },
          ]
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <Section key={g.id} id={`engagements-${g.id}`} title={g.title}>
                {groupByOrg(g.list).map(([org, list]) => (
                  <div key={org} className="flex flex-col gap-8">
                    <h3 className="m-0 flex items-center gap-6 text-text-13 font-semibold text-text-secondary">
                      <BrandMark name={org} size="sm" iconOnly />
                      {org}
                    </h3>
                    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
                      {list.map((e) => (
                        <Row key={e.id} e={e} locale={locale} t={t} />
                      ))}
                    </ul>
                  </div>
                ))}
              </Section>
            ))}
        </>
      )}
    </>
  );
}
