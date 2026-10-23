import {
  CHANGE_ORDER_STATES,
  EXPENSE_STATES,
  INVOICE_STATES,
  type Invoice,
} from "@xos/data/finance";
import type { FinancePage } from "@/lib/finance/context";
import type { FinanceCopy } from "@/lib/finance/copy";
import type { AskCatalog, AskField } from "./ask";

/**
 * The filters the finance collections read, offered to Ask in plain language (A95). Each meaning
 * is written for the model in English and names only what the page applies; labels and values are
 * the person's own. The same parameters drive the pages, so an applied filter is an ordinary link.
 */

/** Invoices the org still has to settle or collect whose due date has passed (Section 4.5.5). */
export const OVERDUE_STATES: ReadonlySet<Invoice["state"]> = new Set([
  "Issued",
  "Approved",
  "Disputed",
]);

/**
 * True for an invoice past due on the org's calendar: due before today there (never the UTC date,
 * A71), not yet fully paid (an unpriced total counts as unpaid), and Issued, Approved or Disputed.
 */
export function isOverdue(invoice: Invoice, today: string): boolean {
  if (invoice.dueOn === null || !OVERDUE_STATES.has(invoice.state)) return false;
  const balance = invoice.totalMinor === null ? null : invoice.totalMinor - invoice.appliedMinor;
  return invoice.dueOn.slice(0, 10) < today && (balance === null || balance > 0);
}

function stateField(
  c: FinanceCopy,
  lifecycle: "invoice" | "expense" | "change_order",
  states: readonly string[],
  noun: string,
): AskField {
  return {
    name: "state",
    label: c.t("finance.common.state"),
    type: "enum",
    values: states.map((s) => ({ value: s, label: c.state(lifecycle, s) })),
    description: `The ${noun}'s state in its lifecycle.`,
    op: "eq",
  };
}

function projectField(page: FinancePage, c: FinanceCopy): AskField[] {
  if (page.inProject || page.projects.length === 0) return [];
  return [
    {
      name: "project",
      label: c.t("finance.common.project"),
      type: "enum",
      values: page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
      description: "The project key, such as NWS. Use it only when the sentence names a project.",
      op: "eq",
    },
  ];
}

function searchField(c: FinanceCopy, description: string): AskField {
  return {
    name: "q",
    label: c.t("finance.common.search"),
    type: "string",
    description,
    op: "contains",
  };
}

export function invoiceAsk(page: FinancePage, c: FinanceCopy): AskCatalog {
  const yesNo = [
    { value: "true", label: c.t("aurora.entry.ask.yes") },
    { value: "false", label: c.t("aurora.entry.ask.no") },
  ];
  return {
    collection: "invoices",
    label: c.t("aurora.entry.ask.collections.invoices"),
    fields: [
      stateField(c, "invoice", INVOICE_STATES, "invoice"),
      {
        name: "direction",
        label: c.t("finance.invoices.fields.direction"),
        type: "enum",
        values: ["Payable", "Receivable"].map((d) => ({
          value: d,
          label: c.t(`finance.invoices.directionShort.${d}`),
        })),
        description:
          "Payable: a bill the org received and owes. Receivable: an invoice the org issued and is owed.",
        op: "eq",
      },
      {
        name: "overdue",
        label: c.t("aurora.entry.ask.fields.overdue"),
        type: "boolean",
        values: yesNo,
        description:
          "true keeps unpaid Issued, Approved or Disputed invoices whose due date is before today on the org's calendar.",
        op: "eq",
      },
      ...projectField(page, c),
      searchField(
        c,
        "Text matched against the invoice number and the name of the party, such as a vendor, a client or an individual payee. Use it for a party's name.",
      ),
    ],
  };
}

export function expenseAsk(page: FinancePage, c: FinanceCopy): AskCatalog {
  return {
    collection: "expenses",
    label: c.t("aurora.entry.ask.collections.expenses"),
    fields: [
      stateField(c, "expense", EXPENSE_STATES, "expense"),
      ...projectField(page, c),
      searchField(c, "Text matched against the expense's description and its budget line."),
    ],
  };
}

export function changeOrderAsk(page: FinancePage, c: FinanceCopy): AskCatalog {
  return {
    collection: "change-orders",
    label: c.t("aurora.entry.ask.collections.changeOrders"),
    fields: [
      stateField(c, "change_order", CHANGE_ORDER_STATES, "change order"),
      ...projectField(page, c),
      searchField(c, "Text matched against the change order's title and its key, such as NWS-CO3."),
    ],
  };
}
