import {
  PAYMENT_STATES,
  NEXT_STATES,
  listCounterparties,
  listInvoices,
  listPaymentApplications,
  listPayments,
  listTransitions,
  type Payment,
} from "@xos/data/finance";
import {
  SETTLEMENT_LINE_KINDS,
  SETTLEMENT_ORG_NEXT,
  SETTLEMENT_STATES,
  listEngagementRefs,
  listSettlementLines,
  listSettlements,
} from "@xos/data/settlements";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { applyPaymentAction, saveSettlementLineAction } from "@/app/[org]/finance/actions";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { ApplyPaymentForm, PaymentForm, SettlementForm, SettlementLineForm } from "./forms";
import { FormSheet, InlineActionButton, TransitionBar, type Row } from "./kit";
import { RecordActivity, RecordCollab } from "./record";

/**
 * Finance > Payments (Section 4.5.5): payments made and received, applied to invoices so billed and
 * paid to date count each payment once (invariant 16), and the settlements of engagements beside them
 * (Section 4.5.8 Settlement). Approval never goes to the person who recorded the payment or, for a
 * payable, to anyone who created the vendor or edited its bank details (Section 8.2).
 */
export async function PaymentsView({ page }: { page: FinancePage }) {
  return page.query.extra["tab"] === "settlements" ? (
    <SettlementsTab page={page} />
  ) : (
    <PaymentsTab page={page} />
  );
}

function Tabs({
  page,
  active,
  t,
}: {
  page: FinancePage;
  active: "payments" | "settlements";
  t: (k: string) => string;
}) {
  return (
    <nav
      aria-label={t("finance.payments.tabs")}
      className="flex gap-8 border-b border-border-subtle text-text-13"
    >
      {(["payments", "settlements"] as const).map((tab) => (
        <Link
          key={tab}
          href={
            withQuery(page, {
              tab: tab === "payments" ? null : tab,
              peek: null,
              state: null,
            }) as Route
          }
          aria-current={active === tab ? "page" : undefined}
          className="-mb-px border-b-2 border-transparent px-4 py-6 text-text-secondary aria-[current=page]:border-accent aria-[current=page]:text-text-primary"
        >
          {t(`finance.payments.tab.${tab}`)}
        </Link>
      ))}
    </nav>
  );
}

