import type { SupabaseClient } from "@supabase/supabase-js";
import { createAuroraClient } from "@xos/ai/client";
import { getMessages, locales } from "@xos/i18n";
import { admits, type DownloadScope, type Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { SupabaseUploader } from "../src/data/uploader";
import { access, type CompassIdentity } from "../src/domain/access";
import {
  amountText,
  applyProposal,
  buildReceiptSave,
  draftProblems,
  formatMoney,
  isIsoDay,
  myExpenses,
  parseAmount,
  postableLines,
  readReceipt,
  receiptExtractionRequest,
  receiptPath,
  receiptProposal,
  RECEIPT_FILE_NAME,
  type BudgetLineRow,
  type ReceiptReader,
  type SuggestionField,
} from "../src/domain/expenses";
import { summarizeMutation } from "../src/domain/queue-summary";

const ORG = "01920000-0000-7000-8000-000000000001";
const PROJECT = "01920000-0000-7000-8000-000000001001";

function line(over: Partial<BudgetLineRow> = {}): BudgetLineRow {
  return {
    id: "line-1",
    org_id: ORG,
    project_id: PROJECT,
    budget_name: "Working Budget",
    currency_code: "USD",
    is_baseline: false,
    line_number: 1,
    description: "Crew catering",
    ...over,
  };
}

const FIELDS: SuggestionField[] = [
  {
    field_path: "description",
    proposed_value: "Ice and water",
    confidence: 0.92,
    refusal: null,
    missing: null,
  },
  {
    field_path: "amount_minor",
    proposed_value: 4250,
    confidence: 0.88,
    refusal: null,
    missing: null,
  },
  { field_path: "currency", proposed_value: "USD", confidence: 0.99, refusal: null, missing: null },
  {
    field_path: "incurred_on",
    proposed_value: null,
    confidence: null,
    refusal: "NO_ANSWER",
    missing: "The document does not show this value, so it was not guessed.",
  },
];

describe("money and dates on the expense form", () => {
  it("reads amounts the way people type them, in the currency's minor unit", () => {
    expect(parseAmount("42.50", "USD")).toBe(4250);
    expect(parseAmount("42,50", "USD")).toBe(4250);
    expect(parseAmount("$ 1,234.56", "USD")).toBe(123456);
    expect(parseAmount("1.234,56", "EUR")).toBe(123456);
    expect(parseAmount("1,234", "USD")).toBe(123400);
    expect(parseAmount("12", "USD")).toBe(1200);
    expect(parseAmount("1500", "JPY")).toBe(1500);
    expect(parseAmount("15.5", "JPY")).toBeNull();
    expect(parseAmount("1.250", "KWD")).toBe(1250);
    expect(parseAmount("4.255", "USD")).toBe(425500);
    expect(parseAmount("0", "USD")).toBeNull();
    expect(parseAmount("", "USD")).toBeNull();
    expect(parseAmount("abc", "USD")).toBeNull();
    expect(parseAmount("1.2.3", "USD")).toBeNull();
  });

  it("writes minor units back as the amount a person would type, and as money", () => {
    expect(amountText(4250, "USD")).toBe("42.50");
    expect(amountText(5, "USD")).toBe("0.05");
    expect(amountText(1500, "JPY")).toBe("1500");
    expect(formatMoney(4250, "USD", "en-US")).toBe("$42.50");
    expect(formatMoney(-1999, "USD", "en-US")).toBe("-$19.99");
    expect(formatMoney(1500, "JPY", "en-US")).toBe("¥1,500");
  });

  it("checks the form on the project's calendar", () => {
    expect(isIsoDay("2027-06-10")).toBe(true);
    expect(isIsoDay("2027-02-30")).toBe(false);
    expect(isIsoDay("06/10/2027")).toBe(false);
    const draft = {
      budgetLineId: "line-1",
      description: "Ice",
      amount: "4.25",
      incurredOn: "2027-06-10",
    };
    expect(draftProblems(draft, "USD", "2027-06-10")).toEqual([]);
    // Tomorrow on the project's calendar is the future, even when the phone's zone is already there.
    expect(draftProblems({ ...draft, incurredOn: "2027-06-11" }, "USD", "2027-06-10")).toEqual([
      "future",
    ]);
    expect(
      draftProblems(
        { budgetLineId: null, description: " ", amount: "x", incurredOn: "soon" },
        null,
        "2027-06-10",
      ),
    ).toEqual(["line", "description", "amount", "date"]);
  });

  it("offers the working budget's lines, and the baseline's only when there is nothing else", () => {
    const lines = [
      line({ id: "b1", budget_name: "Baseline", is_baseline: true }),
      line({ id: "w2", line_number: 2 }),
      line({ id: "w1", line_number: 1 }),
      line({ id: "other", project_id: "p-2" }),
    ];
    expect(postableLines(lines, PROJECT).map((l) => l.id)).toEqual(["w1", "w2"]);
    expect(postableLines([lines[0] as BudgetLineRow], PROJECT).map((l) => l.id)).toEqual(["b1"]);
    expect(postableLines(lines, null)).toEqual([]);
  });
});

describe("reading a receipt with Aurora (Section 4.7)", () => {
  function reader(over: Partial<{ [K in keyof ReceiptReader]: ReceiptReader[K] }> = {}) {
    const calls: string[] = [];
    const r: ReceiptReader = {
      status: async () => (
        calls.push("status"),
        {
          ok: true,
          data: {
            enabled_features: ["extraction"],
            used: 3,
            allowance: 500,
            plan_includes_aurora: true,
          },
        }
      ),
      extract: async (input) => (
        calls.push(`extract ${input.kind}`),
        {
          ok: true,
          data: {
            outcome: "answer",
            ai_generated: true,
            request_id: "req-1",
            model: "claude-opus-5-5",
            missing: null,
            failure_code: null,
            answer: null,
            suggestions: [
              {
                suggestion_id: "sug-1",
                operation_id: "expenses.create",
                summary: "Create a receipt record.",
              },
            ],
          },
        }
      ),
      suggestion: async (id) => (
        calls.push(`suggestion ${id}`),
        {
          ok: true,
          data: {
            id,
            operation_id: "expenses.create",
            target_id: null,
            summary: "",
            suggestion_state: "Proposed",
            expires_at: "2027-06-17T00:00:00Z",
            applied_id: null,
            proposed_fields: FIELDS.map((f) => ({
              ...f,
              source_excerpt: null,
              provenance: "agent" as const,
            })),
          },
        }
      ),
      ...over,
    };
    return { r, calls };
  }

  it("sends nothing but the photo and a fixed file name", () => {
    const request = receiptExtractionRequest("AAAA");
    expect(request).toEqual({
      kind: "receipt",
      media_type: "image/jpeg",
      content_base64: "AAAA",
      file_name: RECEIPT_FILE_NAME,
      document_id: null,
    });
    expect(RECEIPT_FILE_NAME).toBe("receipt.jpg");
  });

  it("reads the fields when the org has document extraction on", async () => {
    const { r, calls } = reader();
    const reading = await readReceipt(r, "AAAA", true);
    expect(calls).toEqual(["status", "extract receipt", "suggestion sug-1"]);
    expect(reading.state).toBe("read");
    expect(reading.proposal).toEqual({
      suggestionId: "sug-1",
      description: { value: "Ice and water", confidence: 0.92 },
      amountMinor: { value: 4250, confidence: 0.88 },
      currency: { value: "USD", confidence: 0.99 },
      incurredOn: null,
      missing: { incurred_on: "The document does not show this value, so it was not guessed." },
    });
  });

  it("sends no photo when the switch is off, the plan lacks Aurora, the allowance is used or the phone is offline", async () => {
    const off = reader({
      status: async () => ({
        ok: true,
        data: {
          enabled_features: ["assistant"],
          used: 0,
          allowance: null,
          plan_includes_aurora: true,
        },
      }),
    });
    expect((await readReceipt(off.r, "AAAA", true)).state).toBe("off");
    expect(off.calls).toEqual([]);
    const plan = reader({
      status: async () => ({
        ok: true,
        data: { enabled_features: [], used: 0, allowance: null, plan_includes_aurora: false },
      }),
    });
    expect((await readReceipt(plan.r, "AAAA", true)).state).toBe("not-in-plan");
    const limit = reader({
      status: async () => ({
        ok: true,
        data: {
          enabled_features: ["extraction"],
          used: 500,
          allowance: 500,
          plan_includes_aurora: true,
        },
      }),
    });
    expect((await readReceipt(limit.r, "AAAA", true)).state).toBe("limit");
    expect(limit.calls).toEqual([]);
    const offline = reader();
    expect(await readReceipt(offline.r, "AAAA", false)).toEqual({
      state: "offline",
      proposal: null,
    });
    expect(offline.calls).toEqual([]);
  });

  it("says why when the server refuses or the receipt holds nothing readable", async () => {
    const refused = reader({
      extract: async () => ({
        ok: false,
        problem: { status: 422, rule: "aurora_feature_off", detail: "off" },
      }),
    });
    expect((await readReceipt(refused.r, "AAAA", true)).state).toBe("off");
    const used = reader({
      extract: async () => ({
        ok: false,
        problem: { status: 422, rule: "plan_limit_exceeded", detail: "x" },
      }),
    });
    expect((await readReceipt(used.r, "AAAA", true)).state).toBe("limit");
    const away = reader({
      status: async () => ({
        ok: false,
        problem: { status: 0, rule: null, detail: "Network request failed" },
      }),
    });
    expect((await readReceipt(away.r, "AAAA", true)).state).toBe("failed");
    const silent = reader({
      extract: async () => ({
        ok: true,
        data: {
          outcome: "no_answer",
          ai_generated: true,
          request_id: "req-2",
          model: null,
          missing: "No field could be read.",
          failure_code: null,
          answer: null,
          suggestions: [],
        },
      }),
    });
    expect((await readReceipt(silent.r, "AAAA", true)).state).toBe("no-answer");
  });

  it("calls the public API with the person's own token and only the receipt", async () => {
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get("authorization"),
      });
      if (url.endsWith("/aurora/status"))
        return new Response(
          JSON.stringify({
            enabled_features: ["extraction"],
            used: 0,
            allowance: null,
            plan_includes_aurora: true,
          }),
        );
      return new Response(
        JSON.stringify({ outcome: "no_answer", ai_generated: true, suggestions: [] }),
      );
    }) as typeof fetch;
    const client = createAuroraClient({
      baseUrl: "https://atlas.test/api/v1",
      fetch: fetchImpl,
      headers: () => ({ Authorization: "Bearer person-session" }),
      idempotencyKey: () => "k",
    });
    await readReceipt(client, "AAAA", true);
    expect(seen.map((s) => s.url)).toEqual([
      "https://atlas.test/api/v1/aurora/status",
      "https://atlas.test/api/v1/aurora/extract",
    ]);
    expect(seen.every((s) => s.auth === "Bearer person-session")).toBe(true);
    expect(Object.keys(seen[1]?.body as object).sort()).toEqual([
      "content_base64",
      "document_id",
      "file_name",
      "kind",
      "media_type",
    ]);
  });

  it("fills empty fields from the reading, and leaves a foreign amount for the person", () => {
    const proposal = receiptProposal("sug-1", FIELDS);
    const empty = { budgetLineId: "line-1", description: "", amount: "", incurredOn: "2027-06-10" };
    expect(applyProposal(empty, proposal, "USD")).toEqual({
      otherCurrency: null,
      draft: {
        budgetLineId: "line-1",
        description: "Ice and water",
        amount: "42.50",
        incurredOn: "2027-06-10",
      },
    });
    // What the person typed stays.
    expect(
      applyProposal({ ...empty, description: "Mine" }, proposal, "USD").draft.description,
    ).toBe("Mine");
    const euros = receiptProposal("sug-2", [
      ...FIELDS.filter((f) => f.field_path !== "currency" && f.field_path !== "incurred_on"),
      {
        field_path: "currency",
        proposed_value: "EUR",
        confidence: 0.9,
        refusal: null,
        missing: null,
      },
      {
        field_path: "incurred_on",
        proposed_value: "2027-06-09",
        confidence: 0.8,
        refusal: null,
        missing: null,
      },
    ]);
    expect(applyProposal(empty, euros, "USD")).toEqual({
      otherCurrency: "EUR",
      draft: {
        budgetLineId: "line-1",
        description: "Ice and water",
        amount: "",
        incurredOn: "2027-06-09",
      },
    });
  });
});

