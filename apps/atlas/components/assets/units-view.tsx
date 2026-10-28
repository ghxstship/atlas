import {
  ASSET_STATES,
  assetStateKey,
  getAssetUnit,
  isAssetState,
  listAssetClasses,
  listAssetCustody,
  listAssetUnitHire,
  listAssetUnits,
  type AssetUnit,
  type AssetUnitHire,
  type CustodyLedgerEntry,
} from "@xos/data/assets";
import { getFormatter } from "next-intl/server";
import Link from "next/link";
import type { Route } from "next";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { NewUnitForm } from "@/components/assets/forms";
import { Breadcrumbs, PageHeader } from "@/components/assets/ui";
import { UnitRecord } from "@/components/assets/unit-record";
import { assetCapabilities, loadPickers, must } from "@/lib/assets/context";
import { DEFAULT_CURRENCY, pageViews } from "@/lib/assets/page";
import {
  ASSET_STATE_TONE,
  BUILT_IN_UNIT_VIEWS,
  BUILT_IN_UNIT_VIEW_KEY,
  inBuiltInUnitView,
  isBuiltInUnitView,
  matches,
  type ListQuery,
} from "@/lib/assets/views";
import type { OrgContext } from "@/lib/shell/context";
import { customFieldList } from "@/lib/custom-fields/server";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { LiveRefresh } from "@/components/live/live-refresh";

/**
 * The units collection, shared by Assets > Units and a project's Assets tab (same component, with
 * the project filter; Section 4.5.2 "both"). The peek and the full page are states of this route:
 * `?peek=<asset tag>` and `&full=1`.
 */
