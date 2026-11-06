import {
  PAYMENT_DUE_BUCKETS,
  canReadPaymentsDue,
  canRecordPayments,
  groupPaymentsDue,
  listPaymentsDue,
  paymentDueBucket,
  type PaymentDue,
  type PaymentDueBucket,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import type { RecordState } from "@xos/ui";
import { ButtonLink } from "@/components/ui";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgWeekStart } from "@/lib/shell/time-zone";
import { FinanceCollection, type RecordDetail } from "./collection";
import { SimpleTable } from "./figures";
import { MarkPerDiemsPaidForm } from "./forms-mark-per-diems-paid-form";
import { FormSheet } from "./kit-form-sheet";
import { type Row } from "./kit.types";
import { PaymentTabs, PaymentsNotice } from "./payments-tabs";

const BUCKET_STATE: Readonly<Record<PaymentDueBucket, RecordState>> = {
  overdue: "blocked",
  thisWeek: "scheduled",
  later: "proposed",
  undated: "deferred",
};

/**
 * Finance > Payments > Due (G-184): what the org owes and when, from app.payments_due, in the order Overdue, This week,
 * Later, No due date. A row's bucket uses its own project's day and the org's payroll week. Every control records and
 * none pays: a row opens its source, or the sheet that records a per diem payment (decision 20).
 */
