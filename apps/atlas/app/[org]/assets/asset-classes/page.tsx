import { listAssetClasses, listAssetLots, listAssetUnits } from "@xos/data/assets";
import Link from "next/link";
import type { Route } from "next";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { AssetCollab } from "@/components/assets/collab";
import { ClassActions } from "@/components/assets/class-actions";
import { NewClassForm } from "@/components/assets/forms";
import { PropertyList } from "@/components/assets/ui";
import { requireNode } from "@/lib/shell/require-node";
import { assetCapabilities, must } from "@/lib/assets/context";
import { pageViews } from "@/lib/assets/page";
import { matches, readQuery } from "@/lib/assets/views";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Assets > Catalog of asset classes (Section 4.5.5): what kinds of gear the org owns, each bound to
 * its canon element (Section 3.9 class grain), with live unit and lot counts. `?peek=<class id>`
 * opens a class with its units, lots, comments and attachments.
 */
export default async function AssetClassesPage({
  params,
  searchParams,
}: PageProps<"/[org]/assets/asset-classes">) {
  const ctx = await requireNode("assets.asset-classes", await params);
  const query = readQuery(await searchParams);
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  const classes = must(await listAssetClasses(db, ctx.org.id), "asset classes");
  const visible = classes.filter((c) =>
    matches(query.q, c.name, c.elementId, c.elementItem, c.urid),
  );
  const rows: CollectionRow[] = visible.map((c) => ({
    key: c.id,
    peek: c.id,
    title: c.name,
    meta: t("assets.classes.counts", { units: c.unitCount, lots: c.lotCount }),
    stateLabel: c.urid ?? c.elementId,
    cells: {
      name: c.name,
      elementId: c.elementId,
      element: c.elementItem,
      units: c.unitCount,
      lots: c.lotCount,
    },
  }));
  const { view, views } = pageViews("assets.asset-classes", query.view, t);
  const selected = query.peek ? classes.find((c) => c.id === query.peek) : undefined;

  let peek = null;
  if (query.peek) {
    if (!selected) {
      peek = {
        title: t("nav.atlas.pages.assets.assetClasses"),
        content: (
          <p className="m-0 text-text-14 text-text-secondary">{t("assets.classes.notFound")}</p>
        ),
      };
    } else {
      const [units, lots] = await Promise.all([
        listAssetUnits(db, ctx.org.id, { classId: selected.id }),
        listAssetLots(db, ctx.org.id, { classId: selected.id }),
      ]);
      const unitRows = must(units, "asset units");
      const lotRows = must(lots, "asset lots");
      peek = {
        title: selected.name,
        content: (
          <div className="flex flex-col gap-16">
            {can.write ? (
              <ClassActions
                org={ctx.org.slug}
                classId={selected.id}
                name={selected.name}
                empty={selected.unitCount === 0 && selected.lotCount === 0}
              />
            ) : null}
            <PropertyList
              items={[
                { label: t("assets.fields.elementId"), value: selected.elementId },
                {
                  label: t("assets.fields.element"),
                  value: selected.elementItem ?? t("assets.common.notRecorded"),
                },
                {
                  label: t("assets.fields.urid"),
                  value: selected.urid ?? t("assets.common.notRecorded"),
                },
              ]}
            />
            <section className="flex flex-col gap-8">
              <h3 className="m-0 text-heading-14 font-semibold">{t("assets.classes.units")}</h3>
              {unitRows.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("assets.classes.noUnits")}
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {unitRows.map((u) => (
                    <li key={u.id}>
                      <Link
                        href={
                          `/${ctx.org.slug}/assets/units?peek=${encodeURIComponent(u.assetTag)}` as Route
                        }
                        className="font-mono text-text-13 text-accent-text underline"
                      >
                        {u.assetTag}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-8">
              <h3 className="m-0 text-heading-14 font-semibold">{t("assets.classes.lots")}</h3>
              {lotRows.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("assets.classes.noLots")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {lotRows.map((l) => (
                    <li key={l.id} className="text-text-13">
                      {t("assets.classes.lotLine", { venue: l.venueName, onHand: l.onHand })}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <AssetCollab
              db={db}
              org={ctx.org.slug}
              table="app.asset_classes"
              id={selected.id}
              me={ctx.viewer.person?.id ?? null}
            />
          </div>
        ),
      };
    }
  }

  return (
    <AssetsCollection
      title={t("nav.atlas.pages.assets.assetClasses")}
      view={view}
      views={views}
      total={classes.length}
      rows={rows}
      columns={[
        { key: "name", label: t("assets.fields.name") },
        { key: "elementId", label: t("assets.fields.elementId"), type: "code" },
        { key: "element", label: t("assets.fields.element") },
        { key: "units", label: t("assets.fields.units"), type: "number" },
        { key: "lots", label: t("assets.fields.lots"), type: "number" },
      ]}
      create={
        can.write
          ? { label: t("assets.classes.create.open"), dialog: <NewClassForm org={ctx.org.slug} /> }
          : null
      }
      empty={
        can.write
          ? { sentence: t("assets.classes.empty"), actionLabel: t("assets.classes.create.open") }
          : {
              sentence: t("assets.classes.emptyReadOnly"),
              actionLabel: t("assets.classes.emptyReadOnlyAction"),
              href: `/${ctx.org.slug}/canon/elements`,
            }
      }
      peek={peek}
    />
  );
}
