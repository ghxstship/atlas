import { describe, expect, it } from "vitest";
import {
  aggregatesFor,
  previewCsv,
  previewReport,
  type ReportDefinition,
} from "../src/report-builder.ts";
import {
  canDecide,
  listApprovals,
  listTrash,
  requestApproval,
  restoreTrashItem,
  setStateLabel,
  uploadSupportScreenshot,
  type Approval,
  type ApprovalPolicy,
} from "../src/workflow.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

const definition = (patch: Partial<ReportDefinition>): ReportDefinition => ({
  id: null,
  name: "Budget by account",
  sourceCode: "finance",
  customObjectTypeId: null,
  chart: "Bar",
  groupBy: "account_code",
  shared: false,
  mine: true,
  fields: [{ field: "extended_minor", aggregate: "Sum" }],
  filters: [],
  ...patch,
});

describe("report builder preview", () => {
  it("sums money per group and currency, blank while any input is unpriced", async () => {
    const { db, calls } = moduleClient({
      "from:budget_line_facts": [
        ok([
          { account_code: "5000", extended_minor: 1000, currency_code: "USD" },
          { account_code: "5000", extended_minor: 2500, currency_code: "USD" },
          { account_code: "5100", extended_minor: null, currency_code: "USD" },
          { account_code: "5100", extended_minor: 400, currency_code: "USD" },
          { account_code: "5000", extended_minor: 700, currency_code: "EUR" },
        ]),
      ],
    });
    const result = await previewReport(db, {
      orgId: "o",
      projectIds: ["p1"],
      definition: definition({}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => [r.group, r.cells[0]])).toEqual([
      ["5000", { kind: "money", totalMinor: 3500, currency: "USD", unpricedCount: 0 }],
      ["5000", { kind: "money", totalMinor: 700, currency: "EUR", unpricedCount: 0 }],
      ["5100", { kind: "money", totalMinor: null, currency: "USD", unpricedCount: 1 }],
    ]);
    expect(stepsOf(calls[0], "in")).toEqual([["project_id", ["p1"]]]);
  });

  it("applies filters as the viewer and counts records", async () => {
    const { db, calls } = moduleClient({
      "from:records": [
        ok([
          { record_state: "Ready", record_kind: "Task" },
          { record_state: "Ready", record_kind: "Build" },
        ]),
      ],
    });
    const result = await previewReport(db, {
      orgId: "o",
      projectIds: [],
      definition: definition({
        sourceCode: "records",
        groupBy: "record_state",
        fields: [{ field: "record_kind", aggregate: "Count" }],
        filters: [
          { field: "record_kind", operator: "in", value: "Task, Build" },
          { field: "title", operator: "contains", value: "load_in%" },
        ],
      }),
    });
    expect(result.ok && result.data.rows).toEqual([
      { group: "Ready", cells: [{ kind: "value", value: 2 }] },
    ]);
    expect(stepsOf(calls[0], "eq")).toContainEqual(["org_id", "o"]);
    expect(stepsOf(calls[0], "in")).toEqual([["record_kind", ["Task", "Build"]]]);
    expect(stepsOf(calls[0], "ilike")).toEqual([["title", "%loadin%"]]);
  });

  it("leaves an average blank when a number is blank, and reads nothing without projects", async () => {
    const { db } = moduleClient({
      "from:purchase_order_totals": [],
    });
    const none = await previewReport(db, {
      orgId: "o",
      projectIds: [],
      definition: definition({
        sourceCode: "procurement",
        groupBy: null,
        fields: [{ field: "unpriced_count", aggregate: "Average" }],
      }),
    });
    expect(none.ok && none.data.rows).toEqual([]);
    expect(aggregatesFor("text")).toEqual(["None", "Count"]);
    expect(aggregatesFor("date")).toEqual(["None", "Count", "Minimum", "Maximum"]);
  });

  it("writes CSV with money in the currency's own decimals and blanks left blank", () => {
    const csv = previewCsv(
      {
        columns: [{ field: "extended_minor", aggregate: "Sum", type: "money" }],
        rows: [
          {
            group: "5000",
            cells: [{ kind: "money", totalMinor: 123456, currency: "USD", unpricedCount: 0 }],
          },
          {
            group: "5100",
            cells: [{ kind: "money", totalMinor: 5000, currency: "JPY", unpricedCount: 0 }],
          },
          {
            group: null,
            cells: [{ kind: "money", totalMinor: null, currency: "USD", unpricedCount: 2 }],
          },
        ],
        sourceRows: 3,
        truncated: false,
      },
      ["Sum of Budgeted"],
      "GL account",
    );
    expect(csv).toBe("GL account,Sum of Budgeted\n5000,1234.56 USD\n5100,5000 JPY\n,\n");
  });
});

const policy: ApprovalPolicy = {
  id: "pol",
  name: "Purchase orders",
  description: null,
  documentType: "Purchase Order",
  currency: null,
  appliesAboveMinor: null,
  state: "Active",
  updatedAt: "2026-10-16T00:00:00Z",
  steps: [
    { id: "s1", order: 1, name: "Finance", roleId: "role-admin", membershipId: null },
    { id: "s2", order: 2, name: "Owner", roleId: null, membershipId: "m-owner" },
  ],
};
const approval: Approval = {
  id: "a1",
  policyId: "pol",
  policyName: "Purchase orders",
  documentType: "Purchase Order",
  documentId: "po1",
  subjectTable: "purchase_orders",
  subjectReference: "17",
  projectId: "p1",
  amountMinor: 40000,
  currency: "USD",
  requestedBy: "carol",
  requesterName: "Carol",
  state: "In Review",
  currentStep: 1,
  decidedAt: null,
  createdAt: "2026-10-16T00:00:00Z",
  decisions: [],
};

describe("approvals", () => {
  it("lets only the current step's approvers decide, never the requester or a repeat approver", () => {
    const admin = { personId: "bob", membershipId: "m-bob", roleIds: ["role-admin"] };
    expect(canDecide(approval, policy, admin)).toBe(true);
    expect(canDecide(approval, policy, { ...admin, personId: "carol" })).toBe(false);
    expect(canDecide({ ...approval, currentStep: 2 }, policy, admin)).toBe(false);
    expect(
      canDecide({ ...approval, currentStep: 2 }, policy, {
        personId: "alice",
        membershipId: "m-owner",
        roleIds: [],
      }),
    ).toBe(true);
    expect(
      canDecide(
        {
          ...approval,
          currentStep: 2,
          decisions: [
            {
              id: "d",
              step: 1,
              approverId: "alice",
              approverName: null,
              approved: true,
              comment: null,
              decidedAt: "",
            },
          ],
        },
        policy,
        { personId: "alice", membershipId: "m-owner", roleIds: [] },
      ),
    ).toBe(false);
    expect(canDecide({ ...approval, state: "Approved" }, policy, admin)).toBe(false);
  });

  it("maps approvals with their decisions and passes refusals through typed", async () => {
    const { db, calls } = moduleClient({
      "from:approval_instances": [
        ok([
          {
            id: "a1",
            approval_policy_id: "pol",
            document_type: "Purchase Order",
            document_id: "po1",
            subject_table: "purchase_orders",
            subject_reference: "17",
            project_id: "p1",
            amount_minor: 40000,
            currency_code: "USD",
            requested_by: "carol",
            approval_state: "In Review",
            current_step: 2,
            decided_at: null,
            created_at: "2026-10-16T00:00:00Z",
            policy: { name: "Purchase orders" },
            requester: { full_name: "Carol" },
          },
        ]),
      ],
      "from:approval_decisions": [
        ok([
          {
            id: "d1",
            approval_instance_id: "a1",
            step_order: 1,
            approver_id: "bob",
            approved: true,
            comment: null,
            decided_at: "x",
            approver: { full_name: "Bob" },
          },
        ]),
      ],
      "rpc:request_approval": [refused("approval_in_review")],
    });
    const list = await listApprovals(db, "o");
    expect(list.ok && list.data[0]?.decisions[0]?.approverName).toBe("Bob");
    expect(stepsOf(calls[1], "in")).toEqual([["approval_instance_id", ["a1"]]]);
    const again = await requestApproval(db, { documentType: "Purchase Order", documentId: "po1" });
    expect(again).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "approval_in_review", message: "Refused." },
    });
  });
});

