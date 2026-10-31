import { listCategoriesInDiscipline, listDisciplines } from "@xos/data/canon";
import {
  APP_ENUMS,
  listMarketplacePlaces,
  searchMarketplace,
  type RankedOpportunity,
} from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { cache, type ReactNode } from "react";
import { SaveSearchForm } from "@/components/explore/forms";
import { ExploreOrganizations } from "@/components/explore/organizations";
import { SwipeActions } from "@/components/explore/swipe-actions";
import { OpportunityLinkCard } from "@/components/page/opportunity-card";
import {
  childTabLinks,
  PageTitle,
  pickView,
  RegionError,
  SectionTabs,
  ViewSwitcher,
} from "@/components/page/page";
import {
  Accordion,
  Button,
  Checkbox,
  EmptyStateLink,
  Input,
  MoreFields,
  Select,
  Tag,
} from "@/components/ui";
import {
  passOpportunityAction,
  saveOpportunityAction,
  undoPassAction,
  unsaveListingAction,
} from "@/lib/actions/marketplace";
import {
  exploreViews,
  hasFilters,
  hasMoreFilters,
  parseExploreQuery,
  RADII_KM,
  recommendationReasons,
  resolvePlace,
} from "@/lib/explore";
import { formatDate, formatDateRange, formatPayRange } from "@/lib/format";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.title") };
}

/** Canon disciplines change only with a canon release, so one read serves the request. */
const disciplinesFor = cache(listDisciplines);

/** Query parameters that describe the search itself, which a saved search keeps. */
const SEARCH_KEYS = ["q", "role", "from", "to", "minPay", "disc", "cat", "cert", "near", "radius"];

function searchString(query: Readonly<Record<string, string | string[] | undefined>>): string {
  const params = new URLSearchParams();
  for (const key of SEARCH_KEYS) {
    const value = query[key];
    for (const v of typeof value === "string" ? [value] : (value ?? [])) params.append(key, v);
  }
  return params.toString();
}

/** Why a listing is recommended, and how far away it is, under its card. */
function Reasons({ o, t }: { o: RankedOpportunity; t: Translate }) {
  const reasons = recommendationReasons(o.recommendation);
  if (reasons.length === 0 && o.distanceKm === null) return null;
  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-4 p-0"
      aria-label={t("gateway.explore.why.label")}
    >
      {reasons.map((r) => (
        <li key={r}>
          <Tag tone="success">{t(`gateway.explore.why.${r}`)}</Tag>
        </li>
      ))}
      {o.distanceKm !== null ? (
        <li>
          <Tag>{t("gateway.explore.distance", { km: o.distanceKm })}</Tag>
        </li>
      ) : null}
    </ul>
  );
}

/** Save and Pass for one listing, as swipe gestures on phones and as buttons and keys everywhere. */
function ListingActions({
  o,
  t,
  children,
}: {
  o: RankedOpportunity;
  t: Translate;
  children: ReactNode;
}) {
  return (
    <SwipeActions
      label={t("gateway.explore.swipe.actions", { title: o.title })}
      failed={t("gateway.explore.swipe.failed")}
      right={
        o.saved
          ? {
              label: t("gateway.explore.swipe.unsave"),
              action: unsaveListingAction.bind(null, o.id),
              icon: "BookmarkCheck",
              shortcut: "s",
              done: t("gateway.explore.swipe.unsaved"),
            }
          : {
              label: t("gateway.explore.swipe.save"),
              action: saveOpportunityAction.bind(null, o.id),
              icon: "BookmarkPlus",
              shortcut: "s",
              done: t("gateway.explore.swipe.saved"),
            }
      }
      left={
        o.passed
          ? {
              label: t("gateway.explore.swipe.undo"),
              action: undoPassAction.bind(null, o.id),
              icon: "Undo2",
              shortcut: "p",
              done: t("gateway.explore.swipe.restored"),
            }
          : {
              label: t("gateway.explore.swipe.pass"),
              action: passOpportunityAction.bind(null, o.id),
              icon: "X",
              shortcut: "p",
              done: t("gateway.explore.swipe.passed", { title: o.title }),
              hides: true,
              undo: {
                label: t("gateway.explore.swipe.undo"),
                action: undoPassAction.bind(null, o.id),
              },
            }
      }
    >
      {children}
    </SwipeActions>
  );
}