export async function UnitsView({
  ctx,
  node,
  query,
  basePath,
  project,
}: {
  ctx: OrgContext;
  node: string;
  query: ListQuery;
  basePath: string;
  project?: { id: string; key: string; name: string };
}) {
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  // Assets are the org's: warranty and service dates follow its calendar, not UTC's (A71).
  const today = await orgToday(ctx);
  const [unitsResult, classesResult, pickers, custom] = await Promise.all([
    listAssetUnits(db, ctx.org.id, project ? { projectId: project.id } : {}),
    listAssetClasses(db, ctx.org.id),
    loadPickers(ctx, t("assets.common.unnamed")),
    customFieldList(ctx, "app.asset_units", new URLSearchParams(query.conditions ?? "")),
  ]);
  const units = must(unitsResult, "asset units");
  const classes = must(classesResult, "asset classes");
  const stateLabel = (u: AssetUnit) => t(`assets.states.${assetStateKey(u.state)}`);
  const custodianOf = (u: AssetUnit) =>
    u.custody ? (u.custody.custodianName ?? u.custody.venueName ?? "") : "";

  const peekTag = query.peek;
  const detail = peekTag ? await getAssetUnit(db, ctx.org.id, peekTag) : null;
  if (detail && !detail.ok && detail.error.kind !== "not-found") must(detail, "asset unit");

  const record =
    detail && detail.ok ? (
      <UnitRecord
        org={ctx.org.slug}
        unit={detail.data}
        pickers={pickers}
        can={can}
        currency={DEFAULT_CURRENCY}
        today={today}
        t={t}
        db={db}
        me={ctx.viewer.person?.id ?? null}
        compact={!query.full}
      />
    ) : null;

  if (peekTag && query.full) {
    return (
      <div className="flex flex-col gap-16">
        <Breadcrumbs
          items={[
            { label: project ? project.key : t("nav.atlas.items.assets"), href: basePath },
            { label: peekTag },
          ]}
        />
        {record ?? (
          <>
            <PageHeader title={peekTag} />
            <p className="m-0 text-text-14 text-text-secondary">
              {t("assets.units.notFound", { tag: peekTag })}
            </p>
            <Link href={basePath as Route} className="text-text-14 text-accent-text underline">
              {t("assets.units.backToUnits")}
            </Link>
          </>
        )}
      </div>
    );
  }

  const filter = query.filter && isAssetState(query.filter) ? query.filter : undefined;
  // Built-in views (G-96): Hired in reads app.asset_unit_hire, which shows no vendor or cost.
  const preset = isBuiltInUnitView(query.filter) ? query.filter : undefined;
  const hire = new Map<string, AssetUnitHire>(
    preset === "view:hired-in"
      ? must(await listAssetUnitHire(db, ctx.org.id), "unit hire").map((h) => [h.assetUnitId, h])
      : [],
  );
  const hiredIn = preset === "view:hired-in";
  const visible = units.filter(
    (u) =>
      (!filter || u.state === filter) &&
      (!preset ||
        inBuiltInUnitView(preset, {
          state: u.state,
          acquisitionKind: hire.get(u.id)?.acquisitionKind ?? "Purchase",
        })) &&
      custom.keep(u.id) &&
      matches(query.q, u.assetTag, u.className, custodianOf(u), u.homeVenueName),
  );
  const rows: CollectionRow[] = visible.map((u) => ({
    key: u.id,
    id: u.id,
    peek: u.assetTag,
    title: `${u.assetTag} · ${u.className}`,
    meta: u.custody
      ? t("assets.units.heldBy", { custodian: custodianOf(u) || t("assets.common.notRecorded") })
      : t("assets.units.noCustody"),
    tone: ASSET_STATE_TONE[u.state],
    stateLabel: stateLabel(u),
    group: u.state,
    cells: {
      assetTag: u.assetTag,
      className: u.className,
      state: { state: ASSET_STATE_TONE[u.state], label: stateLabel(u) },
      custodian: custodianOf(u) || null,
      project: u.custody?.projectKey ?? null,
      homeVenue: u.homeVenueName,
      ...(hiredIn ? hireCells(hire.get(u.id), format, t) : {}),
    },
  }));

  const { view, views } = pageViews(node, query.view, t);
  const schedule =
    view === "resource-schedule" ? await weekSchedule(ctx, visible, format, t, today) : undefined;

  const classOptions = classes.map((c) => ({ value: c.id, label: c.name }));
  const canCreate = can.write && !project && classes.length > 0;

  return (
    <>
      {/* Units update live as custody and state change (Section 11.7, ADR 0044). */}
      <LiveRefresh topics={[{ table: "asset_units", filter: `org_id=eq.${ctx.org.id}` }]} />
      <AssetsCollection
        title={
          project
            ? t("assets.project.unitsTitle", { project: project.key })
            : t("nav.atlas.pages.assets.units")
        }
        view={view}
        views={views}
        total={units.length}
        rows={rows}
        customFields={await custom.view(visible.map((u) => u.id))}
        columns={[
          { key: "assetTag", label: t("assets.fields.assetTag"), type: "code" },
          { key: "className", label: t("assets.fields.classId") },
          { key: "state", label: t("assets.fields.state"), type: "state" },
          { key: "custodian", label: t("assets.fields.custodian") },
          { key: "project", label: t("assets.fields.projectId"), type: "code" },
          { key: "homeVenue", label: t("assets.fields.homeVenueId") },
          ...(hiredIn
            ? [
                { key: "hireEnds", label: t("assets.hire.endsAt") },
                { key: "offHire", label: t("assets.hire.offHire"), type: "state" as const },
              ]
            : []),
        ]}
        {...(units.length > 0
          ? {
              filterOptions: stateOptions(t),
              presets: {
                label: t("assets.views.builtIn.label"),
                allLabel: t("assets.views.builtIn.all"),
                options: BUILT_IN_UNIT_VIEWS.map((v) => ({
                  value: v,
                  label: t(`assets.views.builtIn.${BUILT_IN_UNIT_VIEW_KEY[v]}`),
                })),
              },
            }
          : {})}
        bulk={
          can.write
            ? {
                org: ctx.org.slug,
                resource: "asset_units",
                fields: [
                  {
                    key: "asset_state",
                    label: t("assets.fields.state"),
                    reason: true,
                    options: stateOptions(t),
                  },
                  {
                    key: "home_venue_id",
                    label: t("assets.fields.homeVenueId"),
                    options: [
                      { value: null, label: t("assets.common.notRecorded") },
                      ...pickers.venues.map((v) => ({ value: v.value, label: v.label })),
                    ],
                  },
                ],
              }
            : null
        }
        {...(schedule ? { schedule } : {})}
        create={
          canCreate
            ? {
                label: t("assets.units.create.open"),
                dialog: (
                  <NewUnitForm
                    org={ctx.org.slug}
                    classes={classOptions}
                    conditions={pickers.conditions}
                    venues={pickers.venues}
                  />
                ),
              }
            : null
        }
        empty={
          project
            ? {
                sentence: t("assets.project.empty", { project: project.key }),
                actionLabel: t("assets.project.emptyAction"),
                href: `/${ctx.org.slug}/assets/custody-ledger`,
              }
            : classes.length === 0
              ? {
                  sentence: t("assets.units.emptyNoClasses"),
                  actionLabel: t("assets.units.emptyNoClassesAction"),
                  href: `/${ctx.org.slug}/assets/asset-classes`,
                }
              : {
                  sentence: t(can.write ? "assets.units.empty" : "assets.units.emptyReadOnly"),
                  actionLabel: t(
                    can.write ? "assets.units.create.open" : "assets.units.emptyReadOnlyAction",
                  ),
                  href: `/${ctx.org.slug}/assets/custody-ledger`,
                }
        }
        peek={
          peekTag
            ? {
                title: peekTag,
                content: record ?? (
                  <p className="m-0 text-text-14 text-text-secondary">
                    {t("assets.units.notFound", { tag: peekTag })}
                  </p>
                ),
              }
            : null
        }
      />
    </>
  );
}

