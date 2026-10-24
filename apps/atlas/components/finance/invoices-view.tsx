import {
  INVOICE_STATES,
  listBudgetLineRefs,
  listCounterparties,
  listInvoiceLines,
  listInvoices,
  listTransitions,
  type Invoice,
  type InvoiceState,
} from "@xos/data/finance";
import { listEngagementRefs } from "@xos/data/settlements";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { invoiceAsk, isOverdue } from "@/lib/aurora/finance-ask";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { saveInvoiceLineAction } from "@/app/[org]/finance/actions";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { InvoiceForm } from "./forms-invoice-form";
import { InvoiceLineForm } from "./forms-invoice-line-form";
import { RecordPaymentForm } from "./forms-record-payment-form";
import { SelfBillForm } from "./forms-self-bill-form";
import { EditButton } from "./kit-edit-button";
import { FormSheet } from "./kit-form-sheet";
import { LineDeleteButton } from "./kit-line-delete-button";
import { TransitionBar } from "./kit-transition-bar";
import { type Row } from "./kit.types";
import { RecordActivity, RecordCollab } from "./record";
import { DocumentActions } from "@/components/documents/document-actions";
import { ButtonLink } from "@/components/ui";
import { LiveRefresh } from "@/components/live/live-refresh";

/**
 * Finance > Invoices (Section 4.5.5): receivables the org issues and payables it receives. A
 * receivable posts to the ledger when Issued and a payable when fully Approved (A03F, 0362); an
 * invoice with an unpriced line can be neither, and approval runs spend authority and refuses the
 * person who recorded it. Payables can also be generated from approved timesheets under a party's
 * self-billing agreement (Section 4.4.5).
 */
