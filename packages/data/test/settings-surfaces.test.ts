import { describe, expect, it } from "vitest";
import { getScheduledWorkSummary } from "../src/scheduled-work.ts";
import { listMyConnectedApps, revokeConnectedApp } from "../src/connected-apps.ts";
import {
  getClassificationSummary,
  listDataRequests,
  listExportJobs,
  listLegalHolds,
  listRetentionPolicies,
  moveDataRequest,
  placeLegalHold,
  releaseLegalHold,
} from "../src/data-privacy.ts";
import {
  capabilityGroupsOf,
  createApiKey,
  createPersonalToken,
  createServiceAccount,
  listApiKeys,
  listCapabilityGroups,
  listOrgsAllowingPersonalTokens,
  listPersonalTokens,
  listServiceAccounts,
  orgAllowsPersonalTokens,
  retireServiceAccount,
  revokeApiKey,
  revokePersonalToken,
} from "../src/developer.ts";
import {
  addCustomFieldChoice,
  addSpendAuthority,
  createCustomField,
  fieldKeyFrom,
  listCustomFields,
  listCustomFieldTargets,
  listSeparationOptions,
  listSeparationRules,
  listSpendAuthorities,
  removeCustomField,
  removeSpendAuthority,
  setSeparationOption,
} from "../src/governance.ts";
import {
  departmentsInUse,
  getDepartmentsInUse,
  getLocationDefaults,
  NO_LOCATION_DEFAULTS,
  setDepartmentsInUse,
  setLocationDefaults,
  venueStartValues,
} from "../src/org-setup.ts";
import { getOrgUsage } from "../src/usage.ts";
import {
  createWebhookEndpoint,
  listEventTypes,
  listWebhookDeliveries,
  listWebhookEndpoints,
  removeWebhookEndpoint,
  replayWebhookDelivery,
  setWebhookEndpointDisabled,
} from "../src/webhooks.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

/** Repositories behind the A86 settings surfaces (RRR-131, finding A65-004; migrations 1430 to 1433). */

const denied = () => errorResponse("42501", "denied");
const refused = (rule: string) => errorResponse("XR001", `${rule}: Refused.`);

describe("org setup (1430, 1431)", () => {
  it("reads and replaces the departments in use", async () => {
    const { db, calls } = commercialClient({
      "from:org_departments_in_use": [okResponse([{ dept_code: "5000" }]), denied()],
      "from:org_disciplines_in_use": [okResponse([{ disc_code: "5000.01" }]), okResponse([])],
      "rpc:set_departments_in_use": [okResponse(null), refused("discipline_department_not_in_use")],
    });
    expect(await getDepartmentsInUse(db, "org-1")).toEqual({
      ok: true,
      data: { departments: ["5000"], disciplines: ["5000.01"] },
    });
    expect((await getDepartmentsInUse(db, "org-1")).ok).toBe(false);
    const choice = { departments: ["5000"], disciplines: ["5000.01"] };
    expect(await setDepartmentsInUse(db, "org-1", choice)).toEqual({ ok: true, data: null });
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [{ p_org_id: "org-1", p_dept_codes: ["5000"], p_disc_codes: ["5000.01"] }],
    ]);
    const refusal = await setDepartmentsInUse(db, "org-1", choice);
    expect(!refusal.ok && refusal.error.kind).toBe("refusal");
  });

  it("narrows pickers only once the org chose, keeping what must stay visible", () => {
    const all = [{ code: "0000" }, { code: "5000" }, { code: "6000" }];
    expect(departmentsInUse(all, [])).toEqual(all);
    expect(departmentsInUse(all, ["5000"])).toEqual([{ code: "5000" }]);
    expect(departmentsInUse(all, ["5000"], ["6000"])).toEqual([{ code: "5000" }, { code: "6000" }]);
  });

  it("reads and records location defaults, and starts a new venue from them", async () => {
    const { db, calls } = commercialClient({
      "from:org_location_defaults": [
        okResponse({ jurisdiction_id: "US-FL", time_zone: "America/New_York" }),
        okResponse(null),
        denied(),
      ],
      "rpc:set_location_defaults": [okResponse("id-1"), refused("jurisdiction_unknown")],
    });
    const defaults = await getLocationDefaults(db, "org-1");
    expect(defaults).toEqual({
      ok: true,
      data: { jurisdictionId: "US-FL", timeZone: "America/New_York" },
    });
    expect(await getLocationDefaults(db, "org-1")).toEqual({
      ok: true,
      data: NO_LOCATION_DEFAULTS,
    });
    expect((await getLocationDefaults(db, "org-1")).ok).toBe(false);
    expect((await setLocationDefaults(db, "org-1", NO_LOCATION_DEFAULTS)).ok).toBe(true);
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [{ p_org_id: "org-1", p_jurisdiction_id: "", p_time_zone: "" }],
    ]);
    expect((await setLocationDefaults(db, "org-1", NO_LOCATION_DEFAULTS)).ok).toBe(false);
    if (!defaults.ok) throw new Error("defaults");
    expect(venueStartValues(defaults.data, "US", "Europe/Paris")).toEqual({
      jurisdictionId: "US-FL",
      timeZone: "America/New_York",
    });
    expect(venueStartValues(NO_LOCATION_DEFAULTS, "US", "Europe/Paris")).toEqual({
      jurisdictionId: "US",
      timeZone: "Europe/Paris",
    });
    expect(venueStartValues(NO_LOCATION_DEFAULTS, null, "UTC").jurisdictionId).toBe("");
  });
});

