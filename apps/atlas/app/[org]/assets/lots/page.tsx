import {
  listAssetClasses,
  listAssetLotMovements,
  listAssetLots,
  lotScanCode,
} from "@xos/data/assets";
import { getFormatter } from "next-intl/server";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { AssetCollab } from "@/components/assets/collab";
import { NewLotForm } from "@/components/assets/forms";
import { LotActions } from "@/components/assets/lot-actions";
import { PropertyList } from "@/components/assets/ui";
import { requireNode } from "@/lib/shell/require-node";
import { assetCapabilities, custodianName, loadPickers, must } from "@/lib/assets/context";
import { pageViews } from "@/lib/assets/page";
import { matches, readQuery } from "@/lib/assets/views";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Assets > Lots (Section 4.5.5): quantities of a class at a place (Section 3.9 lot grain). The
 * quantity on hand is the opening count plus the lot ledger (migration 0450); recounts and
 * check-outs are ledger rows, never edits. `?peek=<lot id>` opens a lot with its ledger.
 */
export default async function LotsPage({ params, searchParams }: PageProps<"/[org]/assets/lots">) {
  const ctx = await requireNode("assets.lots", await params);
  const query = readQuery(await searchParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  const [lotsResult, classesResult, pickers] = await Promise.all([
    listAssetLots(db, ctx.org.id),
    listAssetClasses(db, ctx.org.id),
    loadPickers(ctx, t("assets.common.unnamed")),
  ]);
  const lots = must(lotsResult, "asset lots");
  const classes = must(classesResult, "asset classes");
  const visible = lots.filter((l) => matches(query.q, l.className, l.venueName));
  const rows: CollectionRow[] = visible.map((l) => ({
    key: l.id,
    peek: l.id,
    title: l.className,
    meta: t("assets.lots.line", { venue: l.venueName, onHand: l.onHand }),
    cells: {
      className: l.className,
      venue: l.venueName,
      onHand: l.onHand,
      opening: l.openingQuantity,
    },
  }));
  const { view, views } = pageViews("assets.lots", query.view, t);
  const selected = query.peek ? lots.find((l) => l.id === query.peek) : undefined;

  let peek = null;
  if (query.peek) {
    if (!selected) {
      peek = {
        title: t("nav.atlas.pages.assets.lots"),
        content: (
          <p className="m-0 text-text-14 text-text-secondary">{t("assets.lots.notFound")}</p>
        ),
      };
    } else {
      const movements = must(await listAssetLotMovements(db, selected.id), "lot ledger");
      peek = {
        title: `${selected.className} · ${selected.venueName}`,
        content: (
          <div className="flex flex-col gap-16">
            <LotActions
              org={ctx.org.slug}
              lotId={selected.id}
              code={lotScanCode(selected.id)}
              label={`${selected.className} · ${selected.venueName}`}
              onHand={selected.onHand}
              pickers={{
                members: pickers.members,
                engagements: pickers.engagements,
                projects: pickers.projects,
                venues: pickers.venues,
              }}
              canCount={can.write}
              canMove={can.custody}
            />
            <PropertyList
              items={[
                { label: t("assets.fields.onHand"), value: String(selected.onHand) },
                { label: t("assets.fields.opening"), value: String(selected.openingQuantity) },
                { label: t("assets.fields.venueId"), value: selected.venueName },
                {
                  label: t("assets.fields.lotCode"),
                  value: <span className="font-mono text-text-12">{lotScanCode(selected.id)}</span>,
                },
              ]}
            />
            <section className="flex flex-col gap-8">
              <h3 className="m-0 text-heading-14 font-semibold">{t("assets.lots.ledger")}</h3>
              {movements.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("assets.lots.noMovements")}
                </p>
              ) : (
                <ol className="m-0 flex list-none flex-col gap-8 p-0">
                  {movements.map((m) => (
                    <li key={m.id} className="flex flex-col gap-2 text-text-13">
                      <span className="font-medium">
                        {t(`assets.lots.kinds.${m.kind.replace(" ", "")}`, {
                          delta: Math.abs(m.delta),
                          custodian: custodianName(pickers, m) ?? t("assets.common.notRecorded"),
                        })}
                        {m.projectKey ? ` · ${m.projectKey}` : ""}
                      </span>
                      <span className="text-text-12 text-text-secondary">
                        {format.dateTime(new Date(m.at), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {m.note ? ` · ${m.note}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <AssetCollab
              db={db}
              org={ctx.org.slug}
              table="app.asset_lots"
              id={selected.id}
              me={ctx.viewer.person?.id ?? null}
            />
          </div>
        ),
      };
    }
  }

  const canCreate = can.write && classes.length > 0 && pickers.venues.length > 0;
  return (
    <AssetsCollection
      title={t("nav.atlas.pages.assets.lots")}
      view={view}
      views={views}
      total={lots.length}
      rows={rows}
      columns={[
        { key: "className", label: t("assets.fields.classId") },
        { key: "venue", label: t("assets.fields.venueId") },
        { key: "onHand", label: t("assets.fields.onHand"), type: "number" },
        { key: "opening", label: t("assets.fields.opening"), type: "number" },
      ]}
      create={
        canCreate
          ? {
              label: t("assets.lots.create.open"),
              dialog: (
                <NewLotForm
                  org={ctx.org.slug}
                  classes={classes.map((c) => ({ value: c.id, label: c.name }))}
                  venues={pickers.venues}
                />
              ),
            }
          : null
      }
      empty={
        classes.length === 0
          ? {
              sentence: t("assets.lots.emptyNoClasses"),
              actionLabel: t("assets.units.emptyNoClassesAction"),
              href: `/${ctx.org.slug}/assets/asset-classes`,
            }
          : pickers.venues.length === 0
            ? {
                sentence: t("assets.lots.emptyNoVenues"),
                actionLabel: t("assets.lots.emptyNoVenuesAction"),
                href: `/${ctx.org.slug}/places/venues`,
              }
            : can.write
              ? { sentence: t("assets.lots.empty"), actionLabel: t("assets.lots.create.open") }
              : {
                  sentence: t("assets.lots.emptyReadOnly"),
                  actionLabel: t("assets.units.emptyReadOnlyAction"),
                  href: `/${ctx.org.slug}/assets/custody-ledger`,
                }
      }
      peek={peek}
    />
  );
}
