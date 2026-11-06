/**
 * Contract tests for outside stakeholder access (B2, ADR 0141, migrations 2910 to 2917). Requests run through
 * `contractApp` against the in-memory client and every success is checked against openapi/v1.json. Who may act, the
 * hashing and the lockouts are the database's (pgTAP 2910 to 2917); here the RPCs answer the way the database does.
 */
import { describe, expect, it } from "vitest";
import { handlers as platform } from "../src/handlers/platform.ts";
import { handlers as workforce } from "../src/handlers/workforce.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const PERSON = testContext().personId;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(226000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const PACK = id(2);
const ITEM = id(3);
const RECIPIENT = id(4);
const INTAKE = id(5);
const REQUEST = id(6);
const FORM_LINK = id(7);
const RESPONSE = id(8);
const MEMBER_SUBMISSION = id(9);
const TEMPLATE = id(10);
const VERSION = id(11);
const MISSING = id(9999);
const WHEN = "2026-11-27T23:59:59Z";

const pack = (extra: Row = {}) =>
  tenantRow(PACK, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    project_id: PROJECT,
    name: "Client pack",
    message: "Welcome.",
    note: "Team note",
    expires_at: WHEN,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
const item = () =>
  tenantRow(ITEM, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    stakeholder_pack_id: PACK,
    item_kind: "File",
    live_link_id: null,
    attachment_id: id(20),
    title: "Plan",
    position: 0,
    requires_acknowledgement: false,
  });