/**
 * Explore (Section 4.5.8, Section 4.4.3): the For You list of opportunities open to the person, best
 * match first by the published ranking factors (or soonest deadline), with search and filter chips
 * for role type, discipline and category, distance from a place, dates, pay and a required
 * certification, and saving the search for alerts. Phone first: the filters fold into a disclosure,
 * cards stack in one column, and each card swipes right to save and left to pass, with buttons and
 * keys for both (Section 11.12, Discover).
 */
export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const ctx = await requireNode("explore");
  const query = await searchParams;
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  const listed = getNode(sitemap, "explore").node.list?.views ?? ["gallery"];
  const views = exploreViews(listed, false);
  const view = pickView(query["view"], views, "gallery");
  const parsed = parseExploreQuery(query);
  const tabs = [
    { id: "explore", label: t("nav.gateway.primary.explore"), href: "/explore" },
    // Public organization profiles (journey 62), a view of Explore rather than its own page.
    {
      id: "organizations",
      label: t("gateway.explore.organizations.tab"),
      href: "/explore?show=organizations",
    },
    ...childTabLinks(childTabs(sitemap, "explore", ctx.nav), t),
  ];
  const filtered = hasFilters(parsed);

  if (query["show"] === "organizations") {
    return (
      <>
        <PageTitle
          title={t("gateway.explore.title")}
          lead={t("gateway.explore.organizations.lead")}
        />
        <SectionTabs label={t("gateway.shell.pageTabs")} tabs={tabs} active="organizations" />
        <ExploreOrganizations
          db={ctx.db}
          t={t}
          query={typeof query["q"] === "string" ? query["q"].trim() : ""}
        />
      </>
    );
  }
  const [places, disciplines, categories] = await Promise.all([
    listMarketplacePlaces(ctx.db),
    disciplinesFor(ctx.db),
    parsed.disc ? listCategoriesInDiscipline(ctx.db, parsed.disc) : null,
  ]);
  const near = places.ok ? resolvePlace(parsed, places.data) : null;
  const results = await searchMarketplace(ctx.db, {
    ...parsed.filter,
    ...(near ? { near } : {}),
    ...(ctx.brand.kind === "org" ? { orgId: ctx.brand.org.orgId } : {}),
  });

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
          <div className="min-w-0 flex-[1_1_16rem]">
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
          <div className="flex-[0_1_12rem]">
            <Select
              id="explore-sort"
              name="sort"
              label={t("gateway.explore.sortLabel")}
              value={parsed.sort}
              options={[
                { value: "recommended", label: t("gateway.explore.sort.recommended") },
                { value: "soonest", label: t("gateway.explore.sort.soonest") },
              ]}
            />
          </div>
        </div>
        {/* Filters and, inside them, More fields are kept-mounted disclosures: collapsed controls are
            hidden and still submit with the search (gate 27: at most seven fields before More fields).
            The Filters header is an h2: it follows the page's h1 (heading order). */}
        <Accordion
          keepMounted
          headingLevel={2}
          items={[
            {
              title: t("gateway.explore.filters"),
              open: filtered || parsed.passed,
              content: (
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
                  <MoreFields open={hasMoreFilters(parsed)}>
                    <div className="flex flex-wrap gap-8">
                      <Select
                        id="explore-disc"
                        name="disc"
                        label={t("gateway.explore.discipline")}
                        value={parsed.disc}
                        options={[
                          { value: "", label: t("gateway.explore.disciplineAny") },
                          ...(disciplines.ok ? disciplines.data : []).map((d) => ({
                            value: d.code,
                            label: `${d.name} · ${d.code}`,
                          })),
                        ]}
                      />
                      {categories?.ok && categories.data.length > 0 ? (
                        <Select
                          id="explore-cat"
                          name="cat"
                          label={t("gateway.explore.category")}
                          value={parsed.cat}
                          options={[
                            { value: "", label: t("gateway.explore.categoryAny") },
                            ...categories.data.map((c) => ({
                              value: c.urid,
                              label: `${c.name} · ${c.urid}`,
                            })),
                          ]}
                        />
                      ) : null}
                      <Input
                        id="explore-cert"
                        name="cert"
                        label={t("gateway.explore.certification")}
                        help={t("gateway.explore.certificationHelp")}
                        defaultValue={parsed.cert}
                      />
                    </div>
                    <div className="flex flex-wrap gap-8">
                      <Select
                        id="explore-near"
                        name="near"
                        label={t("gateway.explore.near")}
                        help={t("gateway.explore.nearHelp")}
                        value={near?.label ?? ""}
                        options={[
                          { value: "", label: t("gateway.explore.nearAny") },
                          ...(places.ok ? places.data : []).map((p) => ({
                            value: p.label,
                            label: p.label,
                          })),
                        ]}
                      />
                      <Select
                        id="explore-radius"
                        name="radius"
                        label={t("gateway.explore.radius")}
                        value={String(parsed.radiusKm)}
                        options={RADII_KM.map((km) => ({
                          value: String(km),
                          label: t("gateway.explore.radiusOption", { km }),
                        }))}
                      />
                    </div>
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
                    <Checkbox
                      name="passed"
                      value="1"
                      defaultChecked={parsed.passed}
                      label={t("gateway.explore.showPassed")}
                    />
                  </MoreFields>
                </div>
              ),
            },
          ]}
        />
        <div className="flex flex-wrap items-center gap-8">
          <Button type="submit" variant="primary" icon="Search">
            {t("gateway.explore.search")}
          </Button>
          {filtered || parsed.passed ? (
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
          search={searchString(query)}
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
              secondary
            />
          ) : view === "list" ? (
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {results.data.map((o) => (
                <li key={o.id}>
                  <ListingActions o={o} t={t}>
                    <div className="flex flex-wrap items-center gap-x-16 gap-y-4 rounded-card border border-border-subtle bg-bg-raised px-16 py-12">
                      <div className="flex min-w-0 flex-1 flex-col">
                        <Link
                          href={`/explore/${o.key}` as Route}
                          className="font-medium text-text-primary"
                        >
                          {o.title}
                        </Link>
                        <span className="text-text-13 text-text-secondary">
                          {o.orgName} ·{" "}
                          {formatDateRange(locale, o.startsOn, o.endsOn) ||
                            t("gateway.common.noDate")}
                          {o.venueName
                            ? ` · ${o.venueName}`
                            : o.clientHidden && o.venueLocality
                              ? ` · ${o.venueLocality}`
                              : ""}
                        </span>
                        {o.clientHidden ? (
                          <span>
                            <Tag>{t("gateway.explore.clientHidden.tag")}</Tag>
                          </span>
                        ) : null}
                        <Reasons o={o} t={t} />
                      </div>
                      <strong className="tabular-nums">
                        {o.rateOnRequest
                          ? t("gateway.common.rateOnRequest")
                          : (formatPayRange(locale, o.payMinMinor, o.payMaxMinor, o.currency) ??
                            t("gateway.common.rateOnRequest"))}
                      </strong>
                      {o.deadlineAt ? (
                        <span className="text-text-12 text-text-secondary">
                          {t("gateway.explore.deadline", {
                            date: formatDate(locale, o.deadlineAt),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </ListingActions>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
              {results.data.map((o) => (
                <li key={o.id}>
                  <ListingActions o={o} t={t}>
                    <OpportunityLinkCard
                      opportunity={o}
                      locale={locale}
                      t={t}
                      extra={<Reasons o={o} t={t} />}
                    />
                  </ListingActions>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
