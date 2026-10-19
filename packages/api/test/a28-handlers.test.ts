/**
 * Contract tests for A28's Opportunities handlers (Section 18, gate 5). Requests run through `contractApp`, and every
 * response is checked against openapi/v1.json with `expectContract`. The database is a recording stand-in for
 * supabase-js: each `from(table)` or `rpc(name)` call takes the next queued response, and the recorded steps show what
 * reached the database. Refusals (422), hidden rows (404) and stale If-Match (412) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/opportunities.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

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
  const db = {
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
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const T = "2026-10-01T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };

const post = (body: unknown, key = "a28-contract-key") => ({
  method: "POST",
  headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown, ifMatch = "*") => ({
  method: "PATCH",
  headers: { "If-Match": ifMatch, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return { api: contractApp({ handlers: [handlers], db: fake.db }), calls: fake.calls };
}

const auditRow = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
});

const engagementRow = {
  ...auditRow(1),
  project_id: id(90),
  person_id: id(80),
  role_type: "Crew",
  engagement_state: "Active",
  application_id: id(70),
  worker_classification: "INDEPENDENT_CONTRACTOR",
  pay_basis: "Day Rate",
  arrangement: "Per Engagement",
  start_date: "2026-09-01",
  end_date: null,
  counterparty: { organization_id: id(60) },
  transitions: [
    { to_state: "Onboarding", created_at: "2026-09-01T00:00:00.000Z" },
    { to_state: "Active", created_at: "2026-09-10T00:00:00.000Z" },
  ],
  application: { offers: [{ id: id(50), offer_state: "Accepted", deleted_at: null }] },
};

describe("Opportunities contract: engagements", () => {
  it("lists, reads and moves engagements", async () => {
    const { api, calls } = app({
      "from:engagements": [
        ok([engagementRow, { ...engagementRow, id: id(2) }]),
        ok(engagementRow),
        ok(engagementRow),
        hidden,
      ],
      "rpc:transition_engagement": [ok(id(3)), refusal("onboarding_incomplete")],
    });
    const list = (await expectContract(
      await api.request("/engagements?limit=1&filter[engagement_state][eq]=Active"),
      "engagements.list",
    )) as {
      data: {
        offer_id: string;
        organization_id: string;
        activated_at: string;
        completed_at: string | null;
      }[];
      next_cursor: string | null;
    };
    expect(list.data[0]).toMatchObject({
      offer_id: id(50),
      organization_id: id(60),
      activated_at: "2026-09-10T00:00:00.000Z",
      completed_at: null,
    });
    expect(list.next_cursor).not.toBeNull();
    await expectContract(await api.request(`/engagements/${id(1)}`), "engagements.get");
    const moved = await api.request(
      `/engagements/${id(1)}/transitions`,
      post({ expected_state: "Active", to_state: "Closing", reason: "Show complete." }),
    );
    await expectContract(moved, "engagements.transition");
    expect(calls.find((c) => c.target === "rpc:transition_engagement")?.steps[0]?.[1]).toEqual([
      {
        p_engagement_id: id(1),
        p_expected: "Active",
        p_next: "Closing",
        p_reason: "Show complete.",
      },
    ]);
    const refused = await api.request(
      `/engagements/${id(1)}/transitions`,
      post({ expected_state: "Onboarding", to_state: "Active" }, "a28-contract-key-2"),
    );
    expect(refused.status).toBe(422);
    const missing = await api.request(`/engagements/${id(9)}`);
    expect(missing.status).toBe(404);
  });

  it("refuses an unsupported filter", async () => {
    const { api } = app({ "from:engagements": [ok([])] });
    const response = await api.request("/engagements?filter[internal_note][eq]=x");
    expect(response.status).toBe(400);
  });
});

describe("Opportunities contract: onboarding", () => {
  const itemRow = {
    ...auditRow(11),
    engagement_id: id(1),
    onboarding_requirement_id: id(12),
    document_id: null,
    submitted_at: null,
  };
  it("lists and reads onboarding items with their derived state", async () => {
    const { api } = app({
      "from:onboarding_items": [
        ok([itemRow, { ...itemRow, id: id(13) }, { ...itemRow, id: id(14) }]),
        ok(itemRow),
      ],
      "from:onboarding_item_status": [
        ok([
          {
            onboarding_item_id: id(11),
            submitted_at: T,
            latest_outcome: "Passed",
            expires_on: "2027-10-01",
            passes: true,
            carried_over: false,
          },
          {
            onboarding_item_id: id(13),
            submitted_at: null,
            latest_outcome: null,
            expires_on: null,
            passes: false,
            carried_over: true,
          },
          {
            onboarding_item_id: id(14),
            submitted_at: T,
            latest_outcome: "Failed",
            expires_on: null,
            passes: false,
            carried_over: false,
          },
        ]),
        ok([
          {
            onboarding_item_id: id(11),
            submitted_at: T,
            latest_outcome: null,
            expires_on: null,
            passes: false,
            carried_over: false,
          },
        ]),
      ],
    });
    const list = (await expectContract(
      await api.request("/onboarding-items?filter[engagement_id][eq]=" + id(1)),
      "onboardingItems.list",
    )) as {
      data: { onboarding_item_state: string; carried_over: boolean }[];
    };
    expect(list.data.map((d) => d.onboarding_item_state)).toEqual([
      "Passed",
      "Carried Over",
      "Failed",
    ]);
    const one = (await expectContract(
      await api.request(`/onboarding-items/${id(11)}`),
      "onboardingItems.get",
    )) as { onboarding_item_state: string };
    expect(one.onboarding_item_state).toBe("Submitted");
  });

  it("records a verification and passes on the separation of duties refusal", async () => {
    const { api, calls } = app({
      "from:onboarding_verifications": [
        ok({
          ...auditRow(15),
          onboarding_item_id: id(11),
          outcome: "Passed",
          verified_by: ME,
          verified_at: T,
          note: "Current COI.",
        }),
        refusal("sod_onboarding_self_verify"),
      ],
    });
    const response = await api.request(
      "/onboarding-verifications",
      post({ onboarding_item_id: id(11), passed: true, notes: "Current COI." }),
    );
    const body = (await expectContract(response, "onboardingVerifications.create")) as {
      passed: boolean;
      notes: string;
    };
    expect(body).toMatchObject({ passed: true, notes: "Current COI." });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      onboarding_item_id: id(11),
      outcome: "Passed",
      note: "Current COI.",
    });
    const refused = await api.request(
      "/onboarding-verifications",
      post({ onboarding_item_id: id(11), passed: false }, "a28-contract-key-2"),
    );
    expect(refused.status).toBe(422);
  });
});

describe("Opportunities contract: ratings", () => {
  const ratingRow = {
    ...auditRow(21),
    engagement_id: id(1),
    rater_side: "Organization",
    score: 5,
    comment: "Clean load-in.",
    submitted_at: "2026-09-20T00:00:00.000Z",
  };
  it("lists, reads and creates ratings with their release time", async () => {
    const { api } = app({
      "from:ratings": [
        ok([ratingRow]),
        ok([
          { engagement_id: id(1), submitted_at: "2026-09-20T00:00:00.000Z" },
          { engagement_id: id(1), submitted_at: "2026-09-22T00:00:00.000Z" },
        ]),
        ok(ratingRow),
        ok([{ engagement_id: id(1), submitted_at: "2026-09-20T00:00:00.000Z" }]),
        ok(ratingRow),
        ok([{ engagement_id: id(1), submitted_at: "2026-09-20T00:00:00.000Z" }]),
      ],
      "from:engagement_state_transitions": [
        ok([{ engagement_id: id(1), created_at: "2026-09-19T00:00:00.000Z" }]),
        ok([{ engagement_id: id(1), created_at: "2026-09-19T00:00:00.000Z" }]),
        ok([]),
      ],
    });
    const list = (await expectContract(await api.request("/ratings"), "ratings.list")) as {
      data: { released_at: string | null }[];
    };
    expect(list.data[0]?.released_at).toBe("2026-09-22T00:00:00.000Z");
    const one = (await expectContract(await api.request(`/ratings/${id(21)}`), "ratings.get")) as {
      released_at: string | null;
    };
    expect(one.released_at).toBe("2026-10-03T00:00:00.000Z");
    const made = await api.request(
      "/ratings",
      post({
        engagement_id: id(1),
        rater_side: "Organization",
        score: 5,
        comment: "Clean load-in.",
      }),
    );
    const body = (await expectContract(made, "ratings.create")) as { released_at: string | null };
    expect(body.released_at).toBeNull();
  });

  it("lists, reads and creates replies", async () => {
    const reply = { ...auditRow(22), rating_id: id(21), body: "Thank you." };
    const { api } = app({
      "from:rating_replies": [ok([reply]), ok(reply), ok(reply), refusal("rating_not_released")],
    });
    await expectContract(await api.request("/rating-replies"), "ratingReplies.list");
    await expectContract(await api.request(`/rating-replies/${id(22)}`), "ratingReplies.get");
    const r1 = await api.request(
      "/rating-replies",
      post({ rating_id: id(21), body: "Thank you." }),
    );
    await expectContract(r1, "ratingReplies.create");
    const refused = await api.request(
      "/rating-replies",
      post({ rating_id: id(21), body: "Early." }, "a28-contract-key-2"),
    );
    expect(refused.status).toBe(422);
  });
});

describe("Opportunities contract: selection", () => {
  const entry = { ...auditRow(31), opportunity_id: id(40), application_id: id(41), rank: 1 };
  it("manages shortlist entries", async () => {
    const { api, calls } = app({
      "from:shortlists": [
        ok([entry]),
        ok(entry),
        ok([{ rank: 2 }]),
        ok({ ...entry, rank: 3 }),
        ok({ ...entry, rank: 4 }),
        ok(entry),
        ok({ ...entry, rank: 2 }),
        ok(entry),
        ok(entry),
        ok({ id: id(31) }),
        ok(null),
      ],
    });
    await expectContract(await api.request("/shortlists"), "shortlistEntries.list");
    await expectContract(await api.request(`/shortlists/${id(31)}`), "shortlistEntries.get");
    const r2 = await api.request(
      "/shortlists",
      post({ opportunity_id: id(40), application_id: id(41) }),
    );
    const made = (await expectContract(r2, "shortlistEntries.create")) as {
      rank: number;
    };
    expect(made.rank).toBe(3);
    expect(
      calls.filter((c) => c.target === "from:shortlists")[3]?.steps[0]?.[1]?.[0],
    ).toMatchObject({ rank: 3 });
    const r3 = await api.request(
      "/shortlists",
      post({ opportunity_id: id(40), application_id: id(42), rank: 4 }, "a28-contract-key-2"),
    );
    await expectContract(r3, "shortlistEntries.create");
    const r4 = await api.request(`/shortlists/${id(31)}`, patch({ rank: 2 }));
    const updated = (await expectContract(r4, "shortlistEntries.update")) as { rank: number };
    expect(updated.rank).toBe(2);
    const cleared = await api.request(`/shortlists/${id(31)}`, patch({ rank: null }));
    expect(cleared.status).toBe(400);
    const r5 = await api.request(`/shortlists/${id(31)}`, patch({}));
    await expectContract(r5, "shortlistEntries.update");
    const r6 = await api.request(`/shortlists/${id(31)}`, { method: "DELETE" });
    await expectContract(r6, "shortlistEntries.delete");
  });

  it("refuses a stale If-Match", async () => {
    const { api } = app({ "from:shortlists": [ok(entry)] });
    const response = await api.request(`/shortlists/${id(31)}`, patch({ rank: 2 }, '"stale"'));
    expect(response.status).toBe(412);
  });

  it("reads agency slates, answers and bid lines", async () => {
    const slate = { ...auditRow(32), application_id: id(41), person_id: id(80) };
    const answer = {
      ...auditRow(33),
      application_id: id(41),
      opportunity_question_id: id(43),
      answer_text: "Two arena rigs.",
    };
    const line = {
      ...auditRow(34),
      bid_id: id(44),
      description: "Line array",
      quantity: "2",
      unit_price_minor: 250000,
      bid: { currency_code: "USD" },
    };
    const { api } = app({
      "from:agency_slates": [ok([slate]), ok(slate)],
      "from:application_answers": [ok([answer]), ok(answer)],
      "from:bid_lines": [ok([line]), ok(line), hidden],
    });
    await expectContract(await api.request("/agency-slates"), "agencySlates.list");
    await expectContract(await api.request(`/agency-slates/${id(32)}`), "agencySlates.get");
    const answers = (await expectContract(
      await api.request("/application-answers"),
      "applicationAnswers.list",
    )) as { data: { answer: string }[] };
    expect(answers.data[0]?.answer).toBe("Two arena rigs.");
    await expectContract(
      await api.request(`/application-answers/${id(33)}`),
      "applicationAnswers.get",
    );
    const lines = (await expectContract(await api.request("/bid-lines"), "bidLines.list")) as {
      data: { quantity: number; currency: string }[];
    };
    expect(lines.data[0]).toMatchObject({ quantity: 2, currency: "USD" });
    await expectContract(await api.request(`/bid-lines/${id(34)}`), "bidLines.get");
    expect((await api.request(`/bid-lines/${id(35)}`)).status).toBe(404);
  });

  it("manages opportunity questions", async () => {
    const question = {
      ...auditRow(36),
      opportunity_id: id(40),
      sort_order: 1,
      prompt: "Venues rigged?",
      is_required: true,
    };
    const { api, calls } = app({
      "from:opportunity_questions": [
        ok([question]),
        ok(question),
        ok(question),
        ok(question),
        ok({ ...question, sort_order: 2 }),
        ok(question),
        ok({ id: id(36) }),
        ok(null),
      ],
    });
    const list = (await expectContract(
      await api.request("/opportunity-questions"),
      "opportunityQuestions.list",
    )) as {
      data: { position: number; required: boolean }[];
    };
    expect(list.data[0]).toMatchObject({ position: 1, required: true });
    await expectContract(
      await api.request(`/opportunity-questions/${id(36)}`),
      "opportunityQuestions.get",
    );
    const r7 = await api.request(
      "/opportunity-questions",
      post({ opportunity_id: id(40), position: 1, prompt: "Venues rigged?", required: true }),
    );
    await expectContract(r7, "opportunityQuestions.create");
    expect(calls[2]?.steps[0]?.[1]?.[0]).toEqual({
      opportunity_id: id(40),
      sort_order: 1,
      prompt: "Venues rigged?",
      is_required: true,
    });
    const r8 = await api.request(`/opportunity-questions/${id(36)}`, patch({ position: 2 }));
    const updated = (await expectContract(r8, "opportunityQuestions.update")) as {
      position: number;
    };
    expect(updated.position).toBe(2);
    const r9 = await api.request(`/opportunity-questions/${id(36)}`, patch({}));
    await expectContract(r9, "opportunityQuestions.update");
    const r10 = await api.request(`/opportunity-questions/${id(36)}`, { method: "DELETE" });
    await expectContract(r10, "opportunityQuestions.delete");
  });
});

describe("Opportunities contract: pools and pay transparency", () => {
  const member = {
    ...auditRow(51),
    talent_pool_id: id(52),
    person_id: id(80),
    organization_id: null,
    standing: "Do Not Engage",
    reason: "No-show at load-in.",
    review_on: "2027-01-01",
  };
  it("manages pool members, keeping rehire eligibility consistent with the level", async () => {
    const { api, calls } = app({
      "from:pool_members": [
        ok([member]),
        ok(member),
        ok(member),
        ok(member),
        ok({ ...member, standing: "Approved", reason: null, review_on: null }),
        ok(member),
        ok({ id: id(51) }),
        ok(null),
      ],
    });
    const list = (await expectContract(
      await api.request("/pool-members?filter[level][eq]=Do Not Engage"),
      "poolMembers.list",
    )) as {
      data: { level: string; rehire_eligible: boolean }[];
    };
    expect(list.data[0]).toMatchObject({ level: "Do Not Engage", rehire_eligible: false });
    expect(calls[0]?.steps.some(([s, a]) => s === "eq" && a[0] === "standing")).toBe(true);
    await expectContract(await api.request(`/pool-members/${id(51)}`), "poolMembers.get");
    const inconsistent = await api.request(
      "/pool-members",
      post({
        talent_pool_id: id(52),
        person_id: id(80),
        level: "Do Not Engage",
        rehire_eligible: true,
      }),
    );
    expect(inconsistent.status).toBe(400);
    const r11 = await api.request(
      "/pool-members",
      post(
        {
          talent_pool_id: id(52),
          person_id: id(80),
          level: "Do Not Engage",
          reason: "No-show at load-in.",
          review_on: "2027-01-01",
          rehire_eligible: false,
        },
        "a28-contract-key-2",
      ),
    );
    await expectContract(r11, "poolMembers.create");
    const r12 = await api.request(
      `/pool-members/${id(51)}`,
      patch({ level: "Approved", reason: null, review_on: null }),
    );
    const updated = (await expectContract(r12, "poolMembers.update")) as {
      rehire_eligible: boolean;
    };
    expect(updated.rehire_eligible).toBe(true);
    const bad = await api.request(`/pool-members/${id(51)}`, patch({ rehire_eligible: true }));
    expect(bad.status).toBe(400);
    const r13 = await api.request(`/pool-members/${id(51)}`, { method: "DELETE" });
    await expectContract(r13, "poolMembers.delete");
  });

  it("lists pay transparency rules", async () => {
    const { api } = app({
      "from:pay_transparency_rules": [
        ok([
          { jurisdiction_id: "US-CO", requires_pay_range: true, effective_from: "2021-01-01" },
          { jurisdiction_id: "US-WA", requires_pay_range: true, effective_from: "2023-01-01" },
        ]),
        ok([]),
      ],
    });
    const page = (await expectContract(
      await api.request("/pay-transparency-rules?limit=1"),
      "payTransparencyRules.list",
    )) as {
      data: { range_required: boolean }[];
      next_cursor: string | null;
    };
    expect(page.data[0]?.range_required).toBe(true);
    const next = await api.request(`/pay-transparency-rules?cursor=${page.next_cursor}`);
    await expectContract(next, "payTransparencyRules.list");
  });
});

// A50 (gate 5, RRR-94): the Opportunities writes corrected in catalog/modules/opportunities.ts.
describe("Opportunities contract: answers, bid lines, engagements and onboarding writes (A50)", () => {
  it("records an application answer under its column name", async () => {
    const answer = {
      ...auditRow(61),
      application_id: id(41),
      opportunity_question_id: id(43),
      answer_text: "Two arena rigs.",
    };
    const { api, calls } = app({ "from:application_answers": [ok(answer)] });
    const made = await api.request(
      "/application-answers",
      post({ application_id: id(41), opportunity_question_id: id(43), answer: "Two arena rigs." }),
    );
    const body = (await expectContract(made, "applicationAnswers.create")) as { answer: string };
    expect(body.answer).toBe("Two arena rigs.");
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ application_id: id(41), opportunity_question_id: id(43), answer_text: "Two arena rigs." }],
    ]);
  });

  it("creates, updates and deletes bid lines priced in the bid's currency", async () => {
    const line = {
      ...auditRow(62),
      bid_id: id(44),
      description: "Line array",
      quantity: 2,
      unit_price_minor: null,
      bid: { currency_code: "EUR" },
    };
    const { api, calls } = app({
      "from:bid_lines": [
        ok(line),
        ok(line),
        ok({ ...line, unit_price_minor: 250000 }),
        ok({ id: id(62) }),
        ok(null),
        hidden,
      ],
    });
    const made = await api.request(
      "/bid-lines",
      post({ bid_id: id(44), description: "Line array", quantity: 2 }),
    );
    const body = (await expectContract(made, "bidLines.create")) as { currency: string };
    expect(body.currency).toBe("EUR");
    const updated = await api.request(`/bid-lines/${id(62)}`, patch({ unit_price_minor: 250000 }));
    await expectContract(updated, "bidLines.update");
    const deleted = await api.request(`/bid-lines/${id(62)}`, { method: "DELETE" });
    await expectContract(deleted, "bidLines.delete");
    expect(calls.at(-1)?.steps[0]?.[0]).toBe("update");
    expect((await api.request(`/bid-lines/${id(63)}`, { method: "DELETE" })).status).toBe(404);
  });

  it("creates an engagement from an accepted application", async () => {
    const { api, calls } = app({
      "rpc:create_engagement_from_application": [
        ok(id(1)),
        refusal("engagement_application_not_accepted"),
      ],
      "from:engagements": [ok({ ...engagementRow, engagement_state: "Onboarding" })],
    });
    const made = await api.request(
      "/engagements",
      post({
        application_id: id(70),
        worker_classification: "INDEPENDENT_CONTRACTOR",
        pay_basis: "Day Rate",
        arrangement: "Per Engagement",
      }),
    );
    const body = (await expectContract(made, "engagements.create")) as {
      engagement_state: string;
      application_id: string;
    };
    expect(body).toMatchObject({ engagement_state: "Onboarding", application_id: id(70) });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_application_id: id(70),
        p_worker_classification: "INDEPENDENT_CONTRACTOR",
        p_pay_basis: "Day Rate",
        p_arrangement: "Per Engagement",
        p_start_date: null,
        p_end_date: null,
      },
    ]);
    const refused = await api.request(
      "/engagements",
      post({ application_id: id(71), worker_classification: "EMPLOYEE" }, "a50-key-2"),
    );
    expect(refused.status).toBe(422);
  });

  it("adds an onboarding item and the engaged party submits it", async () => {
    const item = {
      ...auditRow(64),
      engagement_id: id(1),
      onboarding_requirement_id: id(12),
      document_id: null,
      submitted_at: null,
    };
    const status = (submitted: string | null) =>
      ok([
        {
          onboarding_item_id: id(64),
          submitted_at: submitted,
          latest_outcome: null,
          expires_on: null,
          passes: false,
          carried_over: false,
        },
      ]);
    const { api, calls } = app({
      "from:onboarding_items": [
        ok(item),
        ok({ id: id(64) }),
        ok({ ...item, document_id: id(65), submitted_at: T }),
      ],
      "from:onboarding_item_status": [status(null), status(T)],
      "rpc:submit_onboarding_item": [ok(null)],
    });
    const made = await api.request(
      "/onboarding-items",
      post({ engagement_id: id(1), onboarding_requirement_id: id(12) }),
    );
    const body = (await expectContract(made, "onboardingItems.create")) as {
      onboarding_item_state: string;
    };
    expect(body.onboarding_item_state).toBe("Pending");
    const submitted = await api.request(
      `/onboarding-items/${id(64)}/submit`,
      post({ document_id: id(65) }, "a50-key-3"),
    );
    const after = (await expectContract(submitted, "onboardingItems.submit")) as {
      onboarding_item_state: string;
      document_id: string;
    };
    expect(after).toMatchObject({ onboarding_item_state: "Submitted", document_id: id(65) });
    expect(calls.find((c) => c.target === "rpc:submit_onboarding_item")?.steps[0]?.[1]).toEqual([
      { p_item_id: id(64), p_document_id: id(65) },
    ]);
  });
});
