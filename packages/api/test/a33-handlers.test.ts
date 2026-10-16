/**
 * Contract tests for A33's handlers (Section 18, gate 5): approval policies, steps, approvals and
 * decisions; Trash; templates with their versions, items and applications; org state labels; the
 * report metric rows of labor, incident rates and gate readiness; and recording a sealed RFQ
 * response. Requests run through `contractApp`, every response is checked against openapi/v1.json
 * with `expectContract`, and the database is a recording stand-in for supabase-js: each `from(table)`
 * or `rpc(name)` call takes the next queued response. Refusals (422) and hidden rows (404) are checked.
 */
import type * as ReportsModuleNs from "@xos/data/reports";
import { describe, expect, it, vi } from "vitest";
import { handlers as platformHandlers } from "../src/handlers/platform.ts";
import { parseTrashUrn } from "../src/handlers/parts/workflow.ts";
import { handlers as procurementHandlers } from "../src/handlers/procurement.ts";
import { handlers as reportHandlers } from "../src/handlers/reports.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type ReportsModule = typeof ReportsModuleNs;

const stubs = vi.hoisted(() => ({
  project: {
    id: "0192f1e2-7c3a-7b4d-9e8f-000000001001",
    key: "NWL",
    name: "Summer Series",
    phase: "SCP",
  },
}));

vi.mock("@xos/data/reports", async (original) => ({
  ...(await original<ReportsModule>()),
  laborReport: vi.fn(async () => ({
    ok: true,
    data: {
      projects: [
        {
          project: stubs.project,
          currency: "USD",
          budgetMinor: null,
          unpricedCount: 1,
          workedMinutes: 18750,
          timesheetCount: 12,
          openEntryCount: 1,
        },
      ],
      payrollRuns: [],
    },
  })),
  incidentsReport: vi.fn(async () => ({
    ok: true,
    data: {
      rows: [
        {
          severityId: "s1",
          severityLabel: "Critical",
          state: "Closed",
          count: 1,
          incidentIds: ["a"],
        },
        {
          severityId: "s1",
          severityLabel: "Critical",
          state: "Reported",
          count: 2,
          incidentIds: ["b", "c"],
        },
      ],
      total: 3,
      open: 2,
    },
  })),
  gateReadiness: vi.fn(async () => ({
    ok: true,
    data: [
      {
        project: stubs.project,
        nextGate: 3,
        blockingTotal: 4,
        blockingMet: 4,
        otherTotal: 2,
        otherMet: 1,
        ready: true,
        unmetBlocking: [],
      },
    ],
  })),
}));

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db: Record<string, unknown> = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  };
  db["schema"] = () => db;
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const T = "2026-10-15T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: null,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a33-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "If-Match": "*", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const del = { method: "DELETE" };

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({
      handlers: [platformHandlers, reportHandlers, procurementHandlers],
      db: fake.db as never,
    }),
    calls: fake.calls,
  };
}

/** list, get, create (insert then read), update (read, update, read) and delete (read, update). */
const crud = (row: { id: string }) => [
  ok([row]),
  ok(row),
  ok({ id: row.id }),
  ok(row),
  ok(row),
  ok([{ id: row.id }]),
  ok(row),
  ok({ id: row.id }),
  ok(null),
  hidden,
];