describe("API access (0921, 0922, 1432)", () => {
  it("lists capability groups and the groups a person holds", async () => {
    const { db } = commercialClient({
      "from:capabilities": [
        okResponse([
          { code: "work.record.read" },
          { code: "org.settings.read" },
          { code: "work.x" },
        ]),
        denied(),
      ],
    });
    expect(await listCapabilityGroups(db)).toEqual({ ok: true, data: ["org", "work"] });
    expect((await listCapabilityGroups(db)).ok).toBe(false);
    expect(capabilityGroupsOf(["work.a", "projects.b", "work.c"])).toEqual(["projects", "work"]);
  });

  it("lists, creates and revokes org API keys", async () => {
    const key = {
      id: "k1",
      name: "Sync",
      prefix: "xos_live_0a1b2c3d",
      scopes: ["work"],
      service_account_id: "sa1",
      expires_at: "2027-01-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
    };
    const { db, calls } = commercialClient({
      "from:api_keys": [okResponse([key]), denied()],
      "rpc:create_api_key": [
        okResponse([{ api_key_id: "k2", secret: "s" }]),
        okResponse([{ api_key_id: "k3", secret: "t" }]),
        okResponse([]),
        refused("plan_feature_required"),
      ],
      "rpc:revoke_api_key": [okResponse(null), refused("api_key_revoked")],
    });
    expect(await listApiKeys(db, "org-1")).toEqual({
      ok: true,
      data: [
        {
          id: "k1",
          name: "Sync",
          prefix: "xos_live_0a1b2c3d",
          scopes: ["work"],
          serviceAccountId: "sa1",
          expiresAt: "2027-01-01T00:00:00Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    expect((await listApiKeys(db, "org-1")).ok).toBe(false);
    const input = { orgId: "org-1", name: "Sync", scopes: ["work"], expiresAt: "2027-01-01" };
    expect(await createApiKey(db, { ...input, serviceAccountId: "sa1" })).toEqual({
      ok: true,
      data: { id: "k2", secret: "s" },
    });
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([
      {
        p_org_id: "org-1",
        p_name: "Sync",
        p_scopes: ["work"],
        p_expires_at: "2027-01-01",
        p_service_account_id: "sa1",
      },
    ]);
    expect((await createApiKey(db, { ...input, serviceAccountId: null })).ok).toBe(true);
    expect((await createApiKey(db, { ...input, serviceAccountId: null })).ok).toBe(false);
    expect((await createApiKey(db, { ...input, serviceAccountId: null })).ok).toBe(false);
    expect((await revokeApiKey(db, "k1")).ok).toBe(true);
    expect((await revokeApiKey(db, "k1")).ok).toBe(false);
  });

  it("lists, creates and retires service accounts", async () => {
    const { db, calls } = commercialClient({
      "from:service_accounts": [
        okResponse([{ id: "sa1", name: "Bot", expires_at: null, created_at: "2026-10-01" }]),
        denied(),
      ],
      "rpc:create_service_account": [okResponse("sa2"), okResponse("sa3"), denied()],
      "rpc:retire_service_account": [okResponse(null), denied()],
    });
    expect(await listServiceAccounts(db, "org-1")).toEqual({
      ok: true,
      data: [{ id: "sa1", name: "Bot", expiresAt: null, createdAt: "2026-10-01" }],
    });
    expect((await listServiceAccounts(db, "org-1")).ok).toBe(false);
    const input = { orgId: "org-1", name: "Bot", roleId: "r1", expiresAt: null };
    expect(await createServiceAccount(db, input)).toEqual({ ok: true, data: { id: "sa2" } });
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([
      { p_org_id: "org-1", p_name: "Bot", p_role_id: "r1" },
    ]);
    expect((await createServiceAccount(db, { ...input, expiresAt: "2027-01-01" })).ok).toBe(true);
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([
      { p_org_id: "org-1", p_name: "Bot", p_role_id: "r1", p_expires_at: "2027-01-01" },
    ]);
    expect((await createServiceAccount(db, input)).ok).toBe(false);
    expect((await retireServiceAccount(db, "sa1")).ok).toBe(true);
    expect((await retireServiceAccount(db, "sa1")).ok).toBe(false);
  });

  it("lists, creates and revokes personal tokens, and reads whether the org allows them", async () => {
    const row = {
      id: "t1",
      org_id: "org-1",
      person_id: "p1",
      name: "Laptop",
      prefix: "xos_pat_0a1b2c3d",
      expires_at: "2027-01-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
      organizations: { name: "Northwind Live" },
      personal_access_token_scopes: [
        { scope: "work", deleted_at: null },
        { scope: "finance", deleted_at: "2026-10-02" },
        { scope: "projects", deleted_at: null },
      ],
    };
    const { db, calls } = commercialClient({
      "from:personal_access_tokens": [
        okResponse([row]),
        okResponse([{ ...row, organizations: null, personal_access_token_scopes: null }]),
        denied(),
      ],
      "rpc:create_personal_access_token": [
        okResponse([{ personal_access_token_id: "t2", secret: "x" }]),
        okResponse([]),
        refused("personal_tokens_off"),
      ],
      "rpc:revoke_personal_access_token": [okResponse(null), denied()],
      "rpc:org_allows_personal_tokens": [okResponse(true), okResponse(null), denied()],
      "rpc:my_orgs_allowing_personal_tokens": [
        okResponse([{ org_id: "org-1", org_name: "Northwind Live" }]),
        okResponse(null),
        denied(),
      ],
    });
    const listed = await listPersonalTokens(db, { personId: "p1", orgId: "org-1" });
    expect(listed.ok && listed.data[0]).toEqual({
      id: "t1",
      orgId: "org-1",
      orgName: "Northwind Live",
      personId: "p1",
      name: "Laptop",
      prefix: "xos_pat_0a1b2c3d",
      scopes: ["projects", "work"],
      expiresAt: "2027-01-01T00:00:00Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["person_id", "p1"]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "org-1"]]);
    const bare = await listPersonalTokens(db, {});
    expect(bare.ok && bare.data[0]?.orgName).toBe(null);
    expect((await listPersonalTokens(db, {})).ok).toBe(false);
    const input = { orgId: "org-1", name: "Laptop", scopes: ["work"], expiresAt: "2027-01-01" };
    expect(await createPersonalToken(db, input)).toEqual({
      ok: true,
      data: { id: "t2", secret: "x" },
    });
    expect((await createPersonalToken(db, input)).ok).toBe(false);
    const off = await createPersonalToken(db, input);
    expect(!off.ok && off.error.kind === "refusal" && off.error.rule).toBe("personal_tokens_off");
    expect((await revokePersonalToken(db, "t1")).ok).toBe(true);
    expect((await revokePersonalToken(db, "t1")).ok).toBe(false);
    expect(await orgAllowsPersonalTokens(db, "org-1")).toEqual({ ok: true, data: true });
    expect(await orgAllowsPersonalTokens(db, "org-1")).toEqual({ ok: true, data: false });
    expect((await orgAllowsPersonalTokens(db, "org-1")).ok).toBe(false);
    expect(await listOrgsAllowingPersonalTokens(db)).toEqual({
      ok: true,
      data: [{ id: "org-1", name: "Northwind Live" }],
    });
    expect(await listOrgsAllowingPersonalTokens(db)).toEqual({ ok: true, data: [] });
    expect((await listOrgsAllowingPersonalTokens(db)).ok).toBe(false);
  });
});

describe("webhooks (0510)", () => {
  it("lists event types and endpoints, creates, pauses and removes endpoints", async () => {
    const { db } = commercialClient({
      "from:domain_event_catalog": [
        okResponse([
          { code: "project.created", subject: "project", description: "A project was created." },
          { code: null, subject: null, description: null },
          { code: "x.y", subject: null, description: null },
        ]),
        denied(),
      ],
      "from:webhook_endpoints": [
        okResponse([
          {
            id: "w1",
            url: "https://hooks.example.com/x",
            description: null,
            disabled_at: null,
            webhook_endpoint_events: [
              { event_type: "project.created", deleted_at: null },
              { event_type: "gone.event", deleted_at: "2026-10-01" },
            ],
          },
          {
            id: "w2",
            url: "https://b.example.com",
            description: "B",
            disabled_at: "2026-10-01",
            webhook_endpoint_events: null,
          },
        ]),
        denied(),
        okResponse([{ id: "w1" }]),
        okResponse([]),
        denied(),
        okResponse([{ id: "w1" }]),
        okResponse([]),
        denied(),
      ],
      "rpc:create_webhook_endpoint": [
        okResponse([{ webhook_endpoint_id: "w3", signing_secret: "whsec" }]),
        okResponse([{ webhook_endpoint_id: "w4", signing_secret: "whsec2" }]),
        okResponse([]),
        refused("plan_feature_required"),
      ],
    });
    const types = await listEventTypes(db);
    expect(types.ok && types.data.map((t) => t.code)).toEqual(["project.created", "x.y"]);
    expect((await listEventTypes(db)).ok).toBe(false);
    const endpoints = await listWebhookEndpoints(db, "org-1");
    expect(endpoints.ok && endpoints.data.map((e) => e.events)).toEqual([["project.created"], []]);
    expect((await listWebhookEndpoints(db, "org-1")).ok).toBe(false);
    expect((await setWebhookEndpointDisabled(db, "w1", true)).ok).toBe(true);
    expect((await setWebhookEndpointDisabled(db, "w1", false)).ok).toBe(false);
    expect((await setWebhookEndpointDisabled(db, "w1", false)).ok).toBe(false);
    expect((await removeWebhookEndpoint(db, "w1")).ok).toBe(true);
    expect((await removeWebhookEndpoint(db, "w1")).ok).toBe(false);
    expect((await removeWebhookEndpoint(db, "w1")).ok).toBe(false);
    const input = { orgId: "org-1", url: "https://hooks.example.com", events: ["project.created"] };
    expect(await createWebhookEndpoint(db, { ...input, description: "Mine" })).toEqual({
      ok: true,
      data: { id: "w3", secret: "whsec" },
    });
    expect((await createWebhookEndpoint(db, { ...input, description: null })).ok).toBe(true);
    expect((await createWebhookEndpoint(db, { ...input, description: null })).ok).toBe(false);
    expect((await createWebhookEndpoint(db, { ...input, description: null })).ok).toBe(false);
  });

  it("lists deliveries and replays one", async () => {
    const { db, calls } = commercialClient({
      "from:webhook_deliveries": [
        okResponse([
          {
            id: "d1",
            webhook_endpoint_id: "w1",
            delivery_status: "Delivered",
            attempt_count: 1,
            last_response_status: 200,
            last_error: null,
            created_at: "2026-10-21T10:00:00Z",
            delivered_at: "2026-10-21T10:00:01Z",
            replay_requested_by: "p1",
          },
        ]),
        denied(),
      ],
      "rpc:replay_webhook_delivery": [okResponse("d2"), denied()],
    });
    const deliveries = await listWebhookDeliveries(db, "org-1", 500);
    expect(deliveries.ok && deliveries.data[0]?.replay).toBe(true);
    expect(calls[0]?.steps).toContainEqual(["limit", [100]]);
    expect((await listWebhookDeliveries(db, "org-1")).ok).toBe(false);
    expect(await replayWebhookDelivery(db, "d1")).toEqual({ ok: true, data: { id: "d2" } });
    expect((await replayWebhookDelivery(db, "d1")).ok).toBe(false);
  });
});

describe("governance (0320, 0540, 1150, 2280)", () => {
  it("lists, adds and removes spend limits", async () => {
    const { db, calls } = commercialClient({
      "from:spend_authorities": [
        okResponse([
          {
            id: "s1",
            role_id: "r1",
            membership_id: null,
            document_type: "Purchase Order",
            currency_code: "USD",
            limit_minor: 500000,
            dual_approval_above_minor: null,
            valid_from: "2026-10-01",
            valid_to: null,
            account_code: "6100",
            cost_center_id: null,
          },
        ]),
        denied(),
        okResponse({ id: "s2" }),
        okResponse({ id: "s3" }),
        refused("sod_self_grant"),
        okResponse([{ id: "s1" }]),
        okResponse([]),
        denied(),
      ],
    });
    const limits = await listSpendAuthorities(db, "org-1");
    expect(limits.ok && limits.data[0]?.narrowed).toBe(true);
    expect((await listSpendAuthorities(db, "org-1")).ok).toBe(false);
    const base = {
      orgId: "org-1",
      documentType: "Expense" as const,
      currencyCode: "USD",
      limitMinor: 1000,
      dualApprovalAboveMinor: null,
    };
    expect(await addSpendAuthority(db, { ...base, holder: { roleId: "r1" } })).toEqual({
      ok: true,
      data: { id: "s2" },
    });
    expect(calls.at(-1)?.steps).toContainEqual([
      "insert",
      [
        {
          org_id: "org-1",
          role_id: "r1",
          membership_id: null,
          document_type: "Expense",
          currency_code: "USD",
          limit_minor: 1000,
          dual_approval_above_minor: null,
        },
      ],
    ]);
    expect((await addSpendAuthority(db, { ...base, holder: { membershipId: "m1" } })).ok).toBe(
      true,
    );
    const self = await addSpendAuthority(db, { ...base, holder: { roleId: "r1" } });
    expect(!self.ok && self.error.kind === "refusal" && self.error.rule).toBe("sod_self_grant");
    expect((await removeSpendAuthority(db, "s1")).ok).toBe(true);
    expect((await removeSpendAuthority(db, "s1")).ok).toBe(false);
    expect((await removeSpendAuthority(db, "s1")).ok).toBe(false);
  });

  it("lists separation of duties rules", async () => {
    const { db } = commercialClient({
      "from:separation_of_duties_rules": [
        okResponse([
          {
            code: "sod_self_grant",
            enforced_on: "spend_authorities",
            description: "No self grants.",
          },
          { code: null, enforced_on: null, description: null },
          { code: "sod_x", enforced_on: null, description: null },
        ]),
        denied(),
      ],
    });
    const rules = await listSeparationRules(db);
    expect(rules.ok && rules.data).toEqual([
      { code: "sod_self_grant", enforcedOn: "spend_authorities", description: "No self grants." },
      { code: "sod_x", enforcedOn: "", description: "" },
    ]);
    expect((await listSeparationRules(db)).ok).toBe(false);
  });

  it("lists the stricter options with whether the org switched them on, and switches them (2280)", async () => {
    const { db, calls } = commercialClient({
      "from:separation_of_duties_options": [
        okResponse([
          {
            code: "sod_document_creator",
            tightens: "sod_approval_requester",
            enforced_on: "Purchase orders",
            description: "Whoever created it cannot approve it.",
          },
          {
            code: "sod_receiver_po_approver",
            tightens: null,
            enforced_on: null,
            description: null,
          },
          { code: null, tightens: null, enforced_on: null, description: null },
        ]),
        okResponse([]),
      ],
      "from:org_separation_of_duties_options": [
        okResponse([{ rule_code: "sod_document_creator" }]),
        denied(),
      ],
      "rpc:set_separation_of_duties_option": [
        okResponse(true),
        refused("separation_option_unknown"),
        denied(),
      ],
    });
    expect(await listSeparationOptions(db, "org-1")).toEqual({
      ok: true,
      data: [
        {
          code: "sod_document_creator",
          tightens: "sod_approval_requester",
          enforcedOn: "Purchase orders",
          description: "Whoever created it cannot approve it.",
          on: true,
        },
        {
          code: "sod_receiver_po_approver",
          tightens: "",
          enforcedOn: "",
          description: "",
          on: false,
        },
      ],
    });
    expect((await listSeparationOptions(db, "org-1")).ok).toBe(false);
    expect(await setSeparationOption(db, "org-1", "sod_document_creator", true)).toEqual({
      ok: true,
      data: null,
    });
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [{ p_org_id: "org-1", p_rule_code: "sod_document_creator", p_on: true }],
    ]);
    const builtIn = await setSeparationOption(db, "org-1", "sod_po_creator", false);
    expect(!builtIn.ok && builtIn.error.kind === "refusal" && builtIn.error.rule).toBe(
      "separation_option_unknown",
    );
    expect((await setSeparationOption(db, "org-1", "sod_document_creator", false)).ok).toBe(false);
  });

  it("lists targets and fields, creates and removes fields and adds choices", async () => {
    const { db } = commercialClient({
      "from:custom_field_targets": [
        okResponse([
          { table_name: "app.venues" },
          { table_name: null },
          { table_name: "app.projects" },
        ]),
        denied(),
      ],
      "from:custom_field_definitions": [
        okResponse([
          {
            id: "f1",
            target_table: "app.projects",
            field_key: "tier",
            label: "Tier",
            data_type: "Choice",
            required: false,
            filterable: true,
            sort_order: 10,
            custom_field_choices: [
              { id: "c2", choice_key: "b", label: "B", sort_order: 20, deleted_at: null },
              { id: "c1", choice_key: "a", label: "A", sort_order: 10, deleted_at: null },
              { id: "c3", choice_key: "z", label: "Z", sort_order: 5, deleted_at: "2026-10-01" },
            ],
          },
          {
            id: "f2",
            target_table: "app.venues",
            field_key: "dock",
            label: "Dock",
            data_type: "Text",
            required: true,
            filterable: false,
            sort_order: 20,
            custom_field_choices: null,
          },
        ]),
        denied(),
        okResponse({ id: "f3" }),
        errorResponse("23505", "duplicate"),
        okResponse([{ id: "f1" }]),
        okResponse([]),
        denied(),
      ],
      "from:custom_field_choices": [okResponse({ id: "c4" }), denied()],
    });
    expect(await listCustomFieldTargets(db)).toEqual({
      ok: true,
      data: ["app.projects", "app.venues"],
    });
    expect((await listCustomFieldTargets(db)).ok).toBe(false);
    const fields = await listCustomFields(db, "org-1");
    expect(fields.ok && fields.data[0]?.choices.map((c) => c.key)).toEqual(["a", "b"]);
    expect(fields.ok && fields.data[1]?.choices).toEqual([]);
    expect((await listCustomFields(db, "org-1")).ok).toBe(false);
    const input = {
      orgId: "org-1",
      targetTable: "app.projects",
      key: "tier",
      label: "Tier",
      dataType: "Choice" as const,
      required: false,
      filterable: true,
      sortOrder: 10,
    };
    expect(await createCustomField(db, input)).toEqual({ ok: true, data: { id: "f3" } });
    const duplicate = await createCustomField(db, input);
    expect(!duplicate.ok && duplicate.error.kind).toBe("conflict");
    expect((await removeCustomField(db, "f1")).ok).toBe(true);
    expect((await removeCustomField(db, "f1")).ok).toBe(false);
    expect((await removeCustomField(db, "f1")).ok).toBe(false);
    const choice = { orgId: "org-1", fieldId: "f1", key: "c", label: "C", sortOrder: 30 };
    expect(await addCustomFieldChoice(db, choice)).toEqual({ ok: true, data: { id: "c4" } });
    expect((await addCustomFieldChoice(db, choice)).ok).toBe(false);
  });

  it("derives a field key from a label", () => {
    expect(fieldKeyFrom("Dock door #3")).toBe("dock_door_3");
    expect(fieldKeyFrom("Año fiscal")).toBe("ano_fiscal");
    expect(fieldKeyFrom("3rd party")).toBe("rd_party");
    expect(fieldKeyFrom("!!!")).toBe("");
  });
});

describe("data and privacy (0500, 0501, 0530)", () => {
  it("lists data requests with their clock, open ones first, and moves one", async () => {
    const request = (id: string, state: string, received: string) => ({
      id,
      request_type: "Access",
      dsar_state: state,
      subject_email: `${id}@example.com`,
      details: null,
      received_at: received,
    });
    const { db, calls } = commercialClient({
      "from:dsar_requests": [
        okResponse([
          request("r1", "Completed", "2026-10-03"),
          request("r2", "Received", "2026-10-02"),
          request("r3", "In Progress", "2026-10-01"),
        ]),
        okResponse([]),
        denied(),
      ],
      "from:dsar_request_clock": [
        okResponse([
          { dsar_request_id: "r2", due_at: "2026-11-01", is_overdue: false },
          { dsar_request_id: "r3", due_at: "2026-10-31", is_overdue: true },
        ]),
        denied(),
        okResponse([]),
      ],
      "rpc:transition_dsar": [okResponse("x"), refused("dsar_state_conflict")],
    });
    const requests = await listDataRequests(db, "org-1");
    expect(requests.ok && requests.data.map((r) => [r.id, r.overdue])).toEqual([
      ["r3", true],
      ["r2", false],
      ["r1", false],
    ]);
    expect((await listDataRequests(db, "org-1")).ok).toBe(false);
    expect((await listDataRequests(db, "org-1")).ok).toBe(false);
    const move = {
      id: "r2",
      expected: "Received" as const,
      next: "Verifying" as const,
      reason: "ID check",
    };
    expect((await moveDataRequest(db, move)).ok).toBe(true);
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([
      {
        p_dsar_request_id: "r2",
        p_expected: "Received",
        p_next: "Verifying",
        p_reason: "ID check",
      },
    ]);
    expect((await moveDataRequest(db, move)).ok).toBe(false);
  });

  it("lists, places and releases legal holds", async () => {
    const { db } = commercialClient({
      "from:legal_holds": [
        okResponse([
          {
            id: "h1",
            matter: "Smith v. Northwind",
            table_name: null,
            placed_at: "2026-10-01",
            released_at: null,
          },
        ]),
        denied(),
        okResponse({ id: "h2" }),
        denied(),
        okResponse([{ id: "h1" }]),
        okResponse([]),
        denied(),
      ],
    });
    const holds = await listLegalHolds(db, "org-1");
    expect(holds.ok && holds.data[0]?.matter).toBe("Smith v. Northwind");
    expect((await listLegalHolds(db, "org-1")).ok).toBe(false);
    const input = { orgId: "org-1", matter: "Smith", tableName: null };
    expect(await placeLegalHold(db, input)).toEqual({ ok: true, data: { id: "h2" } });
    expect((await placeLegalHold(db, input)).ok).toBe(false);
    expect((await releaseLegalHold(db, "h1")).ok).toBe(true);
    expect((await releaseLegalHold(db, "h1")).ok).toBe(false);
    expect((await releaseLegalHold(db, "h1")).ok).toBe(false);
  });

  it("reads retention, classification and exports", async () => {
    const { db } = commercialClient({
      "from:retention_policies": [
        okResponse([
          { table_name: "app.audit_events", retention: "7 years", basis: "Age", rationale: "Law" },
          { table_name: null, retention: null, basis: null, rationale: null },
          { table_name: "app.x", retention: null, basis: null, rationale: null },
        ]),
        denied(),
      ],
      "from:column_classifications": [
        okResponse([
          {
            table_name: "app.tax_forms",
            column_name: "tin_encrypted",
            classification: "Restricted",
            read_capability: "data.restricted.read.tax",
          },
          {
            table_name: "app.people",
            column_name: "email",
            classification: "Confidential",
            read_capability: null,
          },
          {
            table_name: "app.a",
            column_name: "b",
            classification: "Restricted",
            read_capability: null,
          },
          { table_name: null, column_name: null, classification: null, read_capability: null },
        ]),
        denied(),
      ],
      "from:export_jobs": [
        okResponse([
          {
            id: "e1",
            source_label: "Projects",
            export_format: "CSV",
            export_status: "Ready",
            classification: "Internal",
            row_count: 3,
            created_at: "2026-10-01",
          },
        ]),
        denied(),
      ],
    });
    const retention = await listRetentionPolicies(db);
    expect(retention.ok && retention.data.map((r) => r.tableName)).toEqual([
      "app.audit_events",
      "app.x",
    ]);
    expect((await listRetentionPolicies(db)).ok).toBe(false);
    const summary = await getClassificationSummary(db);
    expect(summary.ok && summary.data.counts).toEqual({
      Public: 0,
      Internal: 0,
      Confidential: 1,
      Restricted: 2,
    });
    expect(summary.ok && summary.data.restricted.map((r) => r.table)).toEqual([
      "app.a",
      "app.tax_forms",
    ]);
    expect((await getClassificationSummary(db)).ok).toBe(false);
    const exports = await listExportJobs(db, "org-1", 0);
    expect(exports.ok && exports.data[0]?.rowCount).toBe(3);
    expect((await listExportJobs(db, "org-1")).ok).toBe(false);
  });
});

describe("usage, connected apps and automations (1433)", () => {
  it("groups usage by period, open month first", async () => {
    const { db } = commercialClient({
      "rpc:org_usage": [
        okResponse([
          {
            period_start: "2026-10-01",
            meter_code: "emails_sent",
            unit: "message",
            quantity: 5,
            closed: false,
          },
          {
            period_start: "2026-10-01",
            meter_code: "sms_segments",
            unit: "segment",
            quantity: 0,
            closed: false,
          },
          {
            period_start: "2026-08-01",
            meter_code: "emails_sent",
            unit: "message",
            quantity: 9,
            closed: true,
          },
          {
            period_start: "2026-09-01",
            meter_code: "emails_sent",
            unit: "message",
            quantity: 7,
            closed: true,
          },
        ]),
        okResponse(null),
        denied(),
      ],
    });
    const usage = await getOrgUsage(db, "org-1");
    expect(usage.ok && usage.data.map((p) => [p.periodStart, p.closed, p.lines.length])).toEqual([
      ["2026-10-01", false, 2],
      ["2026-09-01", true, 1],
      ["2026-08-01", true, 1],
    ]);
    expect(await getOrgUsage(db, "org-1")).toEqual({ ok: true, data: [] });
    expect((await getOrgUsage(db, "org-1")).ok).toBe(false);
  });

  it("lists and revokes the person's connected apps", async () => {
    const { db } = commercialClient({
      "rpc:my_oauth_grants": [
        okResponse([
          {
            oauth_grant_id: "g1",
            org_id: "org-1",
            org_name: "Northwind Live",
            app_name: "Show Planner",
            scopes: ["work"],
            granted_at: "2026-10-01",
          },
        ]),
        okResponse(null),
        denied(),
      ],
      "from:oauth_grants": [okResponse([{ id: "g1" }]), okResponse([]), denied()],
    });
    const apps = await listMyConnectedApps(db);
    expect(apps.ok && apps.data[0]?.appName).toBe("Show Planner");
    expect(await listMyConnectedApps(db)).toEqual({ ok: true, data: [] });
    expect((await listMyConnectedApps(db)).ok).toBe(false);
    expect((await revokeConnectedApp(db, "g1")).ok).toBe(true);
    expect((await revokeConnectedApp(db, "g1")).ok).toBe(false);
    expect((await revokeConnectedApp(db, "g1")).ok).toBe(false);
  });

  it("summarizes what runs on its own", async () => {
    const schedule = {
      id: "rs1",
      cadence: "Weekly",
      next_run_at: "2026-10-27T13:00:00Z",
      time_zone: "America/New_York",
      paused_at: null,
      report_definitions: { name: "Weekly cost" },
    };
    const { db } = commercialClient({
      "from:report_schedules": [
        okResponse([
          schedule,
          { ...schedule, id: "rs2", paused_at: "2026-10-01", report_definitions: null },
        ]),
        denied(),
        okResponse([]),
        okResponse([]),
        okResponse([]),
      ],
      "from:record_recurrences": [
        okResponse(null),
        okResponse(null),
        denied(),
        okResponse(null),
        okResponse(null),
      ],
      "from:approval_policies": [
        okResponse(null),
        okResponse(null),
        okResponse(null),
        denied(),
        okResponse(null),
      ],
      "from:webhook_endpoints": [
        okResponse(null),
        okResponse(null),
        okResponse(null),
        okResponse(null),
        denied(),
      ],
    });
    const summary = await getScheduledWorkSummary(db, "org-1");
    expect(summary.ok && summary.data).toEqual({
      scheduledReports: [
        {
          id: "rs1",
          reportName: "Weekly cost",
          cadence: "Weekly",
          nextRunAt: "2026-10-27T13:00:00Z",
          timeZone: "America/New_York",
          paused: false,
        },
        {
          id: "rs2",
          reportName: "",
          cadence: "Weekly",
          nextRunAt: "2026-10-27T13:00:00Z",
          timeZone: "America/New_York",
          paused: true,
        },
      ],
      recurringRecords: 0,
      activeApprovalPolicies: 0,
      liveWebhooks: 0,
    });
    expect((await getScheduledWorkSummary(db, "org-1")).ok).toBe(false);
    expect((await getScheduledWorkSummary(db, "org-1")).ok).toBe(false);
    expect((await getScheduledWorkSummary(db, "org-1")).ok).toBe(false);
    expect((await getScheduledWorkSummary(db, "org-1")).ok).toBe(false);
  });
});
