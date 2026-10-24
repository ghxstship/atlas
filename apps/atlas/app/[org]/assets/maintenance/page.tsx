import {
  ASSET_STATES,
  assetStateKey,
  listAssetMaintenance,
  listAssetUnits,
} from "@xos/data/assets";
import { getFormatter } from "next-intl/server";
import Link from "next/link";
import type { Route } from "next";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { AssetCollab } from "@/components/assets/collab";
import { MaintenanceForm } from "@/components/assets/forms";
import { Money, PropertyList } from "@/components/assets/ui";
import { requireNode } from "@/lib/shell/require-node";
import { assetCapabilities, must } from "@/lib/assets/context";
import { majorUnits } from "@/lib/assets/money";
import { DEFAULT_CURRENCY, monthOf, pageViews } from "@/lib/assets/page";
import { ASSET_STATE_TONE, matches, readQuery } from "@/lib/assets/views";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Assets > Maintenance (Section 4.5.5): work done on units, newest first. An unknown cost stays
 * unknown, never zero (Section 3.7). The board groups work by the unit's current state, so gear
 * still in maintenance stands out; the calendar places work on the day it was done.
 */
export default async function MaintenancePage({
  params,
  searchParams,
}: PageProps<"/[org]/assets/maintenance">) {
  const ctx = await requireNode("assets.maintenance", await params);
  const query = readQuery(await searchParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  // Assets are the org's: due dates and the calendar follow its calendar, not UTC's (A71).
  const today = await orgToday(ctx);
  const [entriesResult, unitsResult] = await Promise.all([
    listAssetMaintenance(db, ctx.org.id),
    listAssetUnits(db, ctx.org.id),
  ]);
  const entries = must(entriesResult, "maintenance");
  const units = must(unitsResult, "asset units");
  const unitState = new Map(units.map((u) => [u.id, u.state]));
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const cost = (minor: number | null, currency: string | null) => {
    const major = majorUnits(minor, currency);
    return major === null || currency === null
      ? t("assets.common.costUnknown")
      : format.number(major, { style: "currency", currency });
  };
  const visible = entries.filter((m) => matches(query.q, m.assetTag, m.description));
  const rows: CollectionRow[] = visible.map((m) => {
    const state = unitState.get(m.unitId);
    return {
      key: m.id,
      peek: m.id,
      recordKey: m.assetTag,
      title: m.description,
      meta: `${day(m.performedOn)} · ${cost(m.costMinor, m.currencyCode)}`,
      ...(state
        ? {
            tone: ASSET_STATE_TONE[state],
            stateLabel: t(`assets.states.${assetStateKey(state)}`),
            group: state,
          }
        : {}),
      date: m.performedOn,
      cells: {
        performedOn: day(m.performedOn),
        assetTag: m.assetTag,
        description: m.description,
        cost: cost(m.costMinor, m.currencyCode),
      },
    };
  });
  const { view, views } = pageViews("assets.maintenance", query.view, t);
  const selected = query.peek ? entries.find((m) => m.id === query.peek) : undefined;
  const unitOptions = units.map((u) => ({ value: u.id, label: `${u.assetTag} · ${u.className}` }));

  return (
    <AssetsCollection
      title={t("nav.atlas.pages.assets.maintenance")}
      view={view}
      views={views}
      total={entries.length}
      rows={rows}
      month={monthOf(today)}
      today={today}
      boardColumns={ASSET_STATES.map((s) => ({
        value: s,
        label: t(`assets.states.${assetStateKey(s)}`),
        tone: ASSET_STATE_TONE[s],
      }))}
      columns={[
        { key: "performedOn", label: t("assets.fields.performedOn") },
        { key: "assetTag", label: t("assets.fields.assetTag"), type: "code" },
        { key: "description", label: t("assets.fields.description"), wrap: true },
        { key: "cost", label: t("assets.fields.costColumn") },
      ]}
      create={
        can.maintenance && units.length > 0
          ? {
              label: t("assets.maintenance.create.open"),
              dialog: (
                <MaintenanceForm
                  org={ctx.org.slug}
                  units={unitOptions}
                  currency={DEFAULT_CURRENCY}
                  today={today}
                />
              ),
            }
          : null
      }
      empty={
        units.length === 0
          ? {
              sentence: t("assets.maintenance.emptyNoUnits"),
              actionLabel: t("assets.maintenance.emptyNoUnitsAction"),
              href: `/${ctx.org.slug}/assets/units`,
            }
          : can.maintenance
            ? {
                sentence: t("assets.maintenance.empty"),
                actionLabel: t("assets.maintenance.create.open"),
              }
            : {
                sentence: t("assets.maintenance.emptyReadOnly"),
                actionLabel: t("assets.maintenance.emptyNoUnitsAction"),
                href: `/${ctx.org.slug}/assets/units`,
              }
      }
      peek={
        query.peek
          ? {
              title: selected ? selected.assetTag : t("nav.atlas.pages.assets.maintenance"),
              content: selected ? (
                <div className="flex flex-col gap-16">
                  <PropertyList
                    items={[
                      { label: t("assets.fields.assetTag"), value: selected.assetTag },
                      { label: t("assets.fields.performedOn"), value: day(selected.performedOn) },
                      { label: t("assets.fields.description"), value: selected.description },
                      {
                        label: t("assets.fields.costColumn"),
                        value: (
                          <Money
                            amount={majorUnits(selected.costMinor, selected.currencyCode)}
                            {...(selected.currencyCode ? { currency: selected.currencyCode } : {})}
                            unpricedLabel={t("assets.common.costUnknown")}
                          />
                        ),
                      },
                    ]}
                  />
                  <Link
                    href={
                      `/${ctx.org.slug}/assets/units?peek=${encodeURIComponent(selected.assetTag)}` as Route
                    }
                    className="text-text-14 text-accent-text underline"
                  >
                    {t("assets.custody.openUnit", { tag: selected.assetTag })}
                  </Link>
                  <AssetCollab
                    db={db}
                    org={ctx.org.slug}
                    table="app.asset_maintenance"
                    id={selected.id}
                    me={ctx.viewer.person?.id ?? null}
                  />
                </div>
              ) : (
                <p className="m-0 text-text-14 text-text-secondary">
                  {t("assets.maintenance.notFound")}
                </p>
              ),
            }
          : null
      }
    />
  );
}
