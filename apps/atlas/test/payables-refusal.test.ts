import { describe, expect, it, vi } from "vitest";
import type { FinancePage } from "@/lib/finance/context";

/**
 * B12 (RRR-236, acceptance 24): each payables tab shows the refusal panel by its own app.can_* function, never by holding
 * one capability at any reach. Every system role that sees the page holds them all, so a custom role is the reader here.
 */
vi.mock("@xos/data/finance", () => ({
  PAYMENT_DUE_BUCKETS: [],
  canReadPaymentsDue: async () => false,
  canReadReimbursements: async () => false,
  canRecordPayments: async () => false,
  groupPaymentsDue: () => [],
  listCounterparties: async () => ({ ok: true, data: [] }),
  listOwedExpenses: async () => ({ ok: true, data: [] }),
  listPaymentsDue: async () => ({ ok: true, data: [] }),
  listReimbursementBalances: async () => ({ ok: true, data: [] }),
  listReimbursements: async () => ({ ok: true, data: [] }),
  paymentDueBucket: () => "undated",
}));
vi.mock("@xos/data/settlements", () => ({
  canReadEngagementCosts: async () => false,
  listEngagementCostItems: async () => ({ ok: true, data: [] }),
  listEngagementCosts: async () => ({ ok: true, data: [] }),
}));
vi.mock("@xos/data/person-names", () => ({ personNames: async () => new Map() }));
vi.mock("@xos/ia", () => ({ getNode: () => ({ node: { label: "payments" } }) }));
vi.mock("@/components/ui", () => ({ ButtonLink: () => null }));
vi.mock("@/lib/finance/context", () => ({ withQuery: () => "" }));
vi.mock("@/lib/finance/copy", () => ({
  getFinanceCopy: async () => ({ t: (key: string) => key, money: () => "", date: () => "" }),
}));
vi.mock("@/lib/finance/money", () => ({ exponentOf: () => 2 }));
vi.mock("@/lib/shell/sitemap", () => ({ sitemap: {} }));
vi.mock("@/lib/shell/time-zone", () => ({
  getOrgWeekStart: async () => 1,
  orgToday: async () => "2027-06-01",
}));
vi.mock("@/components/finance/collection", () => ({ FinanceCollection: () => null }));
vi.mock("@/components/finance/figures", () => ({ Section: () => null, SimpleTable: () => null }));
vi.mock("@/components/finance/kit-form-sheet", () => ({ FormSheet: () => null }));
vi.mock("@/components/finance/payments-tabs", () => ({
  PaymentTabs: () => null,
  PaymentsNotice: () => null,
}));
vi.mock("@/components/finance/forms-record-reimbursement-form", () => ({
  RecordReimbursementForm: () => null,
}));
vi.mock("@/components/finance/forms-void-reimbursement-form", () => ({
  VoidReimbursementForm: () => null,
}));
vi.mock("@/components/finance/forms-mark-per-diems-paid-form", () => ({
  MarkPerDiemsPaidForm: () => null,
}));

const { PaymentsDueTab } = await import("@/components/finance/payments-due-tab");
const { ReimbursementsTab } = await import("@/components/finance/reimbursements-tab");
const { ActCostsTab } = await import("@/components/finance/act-costs-tab");

const page = {
  ctx: { org: { id: "o", slug: "demo" }, viewer: { db: {}, person: { id: "me" } } },
  query: { extra: {}, q: null, state: null, peek: null },
  project: { id: "p", key: "NWS" },
} as unknown as FinancePage;

describe("payables tabs for a reader without the capabilities", () => {
  it.each([
    ["due", PaymentsDueTab, "finance.payment.read"],
    ["reimbursements", ReimbursementsTab, "finance.payment.read"],
    ["act costs", ActCostsTab, "finance.invoice.read"],
  ])("%s shows the refusal panel and reads nothing else", async (_name, Tab, capability) => {
    const element = await Tab({ page });
    expect(element.props).toMatchObject({ refusal: capability, rows: [], canCreate: false });
  });
});
