import type * as Finance from "@xos/data/finance";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B12 (RRR-236, Run 7 item 5): a recording's page-level notice comes from the action's own redirect, since the sheet that
 * holds the form can leave in the same commit as the refresh. A refusal stays on the form, with no redirect.
 */
const seen = vi.hoisted(() => ({
  redirect: vi.fn((to: string, _type?: string) => {
    throw new Error(`redirect:${to}`);
  }),
  record: vi.fn(),
  void: vi.fn(),
  credit: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  redirect: seen.redirect,
  RedirectType: { push: "push", replace: "replace" },
}));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: () => undefined } } }));
vi.mock("@/lib/finance/money", () => ({
  exponentOf: () => 2,
  getExponents: async () => ({}),
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: "o", slug: "demo" }, viewer: { db: {} } }),
}));
vi.mock("@xos/data/crew", () => ({ recordPerDiemPayments: vi.fn() }));
vi.mock("@xos/data/finance", async (importOriginal) => ({
  ...(await importOriginal<typeof Finance>()),
  recordExpenseReimbursement: seen.record,
  voidExpenseReimbursement: seen.void,
  createExpenseCredit: seen.credit,
}));

const { recordReimbursementAction, saveExpenseCreditAction, voidReimbursementAction } =
  await import("@/app/[org]/finance/payables-actions");

const id = "0192f3a0-0000-7000-8000-000000000001";
const formOf = (values: Record<string, string>) => {
  const form = new FormData();
  form.set("org", "demo");
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
};
const recording = (returnTo: string) =>
  formOf({ payeePersonId: id, expenseIds: id, paidOn: "2027-06-01", reference: "", returnTo });

describe("payables recordings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects with the notice, even when the recording empties the list", async () => {
    seen.record.mockResolvedValue({ ok: true, data: id });
    const to = "/demo/finance/payments?tab=reimbursements&notice=reimbursementRecorded";
    await expect(recordReimbursementAction({}, recording(to))).rejects.toThrow(`redirect:${to}`);
    expect(seen.redirect).toHaveBeenCalledWith(to, "replace");
  });

  it("stays on the form when refused, so what was typed is kept", async () => {
    seen.void.mockResolvedValue({
      ok: false,
      error: { kind: "refusal", rule: "expense_reimbursement_voided", message: "Already voided." },
    });
    const state = await voidReimbursementAction(
      {},
      formOf({ id, reason: "Returned.", returnTo: "/demo/finance/payments?notice=x" }),
    );
    expect(state.error).toMatchObject({ rule: "expense_reimbursement_voided" });
    expect(seen.redirect).not.toHaveBeenCalled();
  });

  it("never redirects outside the org", async () => {
    seen.record.mockResolvedValue({ ok: true, data: id });
    const state = await recordReimbursementAction({}, recording("https://evil.example/demo/x"));
    expect(state.ok).toBe(true);
    expect(seen.redirect).not.toHaveBeenCalled();
  });

  it("opens a new credit from the redirect, since only the server knows its id", async () => {
    seen.credit.mockResolvedValue({ ok: true, data: { id } });
    const form = formOf({
      originalId: id,
      description: "Refund.",
      incurredOn: "2027-06-01",
      amount: "10.00",
      currency: "USD",
      returnTo: "/demo/finance/expenses?peek=old",
    });
    await expect(saveExpenseCreditAction({}, form)).rejects.toThrow(
      `redirect:/demo/finance/expenses?peek=${id}`,
    );
  });

  it("asks for at least one charge in copy the catalog holds", async () => {
    const form = formOf({ payeePersonId: id, paidOn: "2027-06-01", reference: "" });
    const state = await recordReimbursementAction({}, form);
    expect(state.fieldErrors).toEqual({ expenseIds: "expenseIds" });
    const { getMessages } = await import("@xos/i18n");
    for (const locale of ["en-US", "es-US"] as const) {
      const { finance } = getMessages(locale) as unknown as {
        finance: { errors: { fields: Record<string, string> } };
      };
      expect(finance.errors.fields["expenseIds"]).toBeTruthy();
      expect(finance.errors.fields["perDiemIds"]).toBeTruthy();
    }
  });
});
