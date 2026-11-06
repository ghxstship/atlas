import { listCounterparties } from "@xos/data/finance";
import { personNames } from "@xos/data/person-names";
import {
  canReadEngagementCosts,
  listEngagementCostItems,
  listEngagementCosts,
  type EngagementCost,
  type EngagementCostComponent,
  type EngagementCostItem,
} from "@xos/data/settlements";
import { getNode } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { type Row } from "./kit.types";
import { PaymentTabs } from "./payments-tabs";

const COMPONENT_LABEL: Readonly<Record<EngagementCostComponent, string>> = {
  settlement: "settlement",
  invoice: "invoice",
  travel: "travel",
  lodging: "lodging",
  per_diem: "perDiem",
  hospitality: "hospitality",
  expense: "expense",
  purchase_order: "purchaseOrder",
};

/**
 * Finance > Payments > Act costs (G-186): the all-in cost of each engagement on a project, one row per engagement and
 * currency, with its items a click away. Needs a project, since the capabilities are checked on it. A total stays
 * Unpriced while any counted item is, and an agency's or an artist's fee counts only once billed or settled: the agreed
 * rate is Restricted and never read (0700), so a row with neither says its total leaves the fee out.
 */
export async function ActCostsTab({ page }: { page: FinancePage }) {
  const { ctx, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const db = ctx.viewer.db;
  const org = ctx.org.slug;
  const project = page.project;
  const base = {
    page,
    title: t(getNode(sitemap, "finance.payments").node.label),
    canCreate: false,
    columns: [],
    rows: [],
    count: 0,
    empty: {
      icon: "Handshake",
      sentence: project ? t("finance.actCosts.empty") : t("finance.actCosts.pickProject"),
      actionLabel: t("finance.actCosts.emptyAction"),
      noMatches: t("finance.common.noMatches"),
      clearLabel: t("finance.common.clearFilters"),
      secondary: true,
    },
  };
  const above = <PaymentTabs page={page} active="act-costs" t={t} />;
  if (!project) return <FinanceCollection {...base} above={above} />;
  if (!(await canReadEngagementCosts(db, project.id))) {
    return <FinanceCollection {...base} above={above} refusal="finance.invoice.read" />;
  }
  const [costs, counterparties] = await Promise.all([
    listEngagementCosts(db, { projectId: project.id }),
    listCounterparties(db, ctx.org.id),
  ]);
  if (!costs.ok || !counterparties.ok) {
    return <FinanceCollection {...base} above={above} error={t("finance.actCosts.loadError")} />;
  }
  const partyName = new Map(counterparties.data.map((p) => [p.id, p.name ?? ""]));
  const names = await personNames(
    db,
    costs.data.map((r) => r.personId),
  );
  const partyOf = (r: EngagementCost) =>
    (r.counterpartyId && partyName.get(r.counterpartyId)) ||
    (r.personId && names.get(r.personId)) ||
    t("finance.invoices.individual");
  const keyOf = (r: EngagementCost) => `${r.engagementId}|${r.currency ?? ""}`;
  const totalOf = (r: EngagementCost) =>
    r.totalMinor === null
      ? t("finance.actCosts.unpricedTotal", { count: r.unpricedCount })
      : c.money(r.totalMinor, r.currency ?? "");
  const term = query.q?.toLowerCase() ?? null;
  const shown = costs.data.filter((r) => term === null || partyOf(r).toLowerCase().includes(term));
  // The row of an act with nothing priced has no currency, so its figures are not amounts: a blank is never 0.
  const money = (r: EngagementCost, minor: number | null) =>
    minor !== null && r.currency === null
      ? t("finance.common.none")
      : c.money(minor, r.currency ?? "");
  // An act whose fee is neither billed nor settled, in any currency: the total leaves the fee out.
  const withFee = new Set(
    costs.data
      .filter((r) => r.settlementMinor !== 0 || r.invoiceMinor !== 0)
      .map((r) => r.engagementId),
  );
  const partyCell = (r: EngagementCost) =>
    withFee.has(r.engagementId)
      ? partyOf(r)
      : t("finance.actCosts.partyNoFee", { party: partyOf(r) });
  const rows: Row[] = shown.map((r) => ({
    id: keyOf(r),
    label: partyOf(r),
    party: partyCell(r),
    currency: r.currency ?? t("finance.actCosts.noCurrency"),
    settlement: money(r, r.settlementMinor),
    invoice: money(r, r.invoiceMinor),
    travel: money(r, r.travelMinor),
    lodging: money(r, r.lodgingMinor),
    perDiem: money(r, r.perDiemMinor),
    hospitality: money(r, r.hospitalityMinor),
    expense: money(r, r.expenseMinor),
    purchaseOrder: money(r, r.purchaseOrderMinor),
    total: totalOf(r),
    priced: money(r, r.pricedTotalMinor),
  }));

  /** Where an item lives: only the records with a page of their own link. */
  const sourceHref = (i: EngagementCostItem): string | null => {
    switch (i.sourceTable) {
      case "settlements":
        return `/${org}/finance/payments?tab=settlements&peek=${i.sourceId}`;
      case "invoices":
        return `/${org}/finance/invoices?peek=${i.sourceId}`;
      case "expenses":
        return `/${org}/finance/expenses?peek=${i.sourceId}`;
      case "per_diems":
        return `/${org}/crew/per-diems?peek=${i.sourceId}`;
      case "po_lines":
        return `/${org}/procurement/purchase-orders?peek=${i.parentId}&full=1`;
      case "fulfillment_lines":
        return `/${org}/hospitality/fulfillments?peek=${i.parentId}`;
      case "accommodation_assignments":
        return `/${org}/hospitality/accommodation-blocks?peek=${i.parentId}`;
      default:
        return null;
    }
  };

  const peeked = query.peek ? costs.data.find((r) => keyOf(r) === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peeked) {
    const items = await listEngagementCostItems(db, {
      projectId: project.id,
      engagementId: peeked.engagementId,
    });
    // An item with no price has no currency either: it is listed on every row, since it is what makes the total Unpriced.
    const list = (items.ok ? items.data : []).filter(
      (i) => i.currency === peeked.currency || i.currency === null,
    );
    const labelled = (i: EngagementCostItem): ReactNode => {
      const text = i.label ?? t(`finance.actCosts.components.${COMPONENT_LABEL[i.component]}`);
      const href = sourceHref(i);
      return href ? (
        <Link href={href as Route} className="text-accent-text underline">
          {text}
        </Link>
      ) : (
        text
      );
    };
    const partly = list.some(
      (i) => i.amountMinor !== null && i.countedMinor !== null && i.countedMinor < i.amountMinor,
    );
    detail = {
      kindLabel: t("finance.actCosts.kind"),
      recordKey: peeked.currency ?? t("finance.actCosts.noCurrency"),
      title: partyOf(peeked),
      state: peeked.totalMinor === null ? "in-review" : "complete",
      stateLabel: totalOf(peeked),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.common.total"), value: totalOf(peeked) },
        {
          label: t("finance.actCosts.fields.pricedTotal"),
          value: money(peeked, peeked.pricedTotalMinor),
        },
      ],
      content: (
        <>
          {withFee.has(peeked.engagementId) ? null : (
            <p className="m-0 text-text-12 text-text-secondary">{t("finance.actCosts.noFee")}</p>
          )}
          <Section id="act-cost-items" title={t("finance.actCosts.items")}>
            <SimpleTable
              caption={t("finance.actCosts.items")}
              head={[
                t("finance.actCosts.fields.component"),
                t("finance.actCosts.fields.item"),
                t("finance.common.amount"),
                t("finance.actCosts.fields.counted"),
              ]}
              numeric={[2, 3]}
              rows={list.map((i) => [
                t(`finance.actCosts.components.${COMPONENT_LABEL[i.component]}`),
                labelled(i),
                c.money(i.amountMinor, i.currency ?? ""),
                c.money(i.countedMinor, i.currency ?? ""),
              ])}
            />
            {partly ? (
              <p className="m-0 text-text-12 text-text-secondary">{t("finance.actCosts.partly")}</p>
            ) : null}
          </Section>
        </>
      ),
    };
  }

  return (
    <FinanceCollection
      {...base}
      count={shown.length}
      above={above}
      columns={[
        { key: "party", label: t("finance.actCosts.fields.party"), wrap: true },
        { key: "currency", label: t("finance.common.currency"), type: "code" },
        { key: "settlement", label: t("finance.actCosts.components.settlement"), type: "number" },
        { key: "invoice", label: t("finance.actCosts.components.invoice"), type: "number" },
        { key: "travel", label: t("finance.actCosts.components.travel"), type: "number" },
        { key: "lodging", label: t("finance.actCosts.components.lodging"), type: "number" },
        { key: "perDiem", label: t("finance.actCosts.components.perDiem"), type: "number" },
        { key: "hospitality", label: t("finance.actCosts.components.hospitality"), type: "number" },
        { key: "expense", label: t("finance.actCosts.components.expense"), type: "number" },
        {
          key: "purchaseOrder",
          label: t("finance.actCosts.components.purchaseOrder"),
          type: "number",
        },
        { key: "total", label: t("finance.common.total"), type: "number" },
        { key: "priced", label: t("finance.actCosts.fields.pricedTotal"), type: "number" },
      ]}
      rows={rows}
      listItems={shown.map((r) => ({
        id: keyOf(r),
        recordKey: r.currency ?? t("finance.actCosts.noCurrency"),
        title: partyCell(r),
        state: r.totalMinor === null ? "in-review" : "complete",
        stateLabel: totalOf(r),
        next: totalOf(r),
      }))}
      detail={detail}
    />
  );
}