describe("saving an expense with its receipt", () => {
  const save = () =>
    buildReceiptSave(
      {
        personId: "person-1",
        line: line(),
        description: "  Ice and water ",
        amountMinor: 4250,
        incurredOn: "2027-06-10",
        localUri: "file:///cache/receipt.jpg",
        captureSource: "Camera",
        capturedAt: "2027-06-10T22:00:00Z",
        suggestionId: "sug-1",
      },
      Date.parse("2027-06-10T22:01:00Z"),
      () => "exp-1",
    );

  it("queues one replayable write with the photo, filed under the line's org and project", () => {
    const m = save();
    expect(receiptPath(line(), "exp-1")).toBe(`${ORG}/expense-receipts/${PROJECT}/exp-1.jpg`);
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.submit_expense_receipt",
      table: "expenses",
      rowId: "exp-1",
      policy: "append",
      payload: {
        p_id: "exp-1",
        p_budget_line_id: "line-1",
        p_description: "Ice and water",
        p_amount_minor: 4250,
        p_currency_code: "USD",
        p_incurred_on: "2027-06-10",
        p_media_uri: `${ORG}/expense-receipts/${PROJECT}/exp-1.jpg`,
        p_capture_source: "Camera",
        p_ai_suggestion_id: "sug-1",
        storage_path: `${ORG}/expense-receipts/${PROJECT}/exp-1.jpg`,
        local_uri: "file:///cache/receipt.jpg",
      },
      optimistic: {
        id: "exp-1",
        submitter_person_id: "person-1",
        expense_state: "Proposed",
        amount_minor: 4250,
      },
    });
  });

  it("uploads the photo first, then replays the filing without device-only fields", async () => {
    const m = save();
    const calls: string[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push(
          `rpc ${name} ${String(args["p_rpc"])} ${JSON.stringify(Object.keys(args["p_args"] as object).sort())}`,
        );
        return { data: { data: "exp-1" }, error: null, status: 200 };
      },
    } as unknown as SupabaseClient;
    const uploader = new SupabaseUploader({
      client,
      functionsUrl: "https://x.test",
      accessToken: async () => "t",
      orgId: () => ORG,
      deviceId: "device-1",
      clock: { wallNow: () => 0, monotonicNow: () => 0, bootId: () => "b" },
      uploadFile: async (path, localUri) => (
        calls.push(`upload ${path} ${localUri}`),
        { error: null }
      ),
    });
    const outcome = await uploader.upload({
      ...m,
      id: "mut-1",
      seq: 1,
      base: null,
      dependsOn: [],
      queuedAt: "",
      attempts: 0,
      nextAttemptAt: 0,
      status: "pending",
      lastError: null,
      serverRow: null,
    } as Mutation);
    expect(outcome.kind).toBe("applied");
    expect(calls[0]).toBe(
      `upload ${ORG}/expense-receipts/${PROJECT}/exp-1.jpg file:///cache/receipt.jpg`,
    );
    expect(calls[1]).toContain("rpc apply_sync_mutation app.submit_expense_receipt");
    expect(calls[1]).not.toContain("local_uri");
    expect(calls[1]).not.toContain("storage_path");
  });

  it("keeps the optimistic row on the device and lists the person's own expenses newest first", () => {
    const scope: DownloadScope = {
      audience: "field",
      personIds: ["person-1"],
      orgIds: [ORG],
      membershipIds: ["m-1"],
      readableProjectIds: [PROJECT],
      engagementIds: [],
      engagedProjectIds: [],
    };
    const row = save().optimistic as { id: string } & Record<string, unknown>;
    expect(admits("expenses", row, scope)).toBe(true);
    expect(admits("expenses", { ...row, submitter_person_id: "someone-else" }, scope)).toBe(false);
    expect(admits("budget_lines", { id: "l", project_id: PROJECT }, scope)).toBe(true);
    expect(
      admits("budget_lines", { id: "l", project_id: PROJECT }, { ...scope, audience: "crew" }),
    ).toBe(false);
    const expense = (id: string, day: string, person = "person-1") => ({
      id,
      budget_line_id: "line-1",
      submitter_person_id: person,
      description: id,
      incurred_on: day,
      amount_minor: 1,
      currency_code: "USD",
      expense_state: "Proposed",
    });
    expect(
      myExpenses(
        [expense("a", "2027-06-01"), expense("b", "2027-06-09"), expense("c", "2027-06-10", "x")],
        "person-1",
      ).map((e) => e.id),
    ).toEqual(["b", "a"]);
  });

  it("reads in the offline queue as what was bought and the day", () => {
    const m = save();
    const summary = summarizeMutation(
      { op: m.op, target: m.target, table: m.table, payload: m.payload, base: null, queuedAt: "" },
      {
        time: () => "",
        day: (iso, zone) => `${iso.slice(0, 10)} ${zone ?? ""}`.trim(),
        projectName: () => null,
        zoneName: () => null,
        punchAction: () => "",
        kind: (table) => table,
      },
    );
    expect(summary).toEqual({
      key: "expenseReceipt",
      values: { description: "Ice and water", day: "2027-06-10 UTC" },
    });
  });
});

