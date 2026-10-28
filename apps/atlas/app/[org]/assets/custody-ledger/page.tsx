import { listAssetCustody } from "@xos/data/assets";
import { getFormatter } from "next-intl/server";
import Link from "next/link";
import type { Route } from "next";
import { AssetsCollection, type CollectionRow } from "@/components/assets/collection";
import { CustodyDesk } from "@/components/assets/custody";
import { PropertyList } from "@/components/assets/ui";
import { requireNode } from "@/lib/shell/require-node";
import { assetCapabilities, loadPickers, must } from "@/lib/assets/context";
import { pageViews } from "@/lib/assets/page";
import { matches, readQuery } from "@/lib/assets/views";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Assets > Custody ledger (Section 4.5.5): the append-only record of who or where held each unit,
 * newest first, with the custody desk on top: scan or type a code, see what it names, and check it
 * out, in or across through app.apply_asset_scan, the RPC Compass uses (journey 19).
 */
export default async function CustodyLedgerPage({
  params,
  searchParams,
}: PageProps<"/[org]/assets/custody-ledger">) {
  const ctx = await requireNode("assets.custody-ledger", await params);
  const query = readQuery(await searchParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const can = assetCapabilities(ctx);
  const [ledgerResult, pickers] = await Promise.all([
    listAssetCustody(ctx.viewer.db, ctx.org.id, { limit: 500 }),
    loadPickers(ctx, t("assets.common.unnamed")),
  ]);
  const ledger = must(ledgerResult, "custody ledger");
  const holder = (e: (typeof ledger)[number]) =>
    e.custodianName ?? e.venueName ?? t("assets.common.notRecorded");
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const visible = ledger.filter((e) =>
    matches(query.q, e.assetTag, e.className, holder(e), e.projectKey, e.note),
  );
  const rows: CollectionRow[] = visible.map((e) => ({
    key: e.custodyId,
    peek: e.custodyId,
    recordKey: e.assetTag,
    title: t("assets.custody.line", { tag: e.assetTag, holder: holder(e) }),
    meta: [when(e.since), e.projectKey, e.note].filter(Boolean).join(" · "),
    cells: {
      at: when(e.since),
      assetTag: e.assetTag,
      className: e.className,
      holder: holder(e),
      project: e.projectKey,
      note: e.note,
    },
  }));
  const { view, views } = pageViews("assets.custody-ledger", query.view, t);
  const selected = query.peek ? ledger.find((e) => e.custodyId === query.peek) : undefined;

  return (
    <AssetsCollection
      title={t("nav.atlas.pages.assets.custodyLedger")}
      view={view}
      views={views}
      total={ledger.length}
      rows={rows}
      before={
        <CustodyDesk
          org={ctx.org.slug}
          pickers={{
            members: pickers.members,
            engagements: pickers.engagements,
            projects: pickers.projects,
            venues: pickers.venues,
          }}
          canMove={can.custody}
        />
      }
      columns={[
        { key: "at", label: t("assets.fields.at") },
        { key: "assetTag", label: t("assets.fields.assetTag"), type: "code" },
        { key: "className", label: t("assets.fields.classId") },
        { key: "holder", label: t("assets.fields.custodian") },
        { key: "project", label: t("assets.fields.projectId"), type: "code" },
        { key: "note", label: t("assets.fields.note"), wrap: true },
      ]}
      empty={{
        sentence: t(can.custody ? "assets.custody.empty" : "assets.custody.emptyReadOnly"),
        actionLabel: t("assets.custody.emptyAction"),
        href: `/${ctx.org.slug}/assets/units`,
      }}
      peek={
        query.peek
          ? {
              title: selected ? selected.assetTag : t("nav.atlas.pages.assets.custodyLedger"),
              content: selected ? (
                <div className="flex flex-col gap-16">
                  <PropertyList
                    items={[
                      { label: t("assets.fields.assetTag"), value: selected.assetTag },
                      { label: t("assets.fields.classId"), value: selected.className },
                      { label: t("assets.fields.custodian"), value: holder(selected) },
                      {
                        label: t("assets.fields.projectId"),
                        value: selected.projectKey ?? t("assets.common.noProject"),
                      },
                      { label: t("assets.fields.at"), value: when(selected.since) },
                      {
                        label: t("assets.fields.note"),
                        value: selected.note ?? t("assets.common.notRecorded"),
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
                </div>
              ) : (
                <p className="m-0 text-text-14 text-text-secondary">
                  {t("assets.custody.notFound")}
                </p>
              ),
            }
          : null
      }
    />
  );
}
