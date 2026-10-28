import { nextStates } from "@xos/data/commercial-common";
import {
  getPoAcknowledgment,
  getPurchaseOrderTotals,
  listCurrencies,
  listGoodsReceipts,
  listPoChangeOrders,
  listPoLines,
  listProjectOptions,
  listPurchaseOrders,
  listSubmittals,
  type PoState,
  type PurchaseOrder,
} from "@xos/data/procurement";
import { listTransitionRules, listVendors } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  addPoLineAction,
  approvePoAction,
  createChangeOrderAction,
  createPoAction,
  decideChangeOrderAction,
  priceChangeOrderAction,
  removePoLineAction,
  transitionPoAction,
} from "@/app/[org]/procurement/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { customFieldList } from "@/lib/custom-fields/server";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import { StateHistory } from "@/components/collection-kit/history";
import { PresenceFor } from "@/components/presence/presence-for";
import {
  ActionButton,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
} from "@/components/collection-kit/kit";
import { recordStateOf, type KitRow, type ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  collectionState,
  formatMinor,
  withQuery,
  type SearchParams,
} from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { DocumentActions } from "@/components/documents/document-actions";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "procurement.refusals";
const STATES: readonly PoState[] = ["Proposed", "Approved", "Sent", "Closed", "Canceled"];

/**
 * Procurement > Purchase orders (journeys 4, 5 and 30): orders with NULL-aware totals, lines that
 * change only while Proposed, approval under spend authority by someone other than the creator,
 * sending, the vendor's acknowledgment from Gateway, change orders, receipts and submittals.
 */