async function PaymentsTab({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.payments").node.label);
  const empty = {
    icon: "Banknote",
    sentence: t("finance.payments.empty"),
    actionLabel: t("finance.payments.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.payments.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.payment.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.payment.read" />;
  }
  const db = ctx.viewer.db;
  const [payments, counterparties, invoices] = await Promise.all([
    listPayments(db, ctx.org.id),
    listCounterparties(db, ctx.org.id),
    listInvoices(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
  ]);
  if (!payments.ok || !counterparties.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.payments.loadError")} />
    );
  }
  const canWrite = access.can("finance.payment.write");
  const canApprove = access.can("finance.payment.approve");
  const partyName = new Map(
    counterparties.data.map((p) => [p.id, p.name ?? t("finance.common.unnamedCounterparty")]),
  );
  /** The payee: the counterparty, or the person paid as an individual (A38-007). */
  const payee = (p: Payment) =>
    p.counterpartyId !== null
      ? (partyName.get(p.counterpartyId) ?? "")
      : p.payeeName
        ? t("finance.payments.individualPayee", { name: p.payeeName })
        : t("finance.invoices.individual");
  const invoiceList = invoices.ok ? invoices.data : [];
  const term = query.q?.toLowerCase() ?? null;
  const shown = payments.data.filter(
    (p) =>
      (!query.state || p.state === query.state) &&
      (term === null ||
        payee(p).toLowerCase().includes(term) ||
        (p.reference ?? "").toLowerCase().includes(term)),
  );
  const rows: Row[] = shown.map((p) => ({
    id: p.id,
    paid: c.date(p.paidOn),
    party: payee(p),
    direction: t(`finance.payments.directionShort.${p.direction}`),
    reference: p.reference ?? "",
    amount: c.money(p.amountMinor, p.currency),
    applied: c.money(p.appliedMinor, p.currency),
    state: { state: iconState(p.state), label: c.state("payment", p.state) },
  }));

  const peek = query.peek ? payments.data.find((p) => p.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const [apps, ledger] = await Promise.all([
      listPaymentApplications(db, peek.id),
      listTransitions(db, "payment_state_transitions", peek.id),
    ]);
    const invoiceById = new Map(invoiceList.map((i) => [i.id, i]));
    const open = invoiceList.filter(
      (i) =>
        i.counterpartyId === peek.counterpartyId &&
        i.payeePersonId === peek.payeePersonId &&
        i.direction === peek.direction &&
        i.currency === peek.currency &&
        ["Issued", "Approved", "Disputed"].includes(i.state),
    );
    const allowed = NEXT_STATES.payment[peek.state].filter((n) =>
      n === "Approved" ? canApprove : canWrite,
    );
    detail = {
      kindLabel: t("finance.payments.kind"),
      recordKey: peek.reference ?? c.date(peek.paidOn),
      title: payee(peek),
      state: iconState(peek.state),
      stateLabel: c.state("payment", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.common.amount"), value: c.money(peek.amountMinor, peek.currency) },
        { label: t("finance.payments.applied"), value: c.money(peek.appliedMinor, peek.currency) },
        {
          label: t("finance.payments.unapplied"),
          value: c.money(peek.amountMinor - peek.appliedMinor, peek.currency),
        },
        { label: t("finance.payments.fields.paidOn"), value: c.date(peek.paidOn) },
        {
          label: t("finance.payments.fields.direction"),
          value: t(`finance.payments.directionShort.${peek.direction}`),
        },
      ],
      content: (
        <>
          <TransitionBar
            org={ctx.org.slug}
            lifecycle="payment"
            id={peek.id}
            state={peek.state}
            allowed={allowed}
          />
          <Section id="payment-applications" title={t("finance.payments.applications")}>
            {apps.ok && apps.data.length > 0 ? (
              <SimpleTable
                caption={t("finance.payments.applications")}
                head={[
                  t("finance.payments.fields.invoice"),
                  t("finance.common.amount"),
                  ...(canWrite ? [t("finance.common.actions")] : []),
                ]}
                numeric={[1]}
                rows={apps.data.map((a) => [
                  invoiceById.get(a.invoiceId)?.number ?? t("finance.payments.unnumbered"),
                  c.money(a.amountMinor, peek.currency),
                  ...(canWrite
                    ? [
                        <InlineActionButton
                          key="r"
                          action={applyPaymentAction}
                          fields={{ org: ctx.org.slug, remove: a.id }}
                          label={t("finance.common.remove")}
                          icon="X"
                        />,
                      ]
                    : []),
                ])}
              />
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("finance.payments.noApplications")}
              </p>
            )}
            {canWrite && peek.state !== "Canceled" && open.length > 0 ? (
              <ApplyPaymentForm
                org={ctx.org.slug}
                paymentId={peek.id}
                currency={peek.currency}
                invoices={open.map((i) => ({
                  value: i.id,
                  label: `${i.number ?? t("finance.payments.unnumbered")} · ${c.money(i.totalMinor === null ? null : i.totalMinor - i.appliedMinor, i.currency)}`,
                }))}
              />
            ) : null}
          </Section>
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("payment", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.payments" id={peek.id} canUpload={canWrite} />
        </>
      ),
    };
  }

  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={PAYMENT_STATES.map((s) => ({ value: s, label: c.state("payment", s) }))}
      above={<Tabs page={page} active="payments" t={t} />}
      columns={[
        { key: "paid", label: t("finance.payments.fields.paidOn") },
        { key: "party", label: t("finance.payments.fields.counterparty"), wrap: true },
        { key: "direction", label: t("finance.payments.fields.direction") },
        { key: "reference", label: t("finance.payments.fields.reference"), type: "code" },
        { key: "amount", label: t("finance.common.amount"), type: "number" },
        { key: "applied", label: t("finance.payments.applied"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((p) => ({
        id: p.id,
        recordKey: p.reference ?? c.date(p.paidOn),
        title: payee(p),
        state: iconState(p.state),
        stateLabel: c.state("payment", p.state),
        next: c.money(p.amountMinor, p.currency),
      }))}
      detail={detail}
      sheet={
        query.create && canWrite ? (
          <FormSheet title={t("finance.payments.create")} flag="create">
            <PaymentForm
              org={ctx.org.slug}
              counterparties={counterparties.data.map((p) => ({
                value: p.id,
                label: p.name ?? t("finance.common.unnamedCounterparty"),
              }))}
              currencies={[...c.exponents.keys()].sort()}
              defaultCurrency="USD"
              today={new Date().toISOString().slice(0, 10)}
            />
          </FormSheet>
        ) : null
      }
    />
  );
}

async function SettlementsTab({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.payments").node.label);
  const empty = {
    icon: "Handshake",
    sentence: t("finance.settlements.empty"),
    actionLabel: t("finance.settlements.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.settlements.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.invoice.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.invoice.read" />;
  }
  const db = ctx.viewer.db;
  const scope = { orgId: ctx.org.id, projectId: page.project?.id ?? null };
  const [settlements, engagements, counterparties] = await Promise.all([
    listSettlements(db, scope),
    listEngagementRefs(db, scope),
    listCounterparties(db, ctx.org.id),
  ]);
  if (!settlements.ok || !engagements.ok || !counterparties.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.settlements.loadError")} />
    );
  }
  const canWrite = access.can("finance.invoice.write");
  const canApprove = access.can("finance.invoice.approve");
  const canPay = access.can("finance.payment.write");
  const me = ctx.viewer.person?.id ?? null;
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const partyName = new Map(counterparties.data.map((p) => [p.id, p.name ?? ""]));
  const engagementLabel = new Map(
    engagements.data.map((e) => [
      e.id,
      `${projectKey.get(e.projectId) ?? ""} · ${(e.counterpartyId && partyName.get(e.counterpartyId)) || e.personName || ""} · ${e.roleType}`,
    ]),
  );
  const term = query.q?.toLowerCase() ?? null;
  const shown = settlements.data.filter(
    (s) =>
      (!query.state || s.state === query.state) &&
      (term === null || s.title.toLowerCase().includes(term)),
  );
  const keyOf = (s: { projectId: string; number: number }) =>
    `${projectKey.get(s.projectId) ?? ""}-ST${s.number}`;

  const peek = query.peek ? settlements.data.find((s) => s.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const [lines, ledger] = await Promise.all([
      listSettlementLines(db, peek.id),
      listTransitions(db, "settlement_state_transitions", peek.id),
    ]);
    const editable = peek.state === "Proposed" && canWrite;
    const allowed = SETTLEMENT_ORG_NEXT[peek.state].filter((n) =>
      n === "Submitted" ? canApprove && peek.createdBy !== me : n === "Paid" ? canPay : canWrite,
    );
    detail = {
      kindLabel: t("finance.settlements.kind"),
      recordKey: keyOf(peek),
      title: peek.title,
      state: iconState(peek.state),
      stateLabel: c.state("settlement", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        {
          label: t("finance.settlements.net"),
          value:
            peek.unpricedCount > 0
              ? t("finance.settlements.unpricedNet", { count: peek.unpricedCount })
              : c.money(peek.netMinor, peek.currency),
        },
        {
          label: t("finance.settlements.fields.engagement"),
          value: engagementLabel.get(peek.engagementId) ?? "",
        },
        {
          label: t("finance.settlements.fields.settledOn"),
          value: c.date(peek.settledOn) || t("finance.common.none"),
        },
      ],
      content: (
        <>
          <TransitionBar
            org={ctx.org.slug}
            lifecycle="settlement"
            id={peek.id}
            state={peek.state}
            allowed={allowed}
          />
          {peek.state === "Submitted" ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("finance.settlements.awaitingParty")}
            </p>
          ) : null}
          <Section id="settlement-lines" title={t("finance.settlements.lines")}>
            {lines.ok && lines.data.length > 0 ? (
              <SimpleTable
                caption={t("finance.settlements.lines")}
                head={[
                  t("finance.settlements.fields.kind"),
                  t("finance.common.description"),
                  t("finance.common.amount"),
                  ...(editable ? [t("finance.common.actions")] : []),
                ]}
                numeric={[2]}
                rows={lines.data.map((l) => [
                  t(`finance.settlements.kinds.${l.kind}`),
                  l.description,
                  ["Deduction", "Withholding"].includes(l.kind) && l.amountMinor !== null
                    ? c.money(-l.amountMinor, peek.currency)
                    : c.money(l.amountMinor, peek.currency),
                  ...(editable
                    ? [
                        <InlineActionButton
                          key="d"
                          action={saveSettlementLineAction}
                          fields={{ org: ctx.org.slug, id: l.id, delete: "1" }}
                          label={t("finance.common.remove")}
                          icon="Trash2"
                        />,
                      ]
                    : []),
                ])}
                foot={[
                  t("finance.settlements.net"),
                  "",
                  c.money(peek.netMinor, peek.currency),
                  ...(editable ? [""] : []),
                ]}
              />
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">
                {editable ? t("finance.settlements.noLines") : t("finance.settlements.noLinesRead")}
              </p>
            )}
            {editable ? (
              <SettlementLineForm
                org={ctx.org.slug}
                settlementId={peek.id}
                currency={peek.currency}
                kinds={SETTLEMENT_LINE_KINDS.map((k) => ({
                  value: k,
                  label: t(`finance.settlements.kinds.${k}`),
                }))}
              />
            ) : null}
          </Section>
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("settlement", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.settlements" id={peek.id} canUpload={canWrite} />
        </>
      ),
    };
  }

  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={SETTLEMENT_STATES.map((s) => ({ value: s, label: c.state("settlement", s) }))}
      above={<Tabs page={page} active="settlements" t={t} />}
      columns={[
        { key: "key", label: t("finance.common.key"), type: "code" },
        { key: "title", label: t("finance.settlements.fields.title"), wrap: true },
        { key: "engagement", label: t("finance.settlements.fields.engagement"), wrap: true },
        { key: "net", label: t("finance.settlements.net"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={shown.map((s) => ({
        id: s.id,
        key: keyOf(s),
        title: s.title,
        engagement: engagementLabel.get(s.engagementId) ?? "",
        net: c.money(s.netMinor, s.currency),
        state: { state: iconState(s.state), label: c.state("settlement", s.state) },
      }))}
      listItems={shown.map((s) => ({
        id: s.id,
        recordKey: keyOf(s),
        title: s.title,
        state: iconState(s.state),
        stateLabel: c.state("settlement", s.state),
        next: c.money(s.netMinor, s.currency),
      }))}
      detail={detail}
      sheet={
        query.create && canWrite ? (
          <FormSheet title={t("finance.settlements.create")} flag="create">
            <SettlementForm
              org={ctx.org.slug}
              engagements={engagements.data.map((e) => ({
                value: e.id,
                label: engagementLabel.get(e.id) ?? e.id,
              }))}
              currencies={[...c.exponents.keys()].sort()}
              defaultCurrency={page.project?.currency || "USD"}
            />
          </FormSheet>
        ) : null
      }
    />
  );
}
