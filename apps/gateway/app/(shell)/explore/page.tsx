import { APP_ENUMS, searchOpportunities } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { SaveSearchForm } from "@/components/explore/forms";
import { OpportunityLinkCard } from "@/components/page/opportunity-card";
import {
  childTabLinks,
  PageTitle,
  pickView,
  RegionError,
  SectionTabs,
  ViewSwitcher,
} from "@/components/page/page";
import { Button, EmptyStateLink, Input } from "@/components/ui";
import { exploreViews, hasFilters, parseExploreQuery } from "@/lib/explore";
import { formatDate, formatDateRange, formatPayRange } from "@/lib/format";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.title") };
}

/**
 * Explore (Section 4.5.8, Section 4.4.3): the For You list of opportunities open to the person,
 * search and filter chips, cards or a list, and saving the search for alerts. Phone first: the
 * filters fold into a disclosure and cards stack in one column (Section 11.12, Discover).
 */
export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const ctx = await requireNode("explore");
  const query = await searchParams;
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  const listed = getNode(sitemap, "explore").node.list?.views ?? ["gallery"];
  const views = exploreViews(listed, false);
  const view = pickView(query["view"], views, "gallery");
  const parsed = parseExploreQuery(query);
  const results = await searchOpportunities(ctx.db, {
    ...parsed.filter,
    ...(ctx.brand.kind === "org" ? { orgId: ctx.brand.org.orgId } : {}),
  });
  const tabs = [
    { id: "explore", label: t("nav.gateway.primary.explore"), href: "/explore" },
    ...childTabLinks(childTabs(sitemap, "explore", ctx.nav), t),
  ];
  const filtered = hasFilters(parsed);

  return (
    <>
      <PageTitle
        title={t("gateway.explore.title")}
        lead={t("gateway.explore.lead")}
        action={<ViewSwitcher views={views} current={view} path="/explore" query={query} />}
      />
      <SectionTabs label={t("gateway.shell.pageTabs")} tabs={tabs} active="explore" />

      <form action="/explore" method="get" role="search" className="flex flex-col gap-12">
        <input type="hidden" name="view" value={view} />
        <div className="flex flex-wrap items-end gap-8">
          <Input
            id="explore-q"
            name="q"
            type="search"
            label={t("gateway.explore.searchLabel")}
            placeholder={t("gateway.explore.searchHint")}
            defaultValue={parsed.q}
            width="100%"
          />
        </div>
        <details className="rounded-control border border-border-subtle p-12" open={filtered}>
          <summary className="min-h-touch-min cursor-pointer content-center text-text-13 font-medium">
            {t("gateway.explore.filters")}
          </summary>
          <div className="flex flex-col gap-12 pt-12">
            <fieldset className="m-0 flex flex-wrap gap-8 border-0 p-0">
              <legend className="mb-8 text-text-12 font-medium text-text-secondary">
                {t("gateway.explore.roleTypes")}
              </legend>
              {APP_ENUMS.external_role_type
                .filter((r) => r !== "Client" && r !== "Artist Representative")
                .map((role) => (
                  <label
                    key={role}
                    className="inline-flex min-h-touch-min cursor-pointer items-center gap-6 rounded-pill border border-border-control px-12 text-text-13 has-checked:bg-bg-hover has-checked:text-text-primary"
                  >
                    <input
                      type="checkbox"
                      name="role"
                      value={role}
                      defaultChecked={parsed.roles.includes(role)}
                    />
                    {t(enumLabelKey("externalRoleType", role))}
                  </label>
                ))}
            </fieldset>
            <div className="flex flex-wrap gap-8">
              <Input
                id="explore-from"
                name="from"
                type="date"
                label={t("gateway.explore.startsAfter")}
                defaultValue={parsed.from}
              />
              <Input
                id="explore-to"
                name="to"
                type="date"
                label={t("gateway.explore.endsBefore")}
                defaultValue={parsed.to}
              />
              <Input
                id="explore-min-pay"
                name="minPay"
                inputMode="decimal"
                label={t("gateway.explore.minPay")}
                help={t("gateway.explore.minPayHelp")}
                defaultValue={parsed.minPay}
              />
            </div>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-8">
          <Button type="submit" variant="primary" icon="Search">
            {t("gateway.explore.search")}
          </Button>
          {filtered ? (
            <Link
              href={`/explore?view=${view}` as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("gateway.explore.clear")}
            </Link>
          ) : null}
          <Link
            href="/explore/how-ranking-works"
            className="ms-auto text-text-13 text-text-secondary underline"
          >
            {t("gateway.explore.rankingLink")}
          </Link>
        </div>
      </form>

      {filtered ? (
        <SaveSearchForm
          defaultName={
            parsed.q ||
            (parsed.roles[0]
              ? t(enumLabelKey("externalRoleType", parsed.roles[0]))
              : t("gateway.explore.title"))
          }
          roleType={parsed.roles.length === 1 ? (parsed.roles[0] ?? "") : ""}
          startsAfter={parsed.from}
          endsBefore={parsed.to}
        />
      ) : null}

      {!results.ok ? (
        <RegionError />
      ) : (
        <>
          {/* The count heads the results, so the cards' titles (h3) follow an h2 (heading order). */}
          <h2 className="m-0 text-text-13 font-normal text-text-secondary">
            <span role="status">{t("gateway.explore.results", { n: results.data.length })}</span>
          </h2>
          {results.data.length === 0 ? (
            <EmptyStateLink
              icon="SearchX"
              sentence={t("gateway.explore.empty")}
              actionLabel={t("gateway.explore.emptyAction")}
              href="/explore"
            />
          ) : view === "list" ? (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
              {results.data.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-16 gap-y-4 px-16 py-12">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      href={`/explore/${o.key}` as Route}
                      className="font-medium text-text-primary"
                    >
                      {o.title}
                    </Link>
                    <span className="text-text-13 text-text-secondary">
                      {o.orgName} ·{" "}
                      {formatDateRange(locale, o.startsOn, o.endsOn) || t("gateway.common.noDate")}
                      {o.venueName ? ` · ${o.venueName}` : ""}
                    </span>
                  </div>
                  <strong className="tabular-nums">
                    {o.rateOnRequest
                      ? t("gateway.common.rateOnRequest")
                      : (formatPayRange(locale, o.payMinMinor, o.payMaxMinor, o.currency) ??
                        t("gateway.common.rateOnRequest"))}
                  </strong>
                  {o.deadlineAt ? (
                    <span className="text-text-12 text-text-secondary">
                      {t("gateway.explore.deadline", { date: formatDate(locale, o.deadlineAt) })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
              {results.data.map((o) => (
                <li key={o.id}>
                  <OpportunityLinkCard opportunity={o} locale={locale} t={t} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
