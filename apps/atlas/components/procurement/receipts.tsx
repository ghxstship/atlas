import {
  listGoodsReceipts,
  listPoLines,
  listPurchaseOrders,
  type GoodsReceipt,
} from "@xos/data/procurement";
import { getFormatter } from "next-intl/server";
import { recordReceiptAction } from "@/app/[org]/procurement/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import {
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { ReceiptForm } from "./forms";

const VIEWS: readonly ViewKind[] = ["table", "list"];

function matchState(r: GoodsReceipt, t: Copy): KitState {
  return r.matched
    ? { state: "complete", label: t("receipts.matched") }
    : { state: "ready", label: t("receipts.unmatched") };
}

/**
 * Procurement > Receipts (journey 5): goods received against approved or sent purchase orders.
 * Cumulative receipts never exceed the quantity ordered (the database refuses a duplicate or excess
 * receipt); the receiver comes from the session. Compass records receipts by scan through the same
 * tables.
 */
export async function ReceiptsSection({
  ctx,
  path,
  search,
  projectId,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  projectId?: string;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, all, orders] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listGoodsReceipts(db, ctx.org.id),
    listPurchaseOrders(db, ctx.org.id),
  ]);
  const title = t("receipts.title");
  if (!all.ok || !orders.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("receipts.what")} />
      </>
    );
  }
  const projectOrders = new Set(
    orders.data.filter((o) => !projectId || o.projectId === projectId).map((o) => o.id),
  );
  const receipts = all.data.filter((r) => projectOrders.has(r.purchaseOrderId));
  const canWrite = ctx.capabilities.has("procurement.receipt.write");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? receipts.find((r) => r.id === state.peek) : undefined;
  const properties = (r: GoodsReceipt) => [
    { label: t("receipts.order"), value: r.purchaseOrderKey },
    { label: t("fields.vendor"), value: r.vendorName ?? t("fields.unnamedVendor") },
    { label: t("receipts.receivedAt"), value: when(r.receivedAt) },
    { label: t("receipts.receivedBy"), value: r.receiverName ?? t("fields.someone") },
    { label: t("receipts.note"), value: r.note ?? t("receipts.noNote") },
  ];
  const lineTable = async (r: GoodsReceipt) => {
    const lines = await listPoLines(db, r.purchaseOrderId);
    if (!lines.ok) return <ErrorPanel what={t("receipts.what")} />;
    const byId = new Map(lines.data.map((l) => [l.id, l]));
    return (
      <DataTable
        caption={t("receipts.lines")}
        columns={[
          { key: "line", label: t("lines.descriptionLabel"), wrap: true },
          { key: "received", label: t("lines.received"), type: "number" },
          { key: "ordered", label: t("lines.quantity"), type: "number" },
        ]}
        rows={r.lines.map((l) => ({
          line: byId.get(l.poLineId)?.description ?? t("receipts.unknownLine"),
          received: l.quantityReceived,
          ordered: byId.get(l.poLineId)?.quantity ?? null,
        }))}
      />
    );
  };

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("receipts.back")}
        recordKey={selected.purchaseOrderKey}
        title={t("receipts.recordTitle", { when: when(selected.receivedAt) })}
        state={matchState(selected, t)}
        properties={properties(selected)}
      >
        <KitSection id="receipt-lines" title={t("receipts.lines")}>
          {await lineTable(selected)}
        </KitSection>
        <CollabPanels ctx={ctx} table="app.goods_receipts" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = receipts.map((r) => ({
    id: r.id,
    key: r.purchaseOrderKey,
    title: r.vendorName ?? t("fields.unnamedVendor"),
    state: matchState(r, t),
    meta: when(r.receivedAt),
    cells: {
      order: r.purchaseOrderKey,
      vendor: r.vendorName,
      received: when(r.receivedAt),
      by: r.receiverName,
      lines: r.lines.length,
      matched: matchState(r, t),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    const orderParam = typeof search["order"] === "string" ? search["order"] : "";
    const receivable = orders.data.filter(
      (o) => (o.state === "Approved" || o.state === "Sent") && projectOrders.has(o.id),
    );
    const chosen = receivable.find((o) => o.id === orderParam);
    let body;
    if (!chosen) {
      body =
        receivable.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("receipts.noReceivable")}</p>
        ) : (
          <form method="get" action={path} className="flex flex-col gap-12">
            <input type="hidden" name="create" value="1" />
            <label htmlFor="receipt-order" className="text-label-13 font-medium">
              {t("receipts.chooseOrder")}
            </label>
            <select
              id="receipt-order"
              name="order"
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
              defaultValue=""
            >
              <option value="" disabled>
                {t("receipts.chooseOrderHint")}
              </option>
              {receivable.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.key} · {o.vendorName ?? t("fields.unnamedVendor")}
                </option>
              ))}
            </select>
            <div>
              <button
                type="submit"
                className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
              >
                {t("receipts.continue")}
              </button>
            </div>
          </form>
        );
    } else {
      const lines = await listPoLines(db, chosen.id);
      body = !lines.ok ? (
        <ErrorPanel what={t("receipts.what")} />
      ) : (
        <ReceiptForm
          org={ctx.org.slug}
          purchaseOrderId={chosen.id}
          action={recordReceiptAction}
          successHref={withQuery(path, state, { peek: "{id}" })}
          lines={lines.data.map((l) => ({
            id: l.id,
            label: `${l.lineNumber}. ${l.description}`,
            ordered: l.quantity,
            received: l.receivedQuantity,
          }))}
        />
      );
    }
    drawer = (
      <FormDrawer
        title={chosen ? t("receipts.createFor", { order: chosen.key }) : t("receipts.create")}
        closeHref={withQuery(path, state)}
      >
        {body}
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.purchaseOrderKey}
        title={t("receipts.recordTitle", { when: when(selected.receivedAt) })}
        state={matchState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
      >
        {await lineTable(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "order", label: t("receipts.order"), type: "code" },
        { key: "vendor", label: t("fields.vendor") },
        { key: "received", label: t("receipts.receivedAt") },
        { key: "by", label: t("receipts.receivedBy") },
        { key: "lines", label: t("receipts.lineCount"), type: "number" },
        { key: "matched", label: t("receipts.matchLabel"), type: "state" },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("receipts.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "receipts")}
    >
      {drawer}
    </CollectionView>
  );
}
