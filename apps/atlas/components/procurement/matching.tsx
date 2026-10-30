import {
  listCurrencies,
  listGoodsReceipts,
  listInvoiceMatches,
  listPayableInvoices,
  matchStanding,
  type InvoiceMatch,
} from "@xos/data/procurement";
import { getFormatter } from "next-intl/server";
import {
  approveInvoiceAction,
  createMatchAction,
  resolveMatchAction,
} from "@/app/[org]/procurement/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  collectionState,
  formatMinor,
  withQuery,
  type SearchParams,
} from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "procurement.refusals";

const STANDING: Record<ReturnType<typeof matchStanding>, KitState["state"]> = {
  matched: "complete",
  resolved: "ready",
  mismatch: "blocked",
};

function standingOf(m: InvoiceMatch, t: Copy): KitState {
  const s = matchStanding(m);
  return { state: STANDING[s], label: t(`matching.standing.${s}`) };
}

/**
 * Procurement > Invoice matching (invariant 17, journey 5): a payable invoice matched to a purchase
 * order and one of its receipts. The variance is derived; a mismatch is accepted only with a
 * resolution recorded by someone other than the matcher, and approval stays an explicit act that
 * the database refuses while a mismatch is unresolved.
 */
export async function InvoiceMatchingSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, matches, invoices, receipts, currencies] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listInvoiceMatches(db, ctx.org.id),
    listPayableInvoices(db, ctx.org.id),
    listGoodsReceipts(db, ctx.org.id),
    listCurrencies(db),
  ]);
  const title = t("matching.title");
  if (!matches.ok || !invoices.ok || !receipts.ok || !currencies.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("matching.what")} />
      </CollectionPage>
    );
  }
  const canMatch = ctx.capabilities.has("procurement.invoice_match.write");
  const canApprove = ctx.capabilities.has("finance.invoice.approve");
  const exponent = new Map(currencies.data.map((c) => [c.code, c.minorUnits]));
  const variance = (m: InvoiceMatch) =>
    formatMinor(
      format,
      m.varianceMinor,
      m.currencyCode,
      exponent.get(m.currencyCode ?? "") ?? 2,
      t("matching.unpricedVariance"),
    );
  const me = ctx.viewer.person?.id ?? null;
  const selected = state.peek ? matches.data.find((m) => m.id === state.peek) : undefined;
  const properties = (m: InvoiceMatch) => [
    { label: t("matching.invoice"), value: m.invoiceNumber ?? t("matching.noNumber") },
    {
      label: t("matching.invoiceState"),
      value: m.invoiceState ? t(`invoiceStates.${m.invoiceState}`) : t("matching.unknown"),
    },
    { label: t("receipts.order"), value: m.purchaseOrderKey },
    { label: t("fields.vendor"), value: m.vendorName ?? t("fields.unnamedVendor") },
    { label: t("matching.variance"), value: variance(m) },
    { label: t("matching.resolution"), value: m.resolutionNote ?? t("matching.noResolution") },
  ];
  const actions = (m: InvoiceMatch) => (
    <>
      {canMatch && !m.isMatched && !m.isResolved && m.createdBy !== me ? (
        <ActionButton
          action={resolveMatchAction}
          hidden={{ org: ctx.org.slug, id: m.id }}
          label={t("matching.resolve")}
          reason={t("matching.resolveReason")}
          refusals={REFUSALS}
        />
      ) : null}
      {canApprove && (m.invoiceState === "Proposed" || m.invoiceState === "Disputed") ? (
        <ActionButton
          action={approveInvoiceAction}
          hidden={{ org: ctx.org.slug, invoiceId: m.invoiceId }}
          label={t("matching.approveInvoice")}
          variant="primary"
          reason={t("matching.approveReason")}
          refusals={REFUSALS}
        />
      ) : null}
    </>
  );
  const notice = (m: InvoiceMatch) =>
    matchStanding(m) === "mismatch" ? (
      <InlineAlert tone="warning" title={t("matching.mismatchTitle")}>
        {m.createdBy === me ? t("matching.mismatchSelf") : t("matching.mismatchBody")}
      </InlineAlert>
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("matching.back")}
        recordKey={selected.purchaseOrderKey}
        title={t("matching.recordTitle", {
          invoice: selected.invoiceNumber ?? t("matching.noNumber"),
        })}
        state={standingOf(selected, t)}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {notice(selected)}
        <CollabPanels ctx={ctx} table="app.invoice_matches" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = matches.data.map((m) => ({
    id: m.id,
    key: m.purchaseOrderKey,
    title: m.invoiceNumber ?? t("matching.noNumber"),
    state: standingOf(m, t),
    boardValue: matchStanding(m),
    meta: variance(m),
    cells: {
      invoice: m.invoiceNumber,
      order: m.purchaseOrderKey,
      vendor: m.vendorName,
      variance: variance(m),
      standing: standingOf(m, t),
    },
  }));

  let drawer = null;
  const unmatched = receipts.data.filter((r) => !r.matched);
  if (state.create && canMatch) {
    drawer = (
      <FormDrawer title={t("matching.create")} closeHref={withQuery(path, state)}>
        {invoices.data.length === 0 || unmatched.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("matching.nothingToMatch")}</p>
        ) : (
          <EntityForm
            id="match-create"
            action={createMatchAction}
            hidden={{ org: ctx.org.slug }}
            refusals={REFUSALS}
            submitLabel={t("matching.create")}
            successHref={withQuery(path, state, { peek: "{id}" })}
            fields={[
              {
                kind: "select",
                name: "invoiceId",
                label: t("matching.invoice"),
                blankLabel: t("matching.chooseInvoice"),
                defaultValue: "",
                options: invoices.data.map((i) => ({
                  value: i.id,
                  label: i.label || t("matching.noNumber"),
                })),
              },
              {
                kind: "select",
                name: "goodsReceiptId",
                label: t("matching.receipt"),
                blankLabel: t("matching.chooseReceipt"),
                defaultValue: "",
                options: unmatched.map((r) => ({
                  value: `${r.purchaseOrderId}:${r.id}`,
                  label: `${r.purchaseOrderKey} · ${format.dateTime(new Date(r.receivedAt), { dateStyle: "medium" })}`,
                })),
              },
            ]}
          />
        )}
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.purchaseOrderKey}
        title={t("matching.recordTitle", {
          invoice: selected.invoiceNumber ?? t("matching.noNumber"),
        })}
        state={standingOf(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {notice(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "invoice", label: t("matching.invoice") },
        { key: "order", label: t("receipts.order"), type: "code" },
        { key: "vendor", label: t("fields.vendor") },
        { key: "variance", label: t("matching.variance") },
        { key: "standing", label: t("matching.standingLabel"), type: "state" },
      ]}
      rows={rows}
      board={[
        { value: "mismatch", state: "blocked", label: t("matching.standing.mismatch") },
        { value: "resolved", state: "ready", label: t("matching.standing.resolved") },
        { value: "matched", state: "complete", label: t("matching.standing.matched") },
      ]}
      actions={
        canMatch ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("matching.create")}
          </KitLink>
        ) : null
      }
      empty={
        canMatch && invoices.data.length > 0 ? (
          <EmptyStateLink
            icon="Scale"
            sentence={t("matching.empty")}
            actionLabel={t("matching.create")}
            href={withQuery(path, state, { create: "1" })}
            secondary
          />
        ) : canMatch ? (
          <EmptyStateLink
            icon="Scale"
            sentence={t("matching.emptyNoInvoices")}
            actionLabel={t("matching.openInvoices")}
            href={`/${ctx.org.slug}/finance/invoices`}
            secondary
          />
        ) : (
          <EmptyRefresh icon="Scale" sentence={t("matching.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
