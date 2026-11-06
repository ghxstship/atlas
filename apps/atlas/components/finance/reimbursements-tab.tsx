import {
  canReadReimbursements,
  canRecordPayments,
  listOwedExpenses,
  listReimbursementBalances,
  listReimbursements,
  type ReimbursementBalance,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { exponentOf } from "@/lib/finance/money";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { RecordReimbursementForm } from "./forms-record-reimbursement-form";
import { VoidReimbursementForm } from "./forms-void-reimbursement-form";
import { FormSheet } from "./kit-form-sheet";
import { type Row } from "./kit.types";
import { PaymentTabs, PaymentsNotice } from "./payments-tabs";

/**
 * Finance > Payments > Reimbursements (G-228, decision 76): who is owed what they paid out of pocket, per payee and
 * currency, most owed first. `?payee=` narrows to one person and lists what was recorded for them, with Void. Recording
 * moves no money (decision 20), and nobody records or voids their own.
 */
export async function ReimbursementsTab({ page }: { page: FinancePage }) {
  const { ctx, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const db = ctx.viewer.db;
  const base = {
    page,
    title: t(getNode(sitemap, "finance.payments").node.label),
    canCreate: false,
    columns: [],
    rows: [],
    count: 0,
    empty: {
      icon: "HandCoins",
      sentence: t("finance.reimbursements.empty"),
      actionLabel: t("finance.reimbursements.emptyAction"),
      noMatches: t("finance.common.noMatches"),
      clearLabel: t("finance.common.clearFilters"),
      secondary: true,
    },
  };
  if (!(await canReadReimbursements(db, ctx.org.id))) {
    return <FinanceCollection {...base} refusal="finance.payment.read" />;
  }
  const projectId = page.project?.id ?? null;
  const [balances, canRecord] = await Promise.all([
    listReimbursementBalances(db, { orgId: ctx.org.id, projectId }),
    canRecordPayments(db, ctx.org.id),
  ]);
  if (!balances.ok) {
    return <FinanceCollection {...base} error={t("finance.reimbursements.loadError")} />;
  }
  const me = ctx.viewer.person?.id ?? null;
  const nameOf = (b: { payeeName: string | null }) => b.payeeName ?? t("finance.invoices.individual");
  const payee = query.extra["payee"] ?? null;
  const term = query.q?.toLowerCase() ?? null;
  const shown = balances.data.filter(
    (b) =>
      (payee === null || b.payeePersonId === payee) &&
      (term === null || nameOf(b).toLowerCase().includes(term)),
  );
  const keyOf = (b: ReimbursementBalance) => `${b.payeePersonId}|${b.currency}`;
  const rows: Row[] = shown.map((b) => ({
    id: keyOf(b),
    label: nameOf(b),
    payee: nameOf(b),
    currency: b.currency,
    recorded: t("finance.reimbursements.countAndAmount", {
      count: b.recordedCount,
      amount: c.money(b.recordedMinor, b.currency),
    }),
    owed: c.money(b.owedMinor, b.currency),
    paid: c.money(b.paidMinor, b.currency),
    lastPaid: c.date(b.lastPaidOn),
  }));

  const recordHref = (b: ReimbursementBalance) =>
    withQuery(page, { record: b.payeePersonId, currency: b.currency, peek: null });
  const canRecordFor = (b: ReimbursementBalance) =>
    canRecord && b.owedCount > 0 && b.payeePersonId !== me;

  const peeked = query.peek ? balances.data.find((b) => keyOf(b) === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peeked) {
    detail = {
      kindLabel: t("finance.reimbursements.kind"),
      recordKey: peeked.currency,
      title: nameOf(peeked),
      state: peeked.owedCount > 0 ? "in-review" : "complete",
      stateLabel:
        peeked.owedCount > 0 ? t("finance.reimbursements.status.Owed") : t("finance.reimbursements.status.NotOwed"),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.reimbursements.fields.recorded"), value: String(rows.find((r) => r.id === query.peek)?.["recorded"] ?? "") },
        { label: t("finance.reimbursements.fields.owed"), value: c.money(peeked.owedMinor, peeked.currency) },
        { label: t("finance.reimbursements.fields.paid"), value: c.money(peeked.paidMinor, peeked.currency) },
        { label: t("finance.reimbursements.fields.lastPaid"), value: c.date(peeked.lastPaidOn) || t("finance.common.none") },
      ],
      content: (
        <div className="flex flex-wrap gap-8">
          {canRecordFor(peeked) ? (
            <ButtonLink href={recordHref(peeked)} variant="secondary" size="sm">
              {t("finance.reimbursements.record")}
            </ButtonLink>
          ) : null}
          <ButtonLink
            href={withQuery(page, { payee: peeked.payeePersonId, peek: null })}
            variant="ghost"
            size="sm"
          >
            {t("finance.reimbursements.show")}
          </ButtonLink>
        </div>
      ),
    };
  }

  let history: ReactNode = null;
  let voidSheet: ReactNode = null;
  if (payee) {
    const recorded = await listReimbursements(db, { orgId: ctx.org.id, payeePersonId: payee });
    const list = recorded.ok ? recorded.data : [];
    const canVoid = canRecord && payee !== me;
    history = (
      <Section id="reimbursement-history" title={t("finance.reimbursements.history.title")}>
        {list.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("finance.reimbursements.history.empty")}
          </p>
        ) : (
          <SimpleTable
            caption={t("finance.reimbursements.history.title")}
            head={[
              t("finance.payments.fields.paidOn"),
              t("finance.common.amount"),
              t("finance.payments.fields.reference"),
              t("finance.common.state"),
              ...(canVoid ? [t("finance.common.actions")] : []),
            ]}
            numeric={[1]}
            rows={list.map((r) => [
              c.date(r.paidOn),
              c.money(r.paidMinor, r.currency),
              r.reference ?? "",
              r.voidedAt
                ? t("finance.reimbursements.history.voided", { reason: r.voidReason ?? "" })
                : t("finance.reimbursements.history.standing"),
              ...(canVoid
                ? [
                    r.voidedAt ? (
                      ""
                    ) : (
                      <ButtonLink
                        key="v"
                        href={withQuery(page, { voidReimbursement: r.id })}
                        variant="ghost"
                        size="sm"
                      >
                        {t("finance.reimbursements.void")}
                      </ButtonLink>
                    ),
                  ]
                : []),
            ])}
          />
        )}
      </Section>
    );
    const voidId = query.extra["voidReimbursement"];
    if (canVoid && voidId && list.some((r) => r.id === voidId && !r.voidedAt)) {
      voidSheet = (
        <FormSheet title={t("finance.reimbursements.void")} flag="voidReimbursement">
          <VoidReimbursementForm org={ctx.org.slug} id={voidId} />
        </FormSheet>
      );
    }
  }

  let recordSheet: ReactNode = null;
  const recordFor = query.extra["record"];
  const recordCurrency = query.extra["currency"];
  if (canRecord && recordFor && recordCurrency && recordFor !== me) {
    const owed = await listOwedExpenses(db, { orgId: ctx.org.id, payeePersonId: recordFor, projectId });
    // One currency a sheet: a reimbursement settles expenses in one currency.
    const inCurrency = owed.ok ? owed.data.filter((o) => o.currency === recordCurrency) : [];
    if (inCurrency.length > 0) {
      recordSheet = (
        <FormSheet title={t("finance.reimbursements.record")} flag="record">
          <RecordReimbursementForm
            org={ctx.org.slug}
            payeePersonId={recordFor}
            currency={recordCurrency}
            exponent={exponentOf(c.exponents, recordCurrency)}
            today={await orgToday(ctx)}
            owed={inCurrency.map((o) => ({
              value: o.expenseId,
              label: `${o.projectKey} · ${o.description} · ${c.money(o.netMinor, o.currency)}`,
              netMinor: o.netMinor,
              pending: o.pendingCreditMinor > 0,
            }))}
          />
        </FormSheet>
      );
    }
  }

  return (
    <FinanceCollection
      {...base}
      count={shown.length}
      above={
        <>
          <PaymentTabs page={page} active="reimbursements" t={t} />
          <PaymentsNotice page={page} t={t} />
          {history}
          {payee
            ? shown.filter(canRecordFor).map((b) => (
                <div key={keyOf(b)}>
                  <ButtonLink href={recordHref(b)} variant="secondary" size="sm">
                    {t("finance.reimbursements.recordIn", { currency: b.currency })}
                  </ButtonLink>
                </div>
              ))
            : null}
        </>
      }
      columns={[
        { key: "payee", label: t("finance.reimbursements.fields.payee"), wrap: true },
        { key: "currency", label: t("finance.common.currency"), type: "code" },
        { key: "recorded", label: t("finance.reimbursements.fields.recorded") },
        { key: "owed", label: t("finance.reimbursements.fields.owed"), type: "number" },
        { key: "paid", label: t("finance.reimbursements.fields.paid"), type: "number" },
        { key: "lastPaid", label: t("finance.reimbursements.fields.lastPaid") },
      ]}
      rows={rows}
      listItems={shown.map((b) => ({
        id: keyOf(b),
        recordKey: b.currency,
        title: nameOf(b),
        state: b.owedCount > 0 ? "in-review" : "complete",
        stateLabel:
          b.owedCount > 0 ? t("finance.reimbursements.status.Owed") : t("finance.reimbursements.status.NotOwed"),
        next: c.money(b.owedMinor, b.currency),
      }))}
      detail={detail}
      sheet={
        <>
          {recordSheet}
          {voidSheet}
        </>
      }
    />
  );
}
