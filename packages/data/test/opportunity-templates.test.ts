import { describe, expect, it } from "vitest";
import * as repo from "../src/opportunity-templates.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const TEMPLATE = {
  id: "t1",
  name: "Crew Call Basics",
  description: "Questions for every crew call.",
  questions: [
    {
      id: "q2",
      prompt: "Which shifts can you work?",
      sort_order: 2,
      is_required: false,
      deleted_at: null,
    },
    {
      id: "q3",
      prompt: "Removed question",
      sort_order: 3,
      is_required: false,
      deleted_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "q1",
      prompt: "Do you hold a current rigging certification?",
      sort_order: 1,
      is_required: true,
      deleted_at: null,
    },
  ],
};

describe("question templates", () => {
  it("lists the org's templates with their live questions in order", async () => {
    const { db, calls } = fakeClient({
      "from:application_question_templates": [okResponse([TEMPLATE])],
    });
    const result = await repo.listQuestionTemplates(db, "org1");
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "t1",
          name: "Crew Call Basics",
          description: "Questions for every crew call.",
          questions: [
            {
              id: "q1",
              prompt: "Do you hold a current rigging certification?",
              sortOrder: 1,
              required: true,
            },
            { id: "q2", prompt: "Which shifts can you work?", sortOrder: 2, required: false },
          ],
        },
      ],
    });
    expect(calls[0]?.steps.map(([s]) => s)).toEqual(["select", "eq", "is", "order"]);
  });

  it("creates a template and adds a question to it", async () => {
    const { db, calls } = fakeClient({
      "from:application_question_templates": [okResponse({ id: "t2" })],
      "from:application_template_questions": [okResponse({ id: "q9" })],
    });
    expect(
      await repo.createQuestionTemplate(db, {
        orgId: "org1",
        name: "Vendor Bids",
        description: null,
      }),
    ).toEqual({ ok: true, data: { id: "t2" } });
    expect(
      await repo.addTemplateQuestion(db, "t2", {
        prompt: "What is your lead time?",
        sortOrder: 1,
        required: true,
      }),
    ).toEqual({ ok: true, data: { id: "q9" } });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      org_id: "org1",
      name: "Vendor Bids",
      description: null,
    });
    expect(calls[1]?.steps[0]?.[1]?.[0]).toEqual({
      application_question_template_id: "t2",
      prompt: "What is your lead time?",
      sort_order: 1,
      is_required: true,
    });
  });

  it("answers a taken name as a conflict", async () => {
    const { db } = fakeClient({
      "from:application_question_templates": [errorResponse("23505", "duplicate key value")],
    });
    const result = await repo.createQuestionTemplate(db, {
      orgId: "org1",
      name: "Crew Call Basics",
      description: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("soft-deletes templates and their questions", async () => {
    const { db, calls } = fakeClient({
      "from:application_question_templates": [okResponse(null)],
      "from:application_template_questions": [okResponse(null)],
    });
    expect(await repo.deleteQuestionTemplate(db, "t1")).toEqual({ ok: true, data: null });
    expect(await repo.removeTemplateQuestion(db, "q1")).toEqual({ ok: true, data: null });
    for (const call of calls) {
      expect(call.steps[0]?.[0]).toBe("update");
      expect(call.steps[0]?.[1]?.[0]).toHaveProperty("deleted_at");
    }
  });

  it("applies a template through the RPC and passes a refusal through", async () => {
    const { db, calls } = fakeClient({
      "rpc:apply_question_template": [
        okResponse(2),
        errorResponse(
          "XR001",
          "question_template_not_draft: A question template applies to a Draft opportunity.",
          "question_template_not_draft",
        ),
      ],
    });
    expect(await repo.applyQuestionTemplate(db, "o1", "t1")).toEqual({ ok: true, data: 2 });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({ p_opportunity_id: "o1", p_template_id: "t1" });
    const refused = await repo.applyQuestionTemplate(db, "o1", "t1");
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error).toMatchObject({ kind: "refusal", rule: "question_template_not_draft" });
  });
});

describe("opportunity defaults", () => {
  it("reads no row as the built-in start", async () => {
    const { db } = fakeClient({ "from:opportunity_defaults": [okResponse(null)] });
    expect(await repo.getOpportunityDefaults(db, "org1")).toEqual({
      ok: true,
      data: repo.NO_DEFAULTS,
    });
  });

  it("reads the saved defaults, and a deleted default template as none", async () => {
    const row = {
      visibility: "Pool",
      rate_type: "Day",
      currency_code: "USD",
      application_window_days: 14,
      template: { id: "t1", deleted_at: null },
    };
    const { db } = fakeClient({
      "from:opportunity_defaults": [
        okResponse(row),
        okResponse({ ...row, template: { id: "t1", deleted_at: "2026-10-02T00:00:00Z" } }),
      ],
    });
    expect(await repo.getOpportunityDefaults(db, "org1")).toEqual({
      ok: true,
      data: {
        visibility: "Pool",
        rateType: "Day",
        currencyCode: "USD",
        applicationWindowDays: 14,
        questionTemplateId: "t1",
      },
    });
    const deleted = await repo.getOpportunityDefaults(db, "org1");
    expect(deleted.ok && deleted.data.questionTemplateId).toBeNull();
  });

  it("saves the org's one row with an upsert on the org", async () => {
    const { db, calls } = fakeClient({ "from:opportunity_defaults": [okResponse(null)] });
    await repo.saveOpportunityDefaults(db, "org1", {
      visibility: "Network",
      rateType: null,
      currencyCode: "EUR",
      applicationWindowDays: null,
      questionTemplateId: "t1",
    });
    expect(calls[0]?.steps[0]).toEqual([
      "upsert",
      [
        {
          org_id: "org1",
          visibility: "Network",
          rate_type: null,
          currency_code: "EUR",
          application_window_days: null,
          application_question_template_id: "t1",
        },
        { onConflict: "org_id" },
      ],
    ]);
  });

  it("puts the deadline the window's days after now", () => {
    const now = new Date("2026-10-28T15:30:00Z");
    expect(repo.defaultDeadline(now, 14)).toBe("2026-11-11T15:30:00.000Z");
    expect(repo.defaultDeadline(now, null)).toBeNull();
  });

  it("caps the default visibility the way publishing does", () => {
    const all = ["Invited", "Pool", "Network", "Public"] as const;
    expect(repo.defaultVisibility("Public", all)).toBe("Public");
    expect(repo.defaultVisibility("Public", ["Invited", "Pool", "Network"])).toBe("Network");
    expect(repo.defaultVisibility("Network", ["Invited", "Pool"])).toBe("Invited");
    expect(repo.defaultVisibility("Pool", ["Invited", "Pool"])).toBe("Pool");
  });
});