const policy = {
  ...audit(1),
  name: "Purchase orders",
  description: null,
  document_type: "Purchase Order",
  currency_code: null,
  applies_above_minor: null,
  policy_state: "Draft",
};
const step = {
  ...audit(2),
  approval_policy_id: policy.id,
  step_order: 1,
  name: "Finance",
  approver_role_id: id(400),
  approver_membership_id: null,
};
const instance = {
  ...audit(3),
  approval_policy_id: policy.id,
  document_type: "Purchase Order",
  document_id: id(500),
  subject_table: "purchase_orders",
  subject_reference: "17",
  project_id: id(600),
  amount_minor: 4000000,
  currency_code: "USD",
  requested_by: id(700),
  approval_state: "In Review",
  current_step: 1,
  decided_at: null,
};
const decision = {
  ...audit(4),
  approval_instance_id: instance.id,
  approved: true,
  comment: "Within budget.",
  approver_id: id(701),
  decided_at: T,
  step_order: 1,
};
const trashItem = {
  subject_urn: `urn:xpms:budgets:${id(800)}`,
  deleted_at: T,
  purge_after: "2033-10-15T12:00:00.000Z",
  subject_table: "budgets",
  subject_id: id(800),
  org_id: ORG,
  project_id: id(600),
  title: "Summer Series Budget",
  deleted_by: id(700),
};
const template = {
  ...audit(5),
  name: "Three-Day Festival",
  current_version_id: null,
  description: null,
  template_kind: "Project",
};
const version = {
  ...audit(6),
  template_id: template.id,
  version_number: 1,
  notes: null,
  default_time_zone: "America/New_York",
  default_tier_code: null,
  default_region_code: null,
  default_jurisdiction_id: null,
  default_currency_code: "USD",
  duration_days: 3,
  published_at: null,
};
const item = {
  ...audit(7),
  template_version_id: version.id,
  item_kind: "Record",
  sort_order: 1,
  name: "Book the rigging inspection",
  scope_kind: null,
  scope_code_suffix: null,
  record_kind: "Inspection",
  xyz: "Y",
  phase_code: "SCP",
  due_offset_days: 3,
};
const application = {
  ...audit(8),
  template_id: template.id,
  project_id: id(601),
  template_version_id: version.id,
  scope_nodes_created: 1,
  records_created: 1,
};
const label = { ...audit(9), record_state: "In Review", label: "With Client" };