const recipient = (extra: Row = {}) =>
  tenantRow(RECIPIENT, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    stakeholder_pack_id: PACK,
    full_name: "Cleo",
    email: "cleo@example.com",
    counterparty_id: null,
    label: null,
    failed_attempts: 0,
    unsubscribed_at: null,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
const intake = (extra: Row = {}) =>
  tenantRow(INTAKE, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    project_id: PROJECT,
    role_type: "Vendor",
    role_code: "9000.50.02",
    worker_classification: "VENDOR_SUPPLIED",
    pay_basis: "Day Rate",
    arrangement: "Per Engagement",
    counterparty_type: "AV Integrator",
    start_date: "2027-06-01",
    end_date: null,
    agreement_document_id: null,
    agreement_version_id: null,
    title: "Audio",
    instructions: null,
    note: null,
    collect_tax_form: true,
    collect_payout: true,
    collect_invoice: false,
    token_hint: "abab",
    expires_at: WHEN,
    max_requests: 50,
    failed_attempts: 0,
    rotated_at: null,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
const request = (extra: Row = {}) =>
  tenantRow(REQUEST, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    vendor_intake_link_id: INTAKE,
    project_id: PROJECT,
    requested_by: id(30),
    account_id: id(31),
    tax_form_id: id(32),
    payout_account_id: null,
    signer_name: null,
    signed_at: null,
    signed_version_id: null,
    invoice_draft: null,
    request_state: "Pending",
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    engagement_id: null,
    invoice_id: null,
    ...extra,
  });
const formLink = (extra: Row = {}) =>
  tenantRow(FORM_LINK, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    form_template_id: TEMPLATE,
    project_id: null,
    note: null,
    token_hint: "abab",
    expires_at: WHEN,
    daily_cap: 200,
    max_responses: null,
    one_per_email: true,
    failed_attempts: 0,
    rotated_at: null,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
const submission = (rowId: string, extra: Row = {}) =>
  tenantRow(rowId, ORG, {
    created_by: PERSON,
    updated_by: PERSON,
    form_template_id: TEMPLATE,
    form_template_version_id: VERSION,
    project_id: null,
    record_id: null,
    answers: { a: "x" },
    score: null,
    max_score: null,
    passed: null,
    submission_state: "Submitted",
    decided_by_membership_id: null,
    decision_note: null,
    latitude: null,
    longitude: null,
    accuracy_m: null,
    signer_name: null,
    signature_path: null,
    signed_at: null,
    ...extra,
  });

function world() {
  const tables = {
    stakeholder_packs: [pack()],
    stakeholder_pack_items: [item()],
    stakeholder_pack_recipients: [recipient()],
    stakeholder_pack_events: [] as Row[],
    stakeholder_pack_schedules: [] as Row[],
    vendor_intake_links: [intake()],
    vendor_intake_requests: [request()],
    form_links: [formLink()],
    form_submissions: [
      submission(RESPONSE, {
        form_link_id: FORM_LINK,
        submitted_by_membership_id: null,
        respondent_name: "Rae",
        respondent_email: "rae@example.com",
      }),
      submission(MEMBER_SUBMISSION, {
        form_link_id: null,
        submitted_by_membership_id: id(40),
        respondent_name: null,
        respondent_email: null,
      }),
    ],
    project_outside_access: [
      {
        project_id: PROJECT,
        source: "Intake link",
        source_id: INTAKE,
        label: "Audio",
        recipient_email: null,
        token_hint: "abab",
        link_state: "Active",
        expires_at: WHEN,
        open_count: null,
        last_opened_at: null,
        created_at: WHEN,
        created_by: PERSON,
        updated_by: PERSON,
      },
    ] as Row[],
  };
  const calls: string[] = [];
  const db = memoryDb(tables, {
    create_stakeholder_pack: () => PACK,
    update_stakeholder_pack: () => {
      Object.assign(tables.stakeholder_packs[0] as Row, { name: "Renamed" });
      return null;
    },
    revoke_stakeholder_pack: () => {
      Object.assign(tables.stakeholder_packs[0] as Row, { revoked_at: WHEN, revoked_by: PERSON });
      return WHEN;
    },
    set_stakeholder_pack_schedule: () => {
      tables.stakeholder_pack_schedules.push({
        id: id(50),
        org_id: ORG,
        stakeholder_pack_id: PACK,
        cadence: "Weekly",
        local_hour: 9,
        weekday: 1,
        month_day: null,
        time_zone: "America/New_York",
        next_run_at: WHEN,
        paused_at: null,
        deleted_at: null,
      });
      return WHEN;
    },
    clear_stakeholder_pack_schedule: () => null,
    add_stakeholder_pack_item: (args) => {
      if (args["p_attachment_id"] === MISSING) throw refusal("stakeholder_pack_item_classified");
      return ITEM;
    },
    remove_stakeholder_pack_item: () => null,
    add_stakeholder_pack_recipient: () => [{ recipient_id: RECIPIENT, access_code: "042424" }],
    reset_stakeholder_pack_recipient_code: () => "135790",
    revoke_stakeholder_pack_recipient: () => {
      Object.assign(tables.stakeholder_pack_recipients[0] as Row, {
        revoked_at: WHEN,
        revoked_by: PERSON,
      });
      return WHEN;
    },
    send_stakeholder_pack: () => 2,
    create_vendor_intake_link: () => [
      {
        vendor_intake_link_id: INTAKE,
        token: `xvin_${"ab".repeat(32)}`,
        access_code: "042424",
        expires_at: WHEN,
      },
    ],
    regenerate_vendor_intake_link: () => [
      { token: `xvin_${"cd".repeat(32)}`, access_code: "246802", expires_at: WHEN },
    ],
    revoke_vendor_intake_link: () => {
      Object.assign(tables.vendor_intake_links[0] as Row, { revoked_at: WHEN, revoked_by: PERSON });
      return WHEN;
    },
    decide_vendor_intake: (args) => {
      Object.assign(tables.vendor_intake_requests[0] as Row, {
        request_state: args["p_approve"] ? "Approved" : "Declined",
        decided_by: PERSON,
        decided_at: WHEN,
        decision_reason: args["p_reason"] ?? null,
      });
      return id(60);
    },
    create_form_link: () => [
      {
        form_link_id: FORM_LINK,
        token: `xfrm_${"ab".repeat(32)}`,
        access_code: "042424",
        expires_at: WHEN,
      },
    ],
    regenerate_form_link: () => [
      { token: `xfrm_${"cd".repeat(32)}`, access_code: "246802", expires_at: WHEN },
    ],
    revoke_form_link: () => {
      Object.assign(tables.form_links[0] as Row, { revoked_at: WHEN, revoked_by: PERSON });
      return WHEN;
    },
    decide_form_submission: () => {
      calls.push("decide_form_submission");
      Object.assign(tables.form_submissions[0] as Row, { submission_state: "Approved" });
      return id(70);
    },
  });
  return { db, calls, http: requests(contractApp({ handlers: [platform, workforce], db })) };
}

describe("Platform: stakeholder packs", () => {
  it("lists, creates, changes and revokes a pack", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get(`/stakeholder-packs?filter[project_id][eq]=${PROJECT}`)),
      "stakeholderPacks.list",
    );
    const res1 = await success(
      http.post("/stakeholder-packs/create", {
        project_id: PROJECT,
        name: "Client pack",
        expires_at: WHEN,
      }),
    );
    await expectContract(res1, "stakeholderPacks.create");
    const res2 = await success(
      http.post(`/stakeholder-packs/${PACK}/update`, {
        name: "Renamed",
        expires_at: WHEN,
        message: null,
        note: null,
      }),
    );
    const changed = (await expectContract(res2, "stakeholderPacks.update")) as Row;
    expect(changed["name"]).toBe("Renamed");
    const revoked = (await expectContract(
      await success(http.post(`/stakeholder-packs/${PACK}/revoke`)),
      "stakeholderPacks.revoke",
    )) as Row;
    expect(revoked["revoked_at"]).toBe(WHEN);
    expect((await http.get(`/stakeholder-packs/${MISSING}`)).status).toBe(404);
  });

  it("sets and clears a schedule", async () => {
    const { http } = world();
    const res3 = await success(
      http.post(`/stakeholder-packs/${PACK}/schedule`, {
        cadence: "Weekly",
        local_hour: 9,
        weekday: 1,
      }),
    );
    await expectContract(res3, "stakeholderPacks.setSchedule");
    await expectContract(
      await success(http.post(`/stakeholder-packs/${PACK}/schedule/clear`)),
      "stakeholderPacks.clearSchedule",
    );
  });

  it("adds and removes items, and surfaces the classification refusal", async () => {
    const { http } = world();
    const res4 = await success(
      http.post("/stakeholder-pack-items/add", {
        stakeholder_pack_id: PACK,
        attachment_id: id(20),
        title: "Plan",
      }),
    );
    await expectContract(res4, "stakeholderPackItems.add");
    const refused = await http.post("/stakeholder-pack-items/add", {
      stakeholder_pack_id: PACK,
      attachment_id: MISSING,
      title: "Plan",
    });
    expect(refused.status).toBe(422);
    await expectContract(
      await success(http.post(`/stakeholder-pack-items/${ITEM}/remove`)),
      "stakeholderPackItems.remove",
    );
  });

  it("answers a recipient's code only on add and resetCode, and never on a read", async () => {
    const { http } = world();
    const res5 = await success(
      http.post("/stakeholder-pack-recipients/add", {
        stakeholder_pack_id: PACK,
        full_name: "Cleo",
        email: "cleo@example.com",
      }),
    );
    const added = (await expectContract(res5, "stakeholderPackRecipients.add")) as Row;
    expect(added["access_code"]).toBe("042424");
    const reset = (await expectContract(
      await success(http.post(`/stakeholder-pack-recipients/${RECIPIENT}/reset-code`)),
      "stakeholderPackRecipients.resetCode",
    )) as Row;
    expect(reset["access_code"]).toBe("135790");
    const read = (await expectContract(
      await success(http.get(`/stakeholder-pack-recipients/${RECIPIENT}`)),
      "stakeholderPackRecipients.get",
    )) as Row;
    expect(Object.keys(read)).not.toContain("access_code");
    expect(Object.keys(read)).not.toContain("access_code_hash");
    expect(Object.keys(read)).not.toContain("code_salt");
    await expectContract(
      await success(http.post(`/stakeholder-pack-recipients/${RECIPIENT}/revoke`)),
      "stakeholderPackRecipients.revoke",
    );
    const res6 = await success(
      http.post("/stakeholder-pack-recipients/send", { stakeholder_pack_id: PACK }),
    );
    const sent = (await expectContract(res6, "stakeholderPackRecipients.send")) as Row;
    expect(sent["queued"]).toBe(2);
  });

  it("reads a pack, and lists items and recipients", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get(`/stakeholder-packs/${PACK}`)),
      "stakeholderPacks.get",
    );
    const items = await success(
      http.get(`/stakeholder-pack-items?filter[stakeholder_pack_id][eq]=${PACK}`),
    );
    await expectContract(items, "stakeholderPackItems.list");
    const recipients = await success(
      http.get(`/stakeholder-pack-recipients?filter[stakeholder_pack_id][eq]=${PACK}`),
    );
    await expectContract(recipients, "stakeholderPackRecipients.list");
  });

  it("lists events", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get(`/stakeholder-pack-events?filter[stakeholder_pack_id][eq]=${PACK}`)),
      "stakeholderPackEvents.list",
    );
  });
});

