import { describe, expect, it } from "vitest";
import {
  deleteAutomation,
  getAutomationDefinition,
  listAutomationEventTypes,
  listAutomationRuns,
  listAutomationRunSteps,
  listAutomations,
  listWebhookEndpointOptions,
  retryAutomationRun,
  sampleAutomationEvent,
  saveAutomation,
  setAutomationEnabled,
  testAutomation,
} from "../src/automations.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const AUTO = "0192f1e2-7c3a-7b4d-9e8f-000000091001";
const RUN = "0192f1e2-7c3a-7b4d-9e8f-000000091002";

describe("automations (1480, 1481)", () => {
  it("lists the org's automations with each one's latest run", async () => {
    const { db, calls } = commercialClient({
      "from:automations": [
        okResponse([
          {
            id: AUTO,
            name: "Pick up tasks",
            description: null,
            trigger_event_type: "record.created",
            enabled: true,
            paused_at: null,
            pause_reason: null,
            owner_person_id: "p1",
            updated_at: "2026-10-21T10:00:00Z",
            owner: { full_name: "Bob Okafor" },
          },
          {
            id: "other",
            name: "Quiet",
            description: "Never ran",
            trigger_event_type: "shipment.created",
            enabled: false,
            paused_at: "2026-10-21T09:00:00Z",
            pause_reason: "owner_left_org",
            owner_person_id: "p2",
            updated_at: "2026-10-21T09:00:00Z",
            owner: null,
          },
        ]),
        errorResponse("42501", "denied"),
      ],
      "from:automation_runs": [
        okResponse([
          { automation_id: AUTO, run_status: "Succeeded", created_at: "2026-10-21T11:00:00Z" },
          { automation_id: AUTO, run_status: "Failed", created_at: "2026-10-21T10:30:00Z" },
        ]),
      ],
    });
    const result = await listAutomations(db, "org-1");
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          id: AUTO,
          ownerName: "Bob Okafor",
          lastRun: { status: "Succeeded", at: "2026-10-21T11:00:00Z" },
        },
        { id: "other", ownerName: null, pauseReason: "owner_left_org", lastRun: null },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "org-1"]]);
    expect((await listAutomations(db, "org-1")).ok).toBe(false);
  });

  it("reads a definition and writes through the RPCs", async () => {
    const { db, calls } = commercialClient({
      "rpc:automation_definition": [
        okResponse({ conditions: { any: [] }, actions: [{ type: "add_comment", body: "Hi" }] }),
        okResponse(null),
        errorResponse("42501", "automation not found"),
      ],
      "rpc:save_automation": [
        okResponse(AUTO),
        errorResponse("XR001", "plan_feature_required: Pro"),
      ],
      "rpc:set_automation_enabled": [okResponse(null), errorResponse("XR001", "x: y")],
      "rpc:delete_automation": [okResponse(null), errorResponse("42501", "no")],
      "rpc:retry_automation_run": [
        okResponse(null),
        errorResponse("XR001", "automation_run_not_failed: no"),
      ],
    });
    expect(await getAutomationDefinition(db, AUTO)).toEqual({
      ok: true,
      data: { conditions: { any: [] }, actions: [{ type: "add_comment", body: "Hi" }] },
    });
    expect(await getAutomationDefinition(db, AUTO)).toEqual({
      ok: true,
      data: { conditions: { all: [] }, actions: [] },
    });
    expect((await getAutomationDefinition(db, AUTO)).ok).toBe(false);

    const input = {
      orgId: "org-1",
      id: null,
      name: "Pick up tasks",
      description: null,
      triggerEventType: "record.created",
      conditions: { all: [] },
      actions: [{ type: "add_comment", body: "Hi" }],
      enabled: true,
      expectedUpdatedAt: "2026-10-21T10:00:00Z",
    };
    expect(await saveAutomation(db, input)).toEqual({ ok: true, data: AUTO });
    const save = calls.find((c) => c.target === "rpc:save_automation");
    expect(JSON.stringify(save?.steps)).toContain("p_expected_updated_at");
    expect((await saveAutomation(db, { ...input, expectedUpdatedAt: null })).ok).toBe(false);
    expect((await setAutomationEnabled(db, AUTO, false)).ok).toBe(true);
    expect((await setAutomationEnabled(db, AUTO, true)).ok).toBe(false);
    expect((await deleteAutomation(db, AUTO)).ok).toBe(true);
    expect((await deleteAutomation(db, AUTO)).ok).toBe(false);
    expect((await retryAutomationRun(db, RUN)).ok).toBe(true);
    expect((await retryAutomationRun(db, RUN)).ok).toBe(false);
  });

  it("runs the dry run and finds a sample event", async () => {
    const { db } = commercialClient({
      "rpc:test_automation": [
        okResponse({ matched: true, conditions: [] }),
        errorResponse("XR001", "automation_event_invalid: no"),
      ],
      "rpc:sample_automation_event": [
        okResponse({ type: "record.created", data: {} }),
        errorResponse("42501", "no"),
      ],
    });
    expect(await testAutomation(db, AUTO, { data: {} })).toEqual({
      ok: true,
      data: { matched: true, conditions: [] },
    });
    expect((await testAutomation(db, AUTO, {})).ok).toBe(false);
    expect(await sampleAutomationEvent(db, "org-1", "record.created")).toEqual({
      ok: true,
      data: { type: "record.created", data: {} },
    });
    expect((await sampleAutomationEvent(db, "org-1", "record.created")).ok).toBe(false);
  });

  it("pages run history and reads a run's steps", async () => {
    const run = {
      id: RUN,
      automation_id: AUTO,
      run_status: "Failed",
      depth: 0,
      attempts: 5,
      error_code: "api_unavailable",
      error_message: "The API answered 503.",
      created_at: "2026-10-21T11:00:00Z",
      started_at: "2026-10-21T11:00:01Z",
      finished_at: "2026-10-21T11:30:00Z",
      duration_ms: 1000,
      event_payload: { type: "record.created" },
      automation: { name: "Pick up tasks" },
    };
    const { db, calls } = commercialClient({
      "from:automation_runs": [
        okResponse([
          run,
          { ...run, id: "odd", run_status: "Exploded", event_payload: null, automation: null },
        ]),
        okResponse([]),
        errorResponse("42501", "no"),
      ],
      "from:automation_run_steps": [
        okResponse([
          {
            position: 1,
            action_type: "add_comment",
            operation_id: "comments.postOnSubject",
            step_status: "Failed",
            http_status: 503,
            error_code: "api_unavailable",
            error_message: "The API answered 503.",
            duration_ms: 12,
            request_body: { body: "Hi" },
            response_body: null,
          },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    expect(await listAutomationRuns(db, "org-1")).toMatchObject({
      ok: true,
      data: [
        { id: RUN, automationName: "Pick up tasks", status: "Failed", eventType: "record.created" },
      ],
    });
    await listAutomationRuns(db, "org-1", {
      automationId: AUTO,
      before: "2026-10-21T11:00:00Z",
      limit: 500,
    });
    expect(calls[1]?.steps).toContainEqual(["eq", ["automation_id", AUTO]]);
    expect(calls[1]?.steps).toContainEqual(["lt", ["created_at", "2026-10-21T11:00:00Z"]]);
    expect(calls[1]?.steps).toContainEqual(["limit", [100]]);
    expect((await listAutomationRuns(db, "org-1")).ok).toBe(false);
    expect(await listAutomationRunSteps(db, RUN)).toMatchObject({
      ok: true,
      data: [{ position: 1, status: "Failed", httpStatus: 503, request: { body: "Hi" } }],
    });
    expect((await listAutomationRunSteps(db, RUN)).ok).toBe(false);
  });

  it("reads the event catalog and the org's webhook endpoints", async () => {
    const { db } = commercialClient({
      "from:domain_event_catalog": [
        okResponse([
          { code: "record.created", subject: "records", description: "A record was created." },
          { code: null, subject: null, description: null },
        ]),
        errorResponse("42501", "no"),
      ],
      "from:webhook_endpoints": [
        okResponse([{ id: "w1", url: "https://hooks.example.test/a", description: null }]),
        errorResponse("42501", "no"),
      ],
    });
    expect(await listAutomationEventTypes(db)).toEqual({
      ok: true,
      data: [{ code: "record.created", subject: "records", description: "A record was created." }],
    });
    expect((await listAutomationEventTypes(db)).ok).toBe(false);
    expect(await listWebhookEndpointOptions(db, "org-1")).toEqual({
      ok: true,
      data: [{ id: "w1", url: "https://hooks.example.test/a", description: null }],
    });
    expect((await listWebhookEndpointOptions(db, "org-1")).ok).toBe(false);
  });
});