describe("Approval policies and steps", () => {
  it("serves policies and moves their state through the RPC", async () => {
    const { api, calls } = app({
      "from:approval_policies": [
        ...crud(policy),
        ok({ id: policy.id }),
        ok({ ...policy, policy_state: "Active" }),
        ok({ id: policy.id }),
      ],
      "rpc:transition_approval_policy": [ok(id(900)), refusal("approval_policy_no_steps")],
    });
    await expectContract(await api.request("/approval-policies"), "approvalPolicies.list");
    await expectContract(
      await api.request(`/approval-policies/${policy.id}`),
      "approvalPolicies.get",
    );
    const made = await api.request(
      "/approval-policies",
      post({ name: "Purchase orders", document_type: "Requisition" }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "approvalPolicies.create");
    const updated = await api.request(
      `/approval-policies/${policy.id}`,
      patch({ name: "Every purchase order" }),
    );
    await expectContract(updated, "approvalPolicies.update");
    const removed = await api.request(`/approval-policies/${policy.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "approvalPolicies.delete");
    expect((await api.request(`/approval-policies/${id(999)}`)).status).toBe(404);
    const moved = await api.request(
      `/approval-policies/${policy.id}/transitions`,
      post({ expected_state: "Draft", to_state: "Active", reason: "Ready." }),
    );
    await expectContract(moved, "approvalPolicies.transition");
    const rpcCall = calls.find((c) => c.target === "rpc:transition_approval_policy");
    expect(rpcCall?.steps[0]?.[1][0]).toEqual({
      p_approval_policy_id: policy.id,
      p_expected: "Draft",
      p_next: "Active",
      p_reason: "Ready.",
    });
    const refused = await api.request(
      `/approval-policies/${policy.id}/transitions`,
      post({ expected_state: "Draft", to_state: "Active" }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "approvalPolicies.transition");
  });

  it("refuses a Contract policy before it reaches the database", async () => {
    const { api } = app({});
    const res = await api.request(
      "/approval-policies",
      post({ name: "Rounds", document_type: "Contract" }),
    );
    expect(res.status).toBe(422);
    await expectContract(res, "approvalPolicies.create");
  });

  it("serves steps", async () => {
    const { api } = app({ "from:approval_steps": crud(step) });
    await expectContract(await api.request("/approval-steps"), "approvalSteps.list");
    await expectContract(await api.request(`/approval-steps/${step.id}`), "approvalSteps.get");
    const made = await api.request(
      "/approval-steps",
      post({
        approval_policy_id: policy.id,
        step_order: 1,
        name: "Finance",
        approver_role_id: id(400),
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "approvalSteps.create");
    const updated = await api.request(
      `/approval-steps/${step.id}`,
      patch({ name: "Finance review" }),
    );
    await expectContract(updated, "approvalSteps.update");
    const removed = await api.request(`/approval-steps/${step.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "approvalSteps.delete");
    expect((await api.request(`/approval-steps/${id(999)}`)).status).toBe(404);
  });
});

describe("Approvals and decisions", () => {
  it("requests an approval through app.request_approval and withdraws it", async () => {
    const { api, calls } = app({
      "from:approval_instances": [
        ok([instance]),
        ok(instance),
        ok(instance),
        ok({ id: instance.id }),
        ok({ ...instance, approval_state: "Canceled", decided_at: T }),
        hidden,
      ],
      "rpc:request_approval": [ok(instance.id), refusal("approval_in_review")],
      "rpc:cancel_approval": [ok(id(901))],
    });
    await expectContract(await api.request("/approval-instances"), "approvalInstances.list");
    await expectContract(
      await api.request(`/approval-instances/${instance.id}`),
      "approvalInstances.get",
    );
    const made = await api.request(
      "/approval-instances",
      post({ document_type: "Purchase Order", document_id: id(500) }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "approvalInstances.create");
    expect(calls.find((c) => c.target === "rpc:request_approval")?.steps[0]?.[1][0]).toEqual({
      p_document_type: "Purchase Order",
      p_document_id: id(500),
    });
    const again = await api.request(
      "/approval-instances",
      post({ document_type: "Purchase Order", document_id: id(500) }),
    );
    expect(again.status).toBe(422);
    await expectContract(again, "approvalInstances.create");
    const canceled = await api.request(
      `/approval-instances/${instance.id}/cancel`,
      post({ reason: "Wrong order." }),
    );
    await expectContract(canceled, "approvalInstances.cancel");
    expect((await api.request(`/approval-instances/${id(999)}`)).status).toBe(404);
  });

  it("decides a step through app.decide_approval and passes refusals through", async () => {
    const { api } = app({
      "from:approval_decisions": [ok([decision]), ok(decision), ok(decision)],
      "rpc:decide_approval": [ok(decision.id), refusal("sod_approval_requester")],
    });
    await expectContract(await api.request("/approval-decisions"), "approvalDecisions.list");
    await expectContract(
      await api.request(`/approval-decisions/${decision.id}`),
      "approvalDecisions.get",
    );
    const made = await api.request(
      "/approval-decisions",
      post({ approval_instance_id: instance.id, approved: true, comment: "Within budget." }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "approvalDecisions.create");
    const mine = await api.request(
      "/approval-decisions",
      post({ approval_instance_id: instance.id, approved: true }),
    );
    expect(mine.status).toBe(422);
    await expectContract(mine, "approvalDecisions.create");
  });
});

describe("Trash", () => {
  it("lists deleted rows and restores one by its URN", async () => {
    const { api, calls } = app({
      "from:trash_items": [ok([trashItem])],
      "rpc:restore_trash_item": [ok(2), refusal("trash_restore_expired")],
    });
    await expectContract(await api.request("/trash"), "trashItems.list");
    const restored = await api.request(
      "/trash/restore",
      post({ subject_urn: trashItem.subject_urn }),
    );
    const body = (await expectContract(restored, "trashItems.restore")) as {
      rows_restored: number;
    };
    expect(body.rows_restored).toBe(2);
    expect(calls.find((c) => c.target === "rpc:restore_trash_item")?.steps[0]?.[1][0]).toEqual({
      p_subject_table: "budgets",
      p_subject_id: id(800),
    });
    const late = await api.request("/trash/restore", post({ subject_urn: trashItem.subject_urn }));
    expect(late.status).toBe(422);
    await expectContract(late, "trashItems.restore");
    const bad = await api.request("/trash/restore", post({ subject_urn: "urn:other:1" }));
    expect(bad.status).toBe(422);
    await expectContract(bad, "trashItems.restore");
  });

  it("parses only urn:xpms:{table}:{id}", () => {
    expect(parseTrashUrn(`urn:xpms:records:${id(1)}`)).toEqual({ table: "records", id: id(1) });
    expect(() => parseTrashUrn("urn:xpms:Records:1")).toThrow();
  });
});

describe("Templates", () => {
  it("serves templates and saves a project as one", async () => {
    const { api } = app({
      "from:templates": [...crud(template), ok(template)],
      "rpc:create_template_from_project": [ok(template.id)],
    });
    await expectContract(await api.request("/templates"), "templates.list");
    await expectContract(await api.request(`/templates/${template.id}`), "templates.get");
    const made = await api.request(
      "/templates",
      post({ name: "Three-Day Festival", description: "Outdoor weekend shows." }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "templates.create");
    const updated = await api.request(
      `/templates/${template.id}`,
      patch({ name: "Weekend Festival" }),
    );
    await expectContract(updated, "templates.update");
    const removed = await api.request(`/templates/${template.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "templates.delete");
    expect((await api.request(`/templates/${id(999)}`)).status).toBe(404);
    const saved = await api.request(
      "/templates/from-project",
      post({ project_id: id(601), name: "Tidewater Weekend" }),
    );
    expect(saved.status).toBe(201);
    await expectContract(saved, "templates.createFromProject");
  });

  it("serves versions and publishes one", async () => {
    const { api } = app({
      "from:template_versions": [
        ...crud(version),
        ok({ id: version.id }),
        ok({ ...version, published_at: T }),
        ok({ id: version.id }),
      ],
      "rpc:publish_template_version": [ok(version.id), refusal("template_version_published")],
    });
    await expectContract(await api.request("/template-versions"), "templateVersions.list");
    await expectContract(
      await api.request(`/template-versions/${version.id}`),
      "templateVersions.get",
    );
    const made = await api.request(
      "/template-versions",
      post({ template_id: template.id, default_time_zone: "America/New_York", duration_days: 3 }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "templateVersions.create");
    const updated = await api.request(
      `/template-versions/${version.id}`,
      patch({ notes: "Adds the load-out." }),
    );
    await expectContract(updated, "templateVersions.update");
    const removed = await api.request(`/template-versions/${version.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "templateVersions.delete");
    expect((await api.request(`/template-versions/${id(999)}`)).status).toBe(404);
    await expectContract(
      await api.request(`/template-versions/${version.id}/publish`, post({})),
      "templateVersions.publish",
    );
    const twice = await api.request(`/template-versions/${version.id}/publish`, post({}));
    expect(twice.status).toBe(422);
    await expectContract(twice, "templateVersions.publish");
  });

  it("serves items", async () => {
    const { api } = app({ "from:template_items": crud(item) });
    await expectContract(await api.request("/template-items"), "templateItems.list");
    await expectContract(await api.request(`/template-items/${item.id}`), "templateItems.get");
    const made = await api.request(
      "/template-items",
      post({
        template_version_id: version.id,
        item_kind: "Record",
        sort_order: 1,
        name: "Book the rigging inspection",
        record_kind: "Inspection",
        xyz: "Y",
        due_offset_days: 3,
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "templateItems.create");
    const updated = await api.request(`/template-items/${item.id}`, patch({ due_offset_days: 4 }));
    await expectContract(updated, "templateItems.update");
    const removed = await api.request(`/template-items/${item.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "templateItems.delete");
    expect((await api.request(`/template-items/${id(999)}`)).status).toBe(404);
  });

  it("creates a project from a template through app.apply_template", async () => {
    const { api, calls } = app({
      "from:template_applications": [ok([application]), ok(application), ok(application), hidden],
      "rpc:apply_template": [ok(application.id), refusal("template_unpublished")],
    });
    await expectContract(await api.request("/template-applications"), "templateApplications.list");
    await expectContract(
      await api.request(`/template-applications/${application.id}`),
      "templateApplications.get",
    );
    const made = await api.request(
      "/template-applications",
      post({
        template_id: template.id,
        project_key: "NWT",
        name: "Tidewater Weekend",
        starts_on: "2027-07-01",
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "templateApplications.create");
    expect(calls.find((c) => c.target === "rpc:apply_template")?.steps[0]?.[1][0]).toEqual({
      p_template_id: template.id,
      p_project_key: "NWT",
      p_name: "Tidewater Weekend",
      p_time_zone: null,
      p_starts_on: "2027-07-01",
      p_venue_id: null,
    });
    const draft = await api.request(
      "/template-applications",
      post({ template_id: template.id, project_key: "NWX", name: "Draft" }),
    );
    expect(draft.status).toBe(422);
    await expectContract(draft, "templateApplications.create");
    expect((await api.request(`/template-applications/${id(999)}`)).status).toBe(404);
  });
});

describe("Org state labels", () => {
  it("serves labels", async () => {
    const { api } = app({ "from:org_state_labels": crud(label) });
    await expectContract(await api.request("/org-state-labels"), "orgStateLabels.list");
    await expectContract(await api.request(`/org-state-labels/${label.id}`), "orgStateLabels.get");
    const made = await api.request(
      "/org-state-labels",
      post({ record_state: "In Review", label: "With Client" }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "orgStateLabels.create");
    const updated = await api.request(
      `/org-state-labels/${label.id}`,
      patch({ label: "Client Review" }),
    );
    await expectContract(updated, "orgStateLabels.update");
    const removed = await api.request(`/org-state-labels/${label.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "orgStateLabels.delete");
    expect((await api.request(`/org-state-labels/${id(999)}`)).status).toBe(404);
  });
});

describe("Report metric rows", () => {
  it("answers labor, incident rates and gate readiness in hours and counts", async () => {
    const { api } = app({});
    const labor = (await expectContract(
      await api.request("/reports/labor-cost"),
      "reports.laborCost",
    )) as {
      data: { measure: string; value: number }[];
    };
    expect(labor.data.find((r) => r.measure === "worked_hours")?.value).toBe(312.5);
    const incidents = (await expectContract(
      await api.request("/reports/incident-rates?from=2027-06-01&to=2027-06-30"),
      "reports.incidentRates",
    )) as { data: { measure: string; value: number }[] };
    expect(incidents.data).toEqual([
      expect.objectContaining({ dimension: "Critical", measure: "incidents", value: 3 }),
      expect.objectContaining({ dimension: "Critical", measure: "open_incidents", value: 2 }),
    ]);
    const gates = (await expectContract(
      await api.request("/reports/gate-readiness"),
      "reports.gateReadiness",
    )) as { data: { dimension: string; measure: string; value: number }[] };
    expect(gates.data.find((r) => r.measure === "ready")).toMatchObject({
      dimension: "NWL gate 3",
      value: 1,
    });
  });
});

describe("Sealed RFQ responses", () => {
  it("records a response and its lines through app.record_rfq_response", async () => {
    const { api, calls } = app({
      "rpc:record_rfq_response": [ok(id(1000)), refusal("rfq_not_invited")],
      "from:rfqs": [ok({ rfq_state: "Issued" })],
    });
    const made = await api.request(
      "/rfq-responses",
      post({
        rfq_id: id(1100),
        vendor_id: id(1200),
        currency_code: "USD",
        lines: [{ description: "Line array", quantity: 2, unit_price_minor: 1800000 }],
      }),
    );
    expect(made.status).toBe(201);
    const body = (await expectContract(made, "rfqResponses.create")) as { sealed: boolean };
    expect(body.sealed).toBe(true);
    expect(
      calls.find((c) => c.target === "rpc:record_rfq_response")?.steps[0]?.[1][0],
    ).toMatchObject({
      p_rfq_id: id(1100),
      p_vendor_id: id(1200),
      p_currency_code: "USD",
      p_lines: [
        { description: "Line array", element_id: null, quantity: 2, unit_price_minor: 1800000 },
      ],
    });
    const uninvited = await api.request(
      "/rfq-responses",
      post({
        rfq_id: id(1100),
        vendor_id: id(1201),
        currency_code: "USD",
        lines: [{ description: "Delay towers", unit_price_minor: null }],
      }),
    );
    expect(uninvited.status).toBe(422);
    await expectContract(uninvited, "rfqResponses.create");
  });
});