/** The Hired in view's columns: when the hire ends, and whether its off-hire is due. */
function hireCells(
  hire: AssetUnitHire | undefined,
  format: Awaited<ReturnType<typeof getFormatter>>,
  t: (key: string) => string,
) {
  return {
    hireEnds: hire?.hireEndsAt
      ? format.dateTime(new Date(hire.hireEndsAt), { dateStyle: "medium", timeStyle: "short" })
      : null,
    offHire: hire?.offHireDue
      ? { state: "blocked" as const, label: t("assets.hire.offHireDue") }
      : null,
  };
}

function stateOptions(t: (key: string) => string) {
  return ASSET_STATES.map((s) => ({ value: s, label: t(`assets.states.${assetStateKey(s)}`) }));
}

/** This week by unit: the days each unit was held by a person, from the custody ledger. */
async function weekSchedule(
  ctx: OrgContext,
  units: readonly AssetUnit[],
  format: Awaited<ReturnType<typeof getFormatter>>,
  t: (key: string, values?: Record<string, string | number>) => string,
  today: string,
) {
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d;
  });
  const ledger = must(
    await listAssetCustody(ctx.viewer.db, ctx.org.id, { limit: 1000 }),
    "custody ledger",
  );
  const byUnit = new Map<string, CustodyLedgerEntry[]>();
  for (const entry of ledger)
    byUnit.set(entry.unitId, [...(byUnit.get(entry.unitId) ?? []), entry]);
  return {
    days: days.map((d) => ({
      key: d.toISOString().slice(0, 10),
      dow: format.dateTime(d, { weekday: "short", timeZone: "UTC" }),
      date: d.getUTCDate(),
      weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    })),
    people: units.map((u) => ({
      name: u.assetTag,
      role: u.className,
      shifts: days.flatMap((d) => {
        // Custody is a record of the past; days after today show nothing yet.
        if (d.toISOString().slice(0, 10) > today) return [];
        const end = new Date(d);
        end.setUTCDate(d.getUTCDate() + 1);
        const held = (byUnit.get(u.id) ?? []).find((e) => new Date(e.since) < end);
        if (!held || (held.membershipId === null && held.engagementId === null)) return [];
        return [
          {
            day: d.toISOString().slice(0, 10),
            time: held.projectKey ?? held.custodianName ?? t("assets.units.out"),
            state: "active" as const,
          },
        ];
      }),
    })),
  };
}