describe("Platform: vendor intake", () => {
  it("answers the token and code only on create and regenerate", async () => {
    const { http } = world();
    const res7 = await success(
      http.post("/vendor-intake-links/create", {
        project_id: PROJECT,
        title: "Audio",
        role_type: "Vendor",
        role_code: "9000.50.02",
        worker_classification: "VENDOR_SUPPLIED",
        pay_basis: "Day Rate",
        arrangement: "Per Engagement",
        start_date: "2027-06-01",
        expires_at: WHEN,
        counterparty_type: "AV Integrator",
      }),
    );
    const made = (await expectContract(res7, "vendorIntakeLinks.create")) as Row;
    expect(made["access_code"]).toBe("042424");
    await expectContract(
      await success(http.post(`/vendor-intake-links/${INTAKE}/regenerate`)),
      "vendorIntakeLinks.regenerate",
    );
    const read = (await expectContract(
      await success(http.get(`/vendor-intake-links/${INTAKE}`)),
      "vendorIntakeLinks.get",
    )) as Row;
    expect(Object.keys(read)).not.toContain("token_hash");
    expect(Object.keys(read)).not.toContain("access_code");
    await expectContract(
      await success(http.post(`/vendor-intake-links/${INTAKE}/revoke`)),
      "vendorIntakeLinks.revoke",
    );
  });

  it("approves and declines a request", async () => {
    const approving = world();
    const res8 = await success(
      approving.http.post(`/vendor-intake-requests/${REQUEST}/approve`, {}),
    );
    const approved = (await expectContract(res8, "vendorIntakeRequests.approve")) as Row;
    expect(approved["request_state"]).toBe("Approved");
    const declining = world();
    const res9 = await success(
      declining.http.post(`/vendor-intake-requests/${REQUEST}/decline`, {
        reason: "We already have this crew booked.",
      }),
    );
    const declined = (await expectContract(res9, "vendorIntakeRequests.decline")) as Row;
    expect(declined["request_state"]).toBe("Declined");
    const res10 = await success(
      declining.http.get(`/vendor-intake-requests?filter[project_id][eq]=${PROJECT}`),
    );
    await expectContract(res10, "vendorIntakeRequests.list");
  });
});