describe("who may file expenses", () => {
  const identity = (capabilities: string[]): CompassIdentity => ({
    personId: "p",
    displayName: "P",
    audience: "field",
    capabilities,
    membershipId: "m",
    engagements: [],
  });

  it("needs finance.expense.write; external parties never file in Compass", () => {
    expect(access(identity(["finance.expense.write"]), "expenses.submit", PROJECT)).toEqual({
      allowed: true,
    });
    expect(access(identity([]), "expenses.submit", PROJECT)).toEqual({
      allowed: false,
      reason: "capability",
    });
    expect(
      access({ ...identity([]), audience: "crew", membershipId: null }, "expenses.submit", PROJECT),
    ).toEqual({ allowed: false, reason: "role" });
  });
});

describe("expense copy", () => {
  it.each(locales)("has every expense message in %s", (locale) => {
    const all = getMessages(locale) as unknown as {
      compassExpenses: Record<string, Record<string, string> | string>;
      compass: { queue: { summary: Record<string, string>; kinds: Record<string, string> } };
    };
    const copy = all.compassExpenses;
    for (const state of ["proposed", "approved", "rejected", "paid", "canceled"])
      expect(typeof (copy["state"] as Record<string, string>)[state], state).toBe("string");
    for (const s of [
      "reading",
      "read",
      "off",
      "notInPlan",
      "limit",
      "offline",
      "noAnswer",
      "failed",
      "otherCurrency",
    ])
      expect(typeof (copy["aurora"] as Record<string, string>)[s], s).toBe("string");
    expect(all.compass.queue.summary["expenseReceipt"]).toMatch(/\{description\}/);
    expect(typeof all.compass.queue.kinds["expenses"]).toBe("string");
  });
});