export async function InvoicesView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.invoices").node.label);
  const empty = {
    icon: "FileText",
    sentence: page.project
      ? t("finance.invoices.emptyProject", { project: page.project.key })
      : t("finance.invoices.empty"),
    actionLabel: t("finance.invoices.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.invoices.create"),
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
  const [invoices, counterparties] = await Promise.all([
    listInvoices(db, scope),
    listCounterparties(db, ctx.org.id),
  ]);
  if (!invoices.ok || !counterparties.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.invoices.loadError")} />
    );
  }
  const canWrite = access.can("finance.invoice.write");
  const canApprove = access.can("finance.invoice.approve");
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const partyName = new Map(
    counterparties.data.map((p) => [p.id, p.name ?? t("finance.common.unnamedCounterparty")]),
  );
  /** The payee: the counterparty, or the person engaged as an individual (A38-007). */
  const payee = (i: Invoice) =>
    i.counterpartyId !== null
      ? (partyName.get(i.counterpartyId) ?? "")
      : i.payeeName
        ? t("finance.payments.individualPayee", { name: i.payeeName })
        : t("finance.invoices.individual");
  const canPay = access.can("finance.payment.write");
  const keyOf = (i: Invoice) =>
    i.number ??
    `${projectKey.get(i.projectId) ?? ""} · ${t(`finance.invoices.directionShort.${i.direction}`)}`;
  const term = query.q?.toLowerCase() ?? null;
  const direction = query.extra["direction"] ?? null;
  // Overdue reads the org's calendar, never the UTC date (A71); a plain-language filter sets it (A95).
  const overdue = query.extra["overdue"] ?? null;
  const today = overdue === null ? null : await orgToday(ctx);
  const shown = invoices.data.filter(
    (i) =>
      (!query.state || i.state === query.state) &&
      (!direction || i.direction === direction) &&
      (today === null || isOverdue(i, today) === (overdue === "true")) &&
      (term === null ||
        (i.number ?? "").toLowerCase().includes(term) ||
        payee(i).toLowerCase().includes(term)),
  );
  const balance = (i: Invoice) => (i.totalMinor === null ? null : i.totalMinor - i.appliedMinor);
  const rows: Row[] = shown.map((i) => ({
    id: i.id,
    label: keyOf(i),
    number: i.number ?? "",
    direction: t(`finance.invoices.directionShort.${i.direction}`),
    party: payee(i),
    project: projectKey.get(i.projectId) ?? "",
    issued: c.date(i.issuedOn),
    due: c.date(i.dueOn),
    total: c.money(i.totalMinor, i.currency),
    balance: c.money(balance(i), i.currency),
    state: { state: iconState(i.state), label: c.state("invoice", i.state) },
  }));

  const nextFor = (i: Invoice): InvoiceState[] => {
    const moves: Record<InvoiceState, InvoiceState[]> = {
      Proposed: i.direction === "Receivable" ? ["Issued", "Canceled"] : ["Approved", "Canceled"],
      Issued: ["Disputed", "Canceled"],
      Approved: ["Disputed"],
      Disputed: i.direction === "Receivable" ? ["Issued", "Canceled"] : ["Approved", "Canceled"],
      Canceled: [],
    };
    return moves[i.state].filter((n) => (n === "Approved" ? canApprove : canWrite));
  };

  /** Money can be recorded against an approved payable or an issued receivable with a balance. */
  const payable = (i: Invoice) =>
    canPay &&
    (i.state === "Approved" || i.state === "Issued") &&
    i.totalMinor !== null &&
    i.totalMinor - i.appliedMinor > 0;
  const peek = query.peek ? invoices.data.find((i) => i.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const [lines, ledger, budgetLines] = await Promise.all([
      listInvoiceLines(db, peek.id),
      listTransitions(db, "invoice_state_transitions", peek.id),
      listBudgetLineRefs(db, { orgId: ctx.org.id, projectId: peek.projectId }),
    ]);
    const editable = peek.state === "Proposed" && canWrite;
    detail = {
      kindLabel: t(`finance.invoices.kind.${peek.direction}`),
      recordKey: keyOf(peek),
      title: payee(peek) || keyOf(peek),
      state: iconState(peek.state),
      stateLabel: c.state("invoice", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        {
          label: t("finance.common.total"),
          value:
            peek.unpricedCount > 0
              ? t("finance.invoices.unpricedTotal", { count: peek.unpricedCount })
              : c.money(peek.totalMinor, peek.currency),
        },
        { label: t("finance.invoices.tax"), value: c.money(peek.taxMinor, peek.currency) },
        { label: t("finance.invoices.applied"), value: c.money(peek.appliedMinor, peek.currency) },
        { label: t("finance.invoices.balance"), value: c.money(balance(peek), peek.currency) },
        {
          label: t("finance.invoices.fields.issuedOn"),
          value: c.date(peek.issuedOn) || t("finance.common.none"),
        },
        {
          label: t("finance.invoices.fields.dueOn"),
          value: c.date(peek.dueOn) || t("finance.common.none"),
        },
        { label: t("finance.common.project"), value: projectKey.get(peek.projectId) ?? "" },
      ],
      content: (
        <>
          <div className="flex flex-wrap gap-8">
            <DocumentActions org={ctx.org.slug} kind="invoice" id={peek.id} />
            <TransitionBar
              org={ctx.org.slug}
              lifecycle="invoice"
              id={peek.id}
              state={peek.state}
              allowed={nextFor(peek)}
            />
            {editable ? <EditButton label={t("finance.common.edit")} /> : null}
            {/* A button like its neighbours, not an underlined link (A59-029). */}
            {payable(peek) ? (
              <ButtonLink href={withQuery(page, { pay: "1" })}>
                {t("finance.invoices.recordPayment")}
              </ButtonLink>
            ) : null}
          </div>
          <p className="m-0 text-text-12 text-text-secondary">
            {t(
              peek.direction === "Receivable"
                ? "finance.invoices.postsWhenIssued"
                : "finance.invoices.postsWhenApproved",
            )}
          </p>
          <Section id="invoice-lines" title={t("finance.invoices.lines")}>
            {lines.ok && lines.data.length > 0 ? (
              <SimpleTable
                caption={t("finance.invoices.lines")}
                head={[
                  t("finance.common.description"),
                  t("finance.budgets.columns.quantity"),
                  t("finance.budgets.columns.unitPrice"),
                  t("finance.budgets.columns.extended"),
                  ...(editable ? [t("finance.common.actions")] : []),
                ]}
                numeric={[1, 2, 3]}
                rows={lines.data.map((l) => [
                  l.description,
                  c.number(l.quantity),
                  c.money(l.unitPriceMinor, peek.currency),
                  c.money(l.extendedMinor, peek.currency),
                  ...(editable
                    ? [
                        <LineDeleteButton
                          key="d"
                          action={saveInvoiceLineAction}
                          org={ctx.org.slug}
                          id={l.id}
                          description={l.description}
                          label={t("finance.common.remove")}
                        />,
                      ]
                    : []),
                ])}
              />
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">
                {editable ? t("finance.invoices.noLines") : t("finance.invoices.noLinesRead")}
              </p>
            )}
            {editable && budgetLines.ok ? (
              <InvoiceLineForm
                org={ctx.org.slug}
                invoiceId={peek.id}
                currency={peek.currency}
                budgetLines={budgetLines.data.map((l) => ({
                  value: l.id,
                  label: `${l.budgetName} · ${l.lineNumber} ${l.description}`,
                }))}
              />
            ) : null}
          </Section>
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("invoice", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.invoices" id={peek.id} canUpload={canWrite} />
        </>
      ),
    };
  }

  const currencies = [...c.exponents.keys()].sort();
  const parties = counterparties.data.map((p) => ({
    value: p.id,
    label: p.name ?? t("finance.common.unnamedCounterparty"),
  }));
  let sheet = null;
  if (query.create && canWrite) {
    sheet = (
      <FormSheet title={t("finance.invoices.create")} flag="create">
        <InvoiceForm
          org={ctx.org.slug}
          projects={page.projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
          projectId={page.project?.id ?? null}
          counterparties={parties}
          currencies={currencies}
          defaultCurrency={page.project?.currency || "USD"}
        />
      </FormSheet>
    );
  } else if (query.edit && peek && peek.state === "Proposed" && canWrite) {
    sheet = (
      <FormSheet title={t("finance.invoices.edit")} flag="edit">
        <InvoiceForm
          org={ctx.org.slug}
          projects={[]}
          projectId={peek.projectId}
          counterparties={parties}
          currencies={currencies}
          defaultCurrency={peek.currency}
          invoice={{ id: peek.id, number: peek.number, issuedOn: peek.issuedOn, dueOn: peek.dueOn }}
        />
      </FormSheet>
    );
  } else if (query.extra["pay"] === "1" && peek && payable(peek)) {
    sheet = (
      <FormSheet title={t("finance.invoices.recordPayment")} flag="pay">
        <RecordPaymentForm
          org={ctx.org.slug}
          invoiceId={peek.id}
          currency={peek.currency}
          today={await orgToday(ctx)}
        />
      </FormSheet>
    );
  } else if (query.extra["selfbill"] === "1" && canWrite) {
    const engagements = await listEngagementRefs(db, scope);
    sheet = (
      <FormSheet title={t("finance.invoices.selfBill")} flag="selfbill">
        <SelfBillForm
          org={ctx.org.slug}
          engagements={(engagements.ok ? engagements.data : []).map((e) => ({
            value: e.id,
            label: `${projectKey.get(e.projectId) ?? ""} · ${partyName.get(e.counterpartyId ?? "") ?? e.personName ?? ""} · ${e.roleType}`,
          }))}
        />
      </FormSheet>
    );
  }

  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={INVOICE_STATES.map((s) => ({ value: s, label: c.state("invoice", s) }))}
      bulk={
        canWrite || canApprove
          ? {
              org: ctx.org.slug,
              resource: "invoices",
              // Approve a queue in one go (Section 11.11): every rule of a single approval applies.
              fields: [
                {
                  key: "invoice_state",
                  label: t("finance.common.state"),
                  reason: true,
                  options: (["Approved", "Disputed", "Canceled"] as const)
                    .filter((s) => (s === "Approved" ? canApprove : canWrite))
                    .map((s) => ({ value: s, label: c.state("invoice", s) })),
                },
              ],
            }
          : null
      }
      above={
        <>
          {/* Invoices update live as approvals and payments land (Section 11.7, ADR 0044). */}
          <LiveRefresh
            topics={[
              {
                table: "invoices",
                filter: page.project
                  ? `project_id=eq.${page.project.id}`
                  : `org_id=eq.${ctx.org.id}`,
              },
            ]}
          />
          <nav
            aria-label={t("finance.invoices.directionFilter")}
            className="flex flex-wrap items-center gap-8 text-text-13"
          >
            {[null, "Payable", "Receivable"].map((d) => (
              <Link
                key={d ?? "all"}
                href={withQuery(page, { direction: d, peek: null }) as Route}
                aria-current={direction === d ? "true" : undefined}
                className="rounded-chip border border-border-subtle px-8 py-2 text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
              >
                {d
                  ? t(`finance.invoices.directionShort.${d}`)
                  : t("finance.invoices.allDirections")}
              </Link>
            ))}
            {canWrite ? (
              <Link
                className="ms-auto text-text-13 text-accent-text underline"
                href={withQuery(page, { selfbill: "1" }) as Route}
              >
                {t("finance.invoices.selfBill")}
              </Link>
            ) : null}
          </nav>
        </>
      }
      columns={[
        { key: "number", label: t("finance.invoices.fields.number"), type: "code" },
        { key: "direction", label: t("finance.invoices.fields.direction") },
        { key: "party", label: t("finance.invoices.fields.counterparty"), wrap: true },
        { key: "project", label: t("finance.common.project"), type: "code" },
        { key: "issued", label: t("finance.invoices.fields.issuedOn") },
        { key: "due", label: t("finance.invoices.fields.dueOn") },
        { key: "total", label: t("finance.common.total"), type: "number" },
        { key: "balance", label: t("finance.invoices.balance"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((i) => ({
        id: i.id,
        recordKey: keyOf(i),
        title: payee(i) || keyOf(i),
        state: iconState(i.state),
        stateLabel: c.state("invoice", i.state),
        next: c.money(i.totalMinor, i.currency),
      }))}
      board={INVOICE_STATES.map((s) => ({
        state: iconState(s),
        label: c.state("invoice", s),
        cards: shown
          .filter((i) => i.state === s)
          .map((i) => ({
            key: i.id,
            title: `${keyOf(i)} · ${payee(i)}`,
            meta: c.money(i.totalMinor, i.currency),
          })),
      }))}
      detail={detail}
      sheet={sheet}
      ask={invoiceAsk(page, c)}
    />
  );
}