export async function PaymentsDueTab({ page }: { page: FinancePage }) {
  const { ctx, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const db = ctx.viewer.db;
  const org = ctx.org.slug;
  const base = {
    page,
    title: t(getNode(sitemap, "finance.payments").node.label),
    canCreate: false,
    columns: [],
    rows: [],
    count: 0,
    empty: {
      icon: "CalendarClock",
      sentence: t("finance.due.empty"),
      actionLabel: t("finance.due.emptyAction"),
      noMatches: t("finance.common.noMatches"),
      clearLabel: t("finance.common.clearFilters"),
      secondary: true,
    },
  };
  // Decided by the same five capabilities the ledger checks: any reach of one is not enough.
  if (!(await canReadPaymentsDue(db, ctx.org.id))) {
    return <FinanceCollection {...base} refusal="finance.payment.read" />;
  }
  const [due, weekStart, canRecord] = await Promise.all([
    listPaymentsDue(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
    getOrgWeekStart(ctx),
    canRecordPayments(db, ctx.org.id),
  ]);
  if (!due.ok) return <FinanceCollection {...base} error={t("finance.due.loadError")} />;
  const me = ctx.viewer.person?.id ?? null;

  const bucketOf = (d: PaymentDue) => paymentDueBucket(d.dueOn, d.projectToday, weekStart);
  const bucketLabel = (b: PaymentDueBucket) => t(`finance.due.buckets.${b}`);
  const payeeOf = (d: PaymentDue) =>
    d.counterpartyName ??
    d.payeeName ??
    (d.payeePersonId ? t("finance.invoices.individual") : t("finance.common.none"));
  // A per diem row has no label of its own, so its text is composed from the day.
  const whatOf = (d: PaymentDue) =>
    d.kind === "per_diem"
      ? t("finance.due.perDiemOn", { day: c.date(d.dueOn) })
      : (d.label ?? t(`finance.due.kinds.${d.kind}`));
  const kindLabel = (d: PaymentDue) => t(`finance.due.kinds.${d.kind}`);

  const groups = groupPaymentsDue(due.data, weekStart);
  const term = query.q?.toLowerCase() ?? null;
  const shown = groups
    .filter((g) => !query.state || g.bucket === query.state)
    .flatMap((g) => g.rows)
    .filter(
      (d) =>
        term === null ||
        payeeOf(d).toLowerCase().includes(term) ||
        whatOf(d).toLowerCase().includes(term) ||
        d.projectKey.toLowerCase().includes(term),
    );
  const rows: Row[] = shown.map((d) => {
    const bucket = bucketOf(d);
    return {
      id: d.sourceId,
      label: `${kindLabel(d)} ${whatOf(d)}`,
      bucket: { state: BUCKET_STATE[bucket], label: bucketLabel(bucket) },
      due: c.date(d.dueOn),
      kind: kindLabel(d),
      project: d.projectKey,
      payee: payeeOf(d),
      what: whatOf(d),
      amount: c.money(d.amountMinor, d.currency),
      scheduled: d.scheduledMinor > 0 ? c.money(d.scheduledMinor, d.currency) : "",
    };
  });

  const summary = groups.flatMap((g) =>
    g.subtotals.map((s) => [
      bucketLabel(g.bucket),
      s.currency,
      s.total === null
        ? t("finance.due.unpricedCount", { count: s.unpricedCount })
        : c.money(s.total, s.currency),
      s.scheduled > 0 ? c.money(s.scheduled, s.currency) : "",
    ]),
  );

  const opener = (d: PaymentDue): { label: string; href: string } | null => {
    switch (d.kind) {
      case "invoice":
        return {
          label: t("finance.due.open.invoice"),
          href: `/${org}/finance/invoices?peek=${d.sourceId}`,
        };
      case "instalment":
        return d.purchaseOrderId
          ? {
              label: t("finance.due.open.instalment"),
              href: `/${org}/procurement/purchase-orders?peek=${d.purchaseOrderId}&full=1#po-payment-schedule`,
            }
          : null;
      case "settlement":
        return {
          label: t("finance.due.open.settlement"),
          href: withQuery(page, { tab: "settlements", peek: d.sourceId, state: null }),
        };
      case "reimbursement":
        return d.payeePersonId
          ? {
              label: t("finance.due.open.reimbursement"),
              href: withQuery(page, {
                tab: "reimbursements",
                payee: d.payeePersonId,
                peek: null,
                state: null,
              }),
            }
          : null;
      case "expense":
        return {
          label: t("finance.due.open.expense"),
          href: `/${org}/finance/expenses?peek=${d.sourceId}`,
        };
      case "per_diem":
        return canRecord && d.payeePersonId !== me
          ? {
              label: t("finance.due.markPaid.title"),
              href: withQuery(page, { payPerDiems: d.payeePersonId ?? d.sourceId, peek: null }),
            }
          : {
              label: t("finance.due.open.perDiem"),
              href: `/${org}/crew/per-diems?peek=${d.sourceId}`,
            };
    }
  };

  const peeked = query.peek ? due.data.find((d) => d.sourceId === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peeked) {
    const bucket = bucketOf(peeked);
    const open = opener(peeked);
    detail = {
      kindLabel: kindLabel(peeked),
      recordKey: peeked.projectKey,
      title: whatOf(peeked),
      state: BUCKET_STATE[bucket],
      stateLabel: bucketLabel(bucket),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.due.fields.payee"), value: payeeOf(peeked) },
        {
          label: t("finance.due.fields.due"),
          value: c.date(peeked.dueOn) || t("finance.common.none"),
        },
        { label: t("finance.common.amount"), value: c.money(peeked.amountMinor, peeked.currency) },
        ...(peeked.scheduledMinor > 0
          ? [
              {
                label: t("finance.due.fields.scheduled"),
                value: c.money(peeked.scheduledMinor, peeked.currency),
              },
            ]
          : []),
        ...(peeked.billedOffsetMinor === null || peeked.billedOffsetMinor > 0
          ? [
              {
                label: t("finance.due.fields.billedOffset"),
                value: c.money(peeked.billedOffsetMinor, peeked.currency),
              },
            ]
          : []),
        { label: t("finance.common.project"), value: peeked.projectKey },
      ],
      content: (
        <>
          {peeked.billedOffsetMinor === null || peeked.billedOffsetMinor > 0 ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("finance.due.billedOffsetHelp")}
            </p>
          ) : null}
          {open ? (
            <div className="flex flex-wrap gap-8">
              <ButtonLink href={open.href} variant="secondary" size="sm">
                {open.label}
              </ButtonLink>
            </div>
          ) : null}
        </>
      ),
    };
  }

  const payFor = query.extra["payPerDiems"];
  const payable =
    payFor && canRecord
      ? due.data.filter(
          (d) => d.kind === "per_diem" && (d.payeePersonId === payFor || d.sourceId === payFor),
        )
      : [];
  const sheet =
    payable.length > 0 ? (
      <FormSheet title={t("finance.due.markPaid.title")} flag="payPerDiems">
        <MarkPerDiemsPaidForm
          org={org}
          today={payable[0]?.projectToday ?? ""}
          perDiems={payable.map((d) => ({
            value: d.sourceId,
            label: `${c.date(d.dueOn)} · ${d.projectKey} · ${c.money(d.amountMinor, d.currency)}`,
          }))}
        />
      </FormSheet>
    ) : null;

  return (
    <FinanceCollection
      {...base}
      count={shown.length}
      states={PAYMENT_DUE_BUCKETS.map((b) => ({ value: b, label: bucketLabel(b) }))}
      above={
        <>
          <PaymentTabs page={page} active="due" t={t} />
          <PaymentsNotice page={page} t={t} />
          {summary.length > 0 ? (
            <SimpleTable
              caption={t("finance.due.summary")}
              head={[
                t("finance.due.fields.bucket"),
                t("finance.common.currency"),
                t("finance.common.total"),
                t("finance.due.fields.scheduled"),
              ]}
              numeric={[2, 3]}
              rows={summary}
            />
          ) : null}
        </>
      }
      columns={[
        { key: "bucket", label: t("finance.due.fields.bucket"), type: "state" },
        { key: "due", label: t("finance.due.fields.due") },
        { key: "kind", label: t("finance.due.fields.kind") },
        { key: "project", label: t("finance.common.project"), type: "code" },
        { key: "payee", label: t("finance.due.fields.payee"), wrap: true },
        { key: "what", label: t("finance.due.fields.what"), wrap: true },
        { key: "amount", label: t("finance.common.amount"), type: "number" },
        { key: "scheduled", label: t("finance.due.fields.scheduled"), type: "number" },
      ]}
      rows={rows}
      listItems={shown.map((d) => {
        const bucket = bucketOf(d);
        return {
          id: d.sourceId,
          recordKey: c.date(d.dueOn) || d.projectKey,
          title: `${payeeOf(d)} · ${whatOf(d)}`,
          state: BUCKET_STATE[bucket],
          stateLabel: bucketLabel(bucket),
          next: c.money(d.amountMinor, d.currency),
        };
      })}
      detail={detail}
      sheet={sheet}
    />
  );
}
