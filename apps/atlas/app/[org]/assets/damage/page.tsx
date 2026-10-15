import { ASSET_STATES, assetStateKey, listAssetDamage, listAssetUnits } from "@xos/data/assets";
import { getFormatter } from "next-intl/server";
import Link from "next/link";
import type { Route } from "next";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { AssetCollab } from "@/components/assets/collab";
import { DamageForm } from "@/components/assets/forms";
import { PropertyList } from "@/components/assets/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { assetCapabilities, loadPickers, must } from "@/lib/assets/context";
import { pageViews } from "@/lib/assets/page";
import { ASSET_STATE_TONE, matches, readQuery } from "@/lib/assets/views";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Assets > Damage (Section 4.5.5): damage reports against units, newest first, with the project
 * during which it happened. The board groups reports by the unit's state, so damaged gear waiting
 * for repair or write-off stands out; writing off (Retired) needs assets.write_off.approve.
 */
export default async function DamagePage({
  params,
  searchParams,
}: PageProps<"/[org]/assets/damage">) {
  const ctx = await requireNode("assets.damage", await params);
  const query = readQuery(await searchParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  const [damageResult, unitsResult, pickers] = await Promise.all([
    listAssetDamage(db, ctx.org.id),
    listAssetUnits(db, ctx.org.id),
    loadPickers(ctx, t("assets.common.unnamed")),
  ]);
  const reports = must(damageResult, "damage reports");
  const units = must(unitsResult, "asset units");
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const visible = reports.filter((d) => matches(query.q, d.assetTag, d.description, d.projectKey));
  const rows: CollectionRow[] = visible.map((d) => ({
    key: d.id,
    peek: d.id,
    title: `${d.assetTag} · ${d.description}`,
    meta: [when(d.reportedAt), d.projectKey].filter(Boolean).join(" · "),
    ...(d.unitState
      ? {
          tone: ASSET_STATE_TONE[d.unitState],
          stateLabel: t(`assets.states.${assetStateKey(d.unitState)}`),
          group: d.unitState,
        }
      : {}),
    cells: {
      reportedAt: when(d.reportedAt),
      assetTag: d.assetTag,
      description: d.description,
      project: d.projectKey,
      state: d.unitState
        ? {
            state: ASSET_STATE_TONE[d.unitState],
            label: t(`assets.states.${assetStateKey(d.unitState)}`),
          }
        : null,
    },
  }));
  const { view, views } = pageViews("assets.damage", query.view, t);
  const selected = query.peek ? reports.find((d) => d.id === query.peek) : undefined;
  const unitOptions = units.map((u) => ({ value: u.id, label: `${u.assetTag} · ${u.className}` }));

  return (
    <AssetsCollection
      title={t("nav.atlas.pages.assets.damage")}
      view={view}
      views={views}
      total={reports.length}
      rows={rows}
      boardColumns={ASSET_STATES.map((s) => ({
        value: s,
        label: t(`assets.states.${assetStateKey(s)}`),
        tone: ASSET_STATE_TONE[s],
      }))}
      columns={[
        { key: "reportedAt", label: t("assets.fields.reportedAt") },
        { key: "assetTag", label: t("assets.fields.assetTag"), type: "code" },
        { key: "description", label: t("assets.fields.description"), wrap: true },
        { key: "project", label: t("assets.fields.projectId"), type: "code" },
        { key: "state", label: t("assets.fields.state"), type: "state" },
      ]}
      create={
        can.damage && units.length > 0
          ? {
              label: t("assets.damage.create.open"),
              dialog: (
                <DamageForm org={ctx.org.slug} units={unitOptions} projects={pickers.projects} />
              ),
            }
          : null
      }
      empty={
        units.length === 0
          ? {
              sentence: t("assets.damage.emptyNoUnits"),
              actionLabel: t("assets.maintenance.emptyNoUnitsAction"),
              href: `/${ctx.org.slug}/assets/units`,
            }
          : can.damage
            ? { sentence: t("assets.damage.empty"), actionLabel: t("assets.damage.create.open") }
            : {
                sentence: t("assets.damage.emptyReadOnly"),
                actionLabel: t("assets.maintenance.emptyNoUnitsAction"),
                href: `/${ctx.org.slug}/assets/units`,
              }
      }
      peek={
        query.peek
          ? {
              title: selected ? selected.assetTag : t("nav.atlas.pages.assets.damage"),
              content: selected ? (
                <div className="flex flex-col gap-16">
                  <PropertyList
                    items={[
                      { label: t("assets.fields.assetTag"), value: selected.assetTag },
                      { label: t("assets.fields.reportedAt"), value: when(selected.reportedAt) },
                      { label: t("assets.fields.description"), value: selected.description },
                      {
                        label: t("assets.fields.projectId"),
                        value: selected.projectKey ?? t("assets.common.noProject"),
                      },
                      {
                        label: t("assets.fields.state"),
                        value: selected.unitState
                          ? t(`assets.states.${assetStateKey(selected.unitState)}`)
                          : t("assets.common.notRecorded"),
                      },
                    ]}
                  />
                  <Link
                    href={
                      `/${ctx.org.slug}/assets/units?peek=${encodeURIComponent(selected.assetTag)}` as Route
                    }
                    className="text-text-14 text-accent-text underline"
                  >
                    {t("assets.damage.openUnit", { tag: selected.assetTag })}
                  </Link>
                  <AssetCollab
                    db={db}
                    org={ctx.org.slug}
                    table="app.asset_damage"
                    id={selected.id}
                    me={ctx.viewer.person?.id ?? null}
                  />
                </div>
              ) : (
                <p className="m-0 text-text-14 text-text-secondary">
                  {t("assets.damage.notFound")}
                </p>
              ),
            }
          : null
      }
    />
  );
}