export async function PurchaseOrdersSection({
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
  const [t, format, all, projects, vendors, rules, currencies, custom] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listPurchaseOrders(db, ctx.org.id),
    listProjectOptions(db, ctx.org.id),
    listVendors(db, ctx.org.id),
    listTransitionRules<PoState>(db, "purchase_order"),
    listCurrencies(db),
    customFieldList(ctx, "app.purchase_orders", search),
  ]);
  const title = t("orders.title");
  if (!all.ok || !projects.ok || !vendors.ok || !rules.ok || !currencies.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("orders.what")} />
      </>
    );
  }
  const orders = projectId ? all.data.filter((o) => o.projectId === projectId) : all.data;
  const canWrite = ctx.capabilities.has("procurement.po.write");
  const exponent = new Map(currencies.data.map((c) => [c.code, c.minorUnits]));
  const stateLabel = (s: string) => t(`poStates.${s}`);
  const money = (minor: number | null, currency: string) =>
    formatMinor(format, minor, currency, exponent.get(currency) ?? 2, t("money.unpricedTotal"));
  const moves = (o: PurchaseOrder) =>
    nextStates(rules.data, o.state)
      .filter((next) => next !== "Approved")
      .filter((next) =>
        ctx.capabilities.has(next === "Sent" ? "procurement.po.send" : "procurement.po.write"),
      )
      .map((next) => ({ next, label: t(`poMoves.${next}`), danger: next === "Canceled" }));
  const approve = (o: PurchaseOrder) =>
    o.state === "Proposed" && ctx.capabilities.has("finance.po.approve") ? (
      <ActionButton
        action={approvePoAction}
        hidden={{ org: ctx.org.slug, id: o.id }}
        label={t("orders.approve")}
        variant="primary"
        reason={t("orders.approveReason")}
        refusals={REFUSALS}
      />
    ) : null;
  const controls = (o: PurchaseOrder) => (
    <>
      {approve(o)}
      <TransitionButtons
        action={transitionPoAction}
        org={ctx.org.slug}
        id={o.id}
        expected={o.state}
        refusals={REFUSALS}
        moves={moves(o)}
      />
    </>
  );
  const selected = state.peek ? orders.find((o) => o.id === state.peek) : undefined;
  const properties = (o: (typeof orders)[number]) => [
    { label: t("fields.vendor"), value: o.vendorName ?? t("fields.unnamedVendor") },
    { label: t("fields.project"), value: o.projectKey ?? t("fields.hiddenProject") },
    { label: t("fields.currency"), value: o.currencyCode },
    { label: t("orders.total"), value: money(o.totals.linesTotalMinor, o.currencyCode) },
    { label: t("orders.unpricedLines"), value: String(o.totals.unpricedCount) },
    {
      label: t("orders.approvedChanges"),
      value:
        o.totals.approvedChangesMinor === null
          ? t("orders.noChanges")
          : money(o.totals.approvedChangesMinor, o.currencyCode),
    },
  ];

  if (selected && state.full) {
    return (
      <PurchaseOrderRecord
        ctx={ctx}
        order={selected}
        t={t}
        backHref={withQuery(path, state)}
        properties={properties(selected)}
        controls={controls(selected)}
        stateLabel={stateLabel}
        money={money}
        canWrite={canWrite}
      />
    );
  }

  const listed = orders.filter((o) => custom.keep(o.id));
  const rows: KitRow[] = listed.map((o) => ({
    id: o.id,
    key: o.key,
    title: o.vendorName ?? t("fields.unnamedVendor"),
    state: { state: recordStateOf(o.state), label: stateLabel(o.state) },
    boardValue: o.state,
    meta: money(o.totals.linesTotalMinor, o.currencyCode),
    cells: {
      key: o.key,
      vendor: o.vendorName,
      project: o.projectKey,
      state: { state: recordStateOf(o.state), label: stateLabel(o.state) },
      total: money(o.totals.linesTotalMinor, o.currencyCode),
      unpriced: o.totals.unpricedCount,
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("orders.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="po-create"
          action={createPoAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("orders.create")}
          successHref={withQuery(path, state, { peek: "{id}", full: "1" })}
          customFields="app.purchase_orders"
          fields={[
            {
              kind: "select",
              name: "projectId",
              label: t("fields.project"),
              blankLabel: t("fields.chooseProject"),
              defaultValue: projectId ?? "",
              options: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
            {
              kind: "select",
              name: "vendorId",
              label: t("fields.vendor"),
              blankLabel: t("fields.chooseVendor"),
              help: t("orders.vendorHelp"),
              defaultValue: "",
              options: vendors.data
                .filter((v) => v.state !== "Blocked" && v.state !== "Canceled")
                .map((v) => ({ value: v.id, label: v.name ?? t("fields.unnamedVendor") })),
            },
            {
              kind: "select",
              name: "currencyCode",
              label: t("fields.currency"),
              defaultValue: "USD",
              options: currencies.data.map((c) => ({ value: c.code, label: c.code })),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.key}
        title={selected.vendorName ?? t("fields.unnamedVendor")}
        state={{ state: recordStateOf(selected.state), label: stateLabel(selected.state) }}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        <CustomFieldsPanel org={ctx.org.slug} table="app.purchase_orders" id={selected.id} />
        <PresenceFor table="purchase_orders" id={selected.id} />
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "key", label: t("fields.key"), type: "code" },
        { key: "vendor", label: t("fields.vendor") },
        { key: "project", label: t("fields.project"), type: "code" },
        { key: "state", label: t("fields.state"), type: "state" },
        { key: "total", label: t("orders.total") },
        { key: "unpriced", label: t("orders.unpricedLines"), type: "number" },
      ]}
      rows={rows}
      customFields={await custom.view(rows.map((r) => r.id))}
      board={STATES.map((s) => ({ value: s, state: recordStateOf(s), label: stateLabel(s) }))}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("orders.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "orders")}
    >
      {drawer}
    </CollectionView>
  );
}

async function PurchaseOrderRecord({
  ctx,
  order,
  t,
  backHref,
  properties,
  controls,
  stateLabel,
  money,
  canWrite,
}: {
  ctx: OrgContext;
  order: PurchaseOrder;
  t: Copy;
  backHref: string;
  properties: { label: string; value: string }[];
  controls: React.ReactNode;
  stateLabel: (s: string) => string;
  money: (minor: number | null, currency: string) => string;
  canWrite: boolean;
}) {
  const db = ctx.viewer.db;
  const [format, lines, totals, ack, changes, receipts, submittals] = await Promise.all([
    getFormatter(),
    listPoLines(db, order.id),
    getPurchaseOrderTotals(db, order.id),
    getPoAcknowledgment(db, order.id),
    listPoChangeOrders(db, order.id),
    listGoodsReceipts(db, ctx.org.id, order.id),
    listSubmittals(db, ctx.org.id, { purchaseOrderId: order.id }),
  ]);
  if (!lines.ok || !totals.ok || !ack.ok || !changes.ok || !receipts.ok || !submittals.ok) {
    return <ErrorPanel what={t("orders.what")} />;
  }
  const editable = order.state === "Proposed" && canWrite;
  const date = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const receivable = order.state === "Approved" || order.state === "Sent";
  return (
    <RecordPage
      backHref={backHref}
      backLabel={t("orders.back")}
      recordKey={order.key}
      title={order.vendorName ?? t("fields.unnamedVendor")}
      state={{ state: recordStateOf(order.state), label: stateLabel(order.state) }}
      properties={[
        ...properties,
        {
          label: t("orders.acknowledged"),
          value: ack.data ? date(ack.data.acknowledgedAt) : t("orders.notAcknowledged"),
        },
      ]}
      actions={
        <>
          {controls}
          <DocumentActions org={ctx.org.slug} kind="purchase-order" id={order.id} />
        </>
      }
    >
      <PresenceFor table="purchase_orders" id={order.id} />
      <KitSection id="po-lines" title={t("orders.lines")}>
        {lines.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("orders.noLines")}</p>
        ) : (
          <DataTable
            caption={t("orders.lines")}
            columns={[
              { key: "n", label: "#", type: "number" },
              { key: "description", label: t("lines.descriptionLabel"), wrap: true },
              { key: "quantity", label: t("lines.quantity"), type: "number" },
              { key: "unit", label: t("lines.unitPrice") },
              { key: "extended", label: t("lines.extended") },
              { key: "received", label: t("lines.received"), type: "number" },
            ]}
            rows={lines.data.map((l) => ({
              n: l.lineNumber,
              description: l.description,
              quantity: l.quantity,
              unit: money(l.unitPriceMinor, order.currencyCode),
              extended: money(l.extendedMinor, order.currencyCode),
              received: l.receivedQuantity,
            }))}
            totals={{
              description: t("orders.total"),
              extended: money(totals.data.linesTotalMinor, order.currencyCode),
            }}
          />
        )}
        {editable ? (
          <>
            <div className="flex flex-wrap gap-8">
              {lines.data.map((l) => (
                <ActionButton
                  key={l.id}
                  action={removePoLineAction}
                  hidden={{ org: ctx.org.slug, id: l.id }}
                  label={t("orders.removeLine", { n: l.lineNumber })}
                  refusals={REFUSALS}
                />
              ))}
            </div>
            <EntityForm
              id={`po-line-${order.id}`}
              action={addPoLineAction}
              hidden={{
                org: ctx.org.slug,
                purchaseOrderId: order.id,
                currencyCode: order.currencyCode,
              }}
              refusals={REFUSALS}
              submitLabel={t("orders.addLine")}
              fields={[
                {
                  kind: "text",
                  name: "description",
                  label: t("lines.descriptionLabel"),
                  required: true,
                },
                {
                  kind: "number",
                  name: "quantity",
                  label: t("lines.quantity"),
                  required: true,
                  defaultValue: "1",
                },
                {
                  kind: "text",
                  name: "unitBasis",
                  label: t("lines.unitBasis"),
                  help: t("lines.unitBasisHelp"),
                },
                {
                  kind: "money",
                  name: "unitPrice",
                  label: t("lines.unitPrice"),
                  unit: order.currencyCode,
                },
              ]}
            />
          </>
        ) : order.state === "Proposed" ? null : (
          <p className="m-0 text-text-12 text-text-secondary">{t("orders.linesLocked")}</p>
        )}
      </KitSection>

      <KitSection id="po-changes" title={t("changes.title")}>
        {changes.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("changes.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {changes.data.map((c) => (
              <li key={c.id} className="flex flex-col gap-4 py-8">
                <span className="text-text-13">
                  {c.description} · {money(c.amountDeltaMinor, order.currencyCode)} ·{" "}
                  {t(`changeStates.${c.state}`)}
                </span>
                {c.state === "Proposed" ? (
                  <div className="flex flex-wrap gap-8">
                    {canWrite && c.amountDeltaMinor === null ? (
                      <ActionButton
                        action={priceChangeOrderAction}
                        hidden={{ org: ctx.org.slug, id: c.id, currencyCode: order.currencyCode }}
                        label={t("changes.price")}
                        extraFields={[
                          {
                            kind: "money",
                            name: "amountDelta",
                            label: t("changes.amount"),
                            unit: order.currencyCode,
                          },
                        ]}
                        refusals={REFUSALS}
                      />
                    ) : null}
                    {ctx.capabilities.has("finance.po.approve")
                      ? (["Approved", "Rejected"] as const).map((decision) => (
                          <ActionButton
                            key={decision}
                            action={decideChangeOrderAction}
                            hidden={{ org: ctx.org.slug, id: c.id, decision }}
                            label={t(`changes.${decision === "Approved" ? "approve" : "reject"}`)}
                            variant={decision === "Approved" ? "primary" : "danger"}
                            reason={t("changes.decideReason")}
                            refusals={REFUSALS}
                          />
                        ))
                      : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && receivable ? (
          <EntityForm
            id={`po-change-${order.id}`}
            action={createChangeOrderAction}
            hidden={{
              org: ctx.org.slug,
              purchaseOrderId: order.id,
              currencyCode: order.currencyCode,
            }}
            refusals={REFUSALS}
            submitLabel={t("changes.create")}
            fields={[
              {
                kind: "text",
                name: "description",
                label: t("changes.description"),
                required: true,
              },
              {
                kind: "money",
                name: "amountDelta",
                label: t("changes.amount"),
                unit: order.currencyCode,
                help: t("changes.amountHelp"),
              },
            ]}
          />
        ) : null}
      </KitSection>

      <KitSection
        id="po-receipts"
        title={t("receipts.title")}
        actions={
          receivable && ctx.capabilities.has("procurement.receipt.write") ? (
            <KitLink
              href={`/${ctx.org.slug}/procurement/receipts?create=1&order=${order.id}`}
              size="sm"
              variant="primary"
            >
              {t("receipts.create")}
            </KitLink>
          ) : null
        }
      >
        {receipts.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("receipts.noneForOrder")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {receipts.data.map((r) => (
              <li key={r.id}>
                {t("receipts.line", {
                  date: date(r.receivedAt),
                  who: r.receiverName ?? t("fields.someone"),
                })}
              </li>
            ))}
          </ul>
        )}
      </KitSection>

      <KitSection id="po-submittals" title={t("submittals.title")}>
        {submittals.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("submittals.noneForOrder")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {submittals.data.map((s) => (
              <li key={s.id}>
                <span className="font-mono">{s.key}</span> {s.title} ·{" "}
                {t(`reviewStates.${s.state}`)}
              </li>
            ))}
          </ul>
        )}
      </KitSection>

      <StateHistory ctx={ctx} ledger="purchase_order" id={order.id} stateLabel={stateLabel} />
      <CustomFieldsPanel org={ctx.org.slug} table="app.purchase_orders" id={order.id} />
      <CollabPanels ctx={ctx} table="app.purchase_orders" id={order.id} />
    </RecordPage>
  );
}