describe("trash", () => {
  it("lists deleted rows and restores through the RPC", async () => {
    const { db, calls } = moduleClient({
      "from:trash_items": [
        ok([
          {
            subject_urn: "urn:xpms:budgets:b1",
            subject_table: "budgets",
            subject_id: "b1",
            project_id: "p1",
            title: "Budget",
            deleted_at: "2026-10-16T00:00:00Z",
            deleted_by: "carol",
            purge_after: "2033-10-16T00:00:00Z",
          },
        ]),
      ],
      "rpc:restore_trash_item": [ok(2)],
    });
    const items = await listTrash(db, { orgId: "o", table: "budgets", q: "bud%" });
    expect(items.ok && items.data[0]?.urn).toBe("urn:xpms:budgets:b1");
    expect(stepsOf(calls[0], "ilike")).toEqual([["title", "%bud%"]]);
    expect(await restoreTrashItem(db, { table: "budgets", id: "b1" })).toEqual({
      ok: true,
      data: 2,
    });
    expect(stepsOf(calls[1], "args")).toEqual([
      [{ p_subject_table: "budgets", p_subject_id: "b1" }],
    ]);
  });
});

describe("state labels", () => {
  it("inserts, renames and clears a label", async () => {
    const { db, calls } = moduleClient({
      "from:org_state_labels": [ok({ id: "l1" }), ok([{ id: "l1" }]), ok([{ id: "l1" }])],
    });
    expect(
      await setStateLabel(db, {
        orgId: "o",
        state: "In Review",
        label: "With Client",
        labelId: null,
      }),
    ).toEqual({ ok: true, data: "l1" });
    await setStateLabel(db, {
      orgId: "o",
      state: "In Review",
      label: "Client Review",
      labelId: "l1",
    });
    await setStateLabel(db, { orgId: "o", state: "In Review", label: " ", labelId: "l1" });
    expect(stepsOf(calls[0], "insert")).toEqual([
      [{ org_id: "o", record_state: "In Review", label: "With Client" }],
    ]);
    expect(stepsOf(calls[1], "update")).toEqual([[{ label: "Client Review" }]]);
    expect(Object.keys((stepsOf(calls[2], "update")[0]?.[0] ?? {}) as object)).toEqual([
      "deleted_at",
    ]);
    expect(
      await setStateLabel(db, { orgId: "o", state: "Ready", label: null, labelId: null }),
    ).toEqual({ ok: true, data: null });
  });
});

describe("support screenshots", () => {
  it("refuses anything but a small image before touching storage", async () => {
    const { db } = moduleClient({});
    const svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" });
    expect((await uploadSupportScreenshot(db, { personId: "p", file: svg })).ok).toBe(false);
    expect((await uploadSupportScreenshot(db, { personId: "p", file: big })).ok).toBe(false);
  });
});