describe("Platform: public forms", () => {
  it("answers the token and code only on create and regenerate", async () => {
    const { http } = world();
    const res11 = await success(
      http.post("/form-links/create", { form_template_id: TEMPLATE, expires_at: WHEN }),
    );
    const made = (await expectContract(res11, "formLinks.create")) as Row;
    expect(made["token"]).toMatch(/^xfrm_/);
    await expectContract(
      await success(http.post(`/form-links/${FORM_LINK}/regenerate`)),
      "formLinks.regenerate",
    );
    await expectContract(
      await success(http.post(`/form-links/${FORM_LINK}/revoke`)),
      "formLinks.revoke",
    );
    await expectContract(await success(http.get(`/form-links/${FORM_LINK}`)), "formLinks.get");
  });

  it("keeps a link response out of formSubmissions, and decides it through formLinkResponses", async () => {
    const { http, calls } = world();
    const listed = (await expectContract(
      await success(http.get("/form-submissions")),
      "formSubmissions.list",
    )) as { data: Row[] };
    expect(listed.data.map((s) => s["id"])).toEqual([MEMBER_SUBMISSION]);
    expect((await http.get(`/form-submissions/${RESPONSE}`)).status).toBe(404);
    expect(
      (await http.post(`/form-submissions/${RESPONSE}/decide`, { approve: true })).status,
    ).toBe(404);
    expect(calls).toEqual([]);
    const responses = (await expectContract(
      await success(http.get("/form-link-responses")),
      "formLinkResponses.list",
    )) as { data: Row[] };
    expect(responses.data.map((s) => s["id"])).toEqual([RESPONSE]);
    const res12 = await success(
      http.post(`/form-link-responses/${RESPONSE}/decide`, { approve: true }),
    );
    const decided = (await expectContract(res12, "formLinkResponses.decide")) as Row;
    expect(decided["submission_state"]).toBe("Approved");
    expect(calls).toEqual(["decide_form_submission"]);
  });
});

describe("Platform: the other reads", () => {
  it("lists and reads links, requests and responses", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/vendor-intake-links")), "vendorIntakeLinks.list");
    await expectContract(
      await success(http.get(`/vendor-intake-requests/${REQUEST}`)),
      "vendorIntakeRequests.get",
    );
    await expectContract(await success(http.get("/form-links")), "formLinks.list");
    await expectContract(
      await success(http.get(`/form-link-responses/${RESPONSE}`)),
      "formLinkResponses.get",
    );
  });
});

describe("Platform: outside access", () => {
  it("lists what reaches a project, with no token or code", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get(`/outside-access?filter[project_id][eq]=${PROJECT}`)),
      "outsideAccess.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["source"]).toBe("Intake link");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("token");
  });
});
