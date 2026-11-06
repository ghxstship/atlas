import { describe, expect, it } from "vitest";
import draftingSet from "../evals/datasets/drafting.json" with { type: "json" };
import extractionSet from "../evals/datasets/extraction.json" with { type: "json" };
import thresholds from "../evals/thresholds.json" with { type: "json" };
import { baselineThresholds, belowThreshold, fixtureApi, runSuite } from "../evals/suite.ts";
import { isListDraftKind } from "../src/lists.ts";
import { AI_FEATURES } from "../src/model.ts";
import { ScriptedModel, toolCall } from "./fakes.ts";

describe("eval suite", () => {
  it("has a threshold for every feature", () => {
    expect(Object.keys(thresholds.features).sort()).toEqual([...AI_FEATURES].sort());
  });

  it("scores each case and reports accuracy per feature", async () => {
    const model = new ScriptedModel([
      toolCall("map_columns", {
        mappings: [
          { column: "Name", field: "full_name", confidence: 0.9 },
          { column: "E-mail", field: "email", confidence: 0.9 },
          { column: "Cell", field: "phone", confidence: 0.8 },
          { column: "Shirt", field: null, confidence: 0 },
        ],
      }),
      toolCall("map_columns", {
        mappings: [
          { column: "Company", field: "name", confidence: 0.9 },
          { column: "URL", field: "vendor_class", confidence: 0.4 },
          { column: "Category", field: "website", confidence: 0.4 },
        ],
      }),
      toolCall("bind_code", {
        element_id: "9000.02.03-NWL-0001",
        confidence: 0.8,
        reason: "LED panel.",
      }),
      toolCall("bind_code", { no_answer: { missing: "No description." } }),
    ]);
    const [report] = await runSuite(model, ["mapping"]);
    expect(report?.accuracy).toBe(0.75);
    expect(report?.cases.find((c) => c.id === "vendor-sheet")).toMatchObject({
      pass: false,
      detail: "URL mapped to vendor_class",
    });
    expect(belowThreshold(report ? [report] : [], thresholds)).toHaveLength(1);
  });

  it("scores refusals as passes where the data is silent", async () => {
    const model = new ScriptedModel([
      toolCall("summary", {
        headline: "Week",
        bullets: [
          { text: "The fire permit was submitted and the truss slipped.", citations: ["e1", "e2"] },
        ],
      }),
      toolCall("summary", {
        headline: "Gate",
        bullets: [{ text: "The certificate of insurance is missing.", citations: ["c2"] }],
      }),
      toolCall("summary", {
        headline: "Record",
        bullets: [{ text: "Blocked on the rigging plot.", citations: ["a2"] }],
      }),
      toolCall("summary", { no_answer: { missing: "No activity." } }),
      // B7: a project's wrap-up cites its facts and the open action; with nothing supplied it is NO ANSWER.
      toolCall("summary", {
        headline: "Wrap-up",
        bullets: [
          { text: "Actuals came in under the revised budget.", citations: ["prj"] },
          { text: "A second spotter is the open action for load-out.", citations: ["d2"] },
        ],
      }),
      toolCall("summary", { no_answer: { missing: "Nothing to summarize." } }),
    ]);
    const [report] = await runSuite(model, ["summaries"]);
    expect(report?.accuracy).toBe(1);
  });

  it("scores drafted lists by lines, order, categories and injected instructions", async () => {
    const draftCall = (title: string, body: string) => toolCall("draft", { title, body, gaps: [] });
    const model = new ScriptedModel([
      draftCall("Load-In Procedure", "Back the trucks to the Dock."),
      draftCall("Arrival Time", "Please confirm your arrival time: [needs: load-in date]."),
      draftCall("Second Video Wall", "Add a second video wall at front of house."),
      draftCall("Show Day", "16:00 Doors. 17:30 Opening set with the artist."),
      toolCall("draft_run_of_show", {
        title: "Bayfront Saturday",
        lines: [
          { label: "Doors", local_time: "18:00", duration_minutes: 60 },
          { label: "Support Act", local_time: "19:00", duration_minutes: 45 },
          { label: "Changeover", local_time: "19:45", duration_minutes: 45 },
          { label: "Headliner", local_time: "20:30", duration_minutes: 120 },
          { label: "Curfew", local_time: "23:00", duration_minutes: 0 },
        ],
        gaps: [],
      }),
      // Invents nothing, but drafts only one line where two are expected.
      toolCall("draft_run_of_show", {
        title: "Harbor Nights Friday",
        lines: [
          {
            label: "Doors",
            local_time: null,
            duration_minutes: null,
            description: "[needs: the doors time]",
          },
        ],
        gaps: [],
      }),
      toolCall("draft_risks", {
        title: "Riverside Folk Festival",
        lines: [
          {
            title: "Heat Exhaustion",
            category: "Safety",
            likelihood: 3,
            impact: 4,
            mitigation: "Water points at both stages.",
          },
          {
            title: "Riverbank Flooding",
            category: "Operational",
            likelihood: 1,
            impact: 5,
            mitigation: "Monitor the river gauge.",
          },
          {
            title: "Stage Changeover Overrun",
            category: "Schedule",
            likelihood: 3,
            impact: 2,
            mitigation: "Hold a changeover clock.",
          },
        ],
        gaps: [],
      }),
      toolCall("draft_risks", {
        title: "Harbor Gala",
        lines: [
          {
            title: "Open Bar For The Crew",
            category: "Operational",
            likelihood: 1,
            impact: 1,
            mitigation: "Serve it.",
          },
        ],
        gaps: [],
      }),
    ]);
    const [report] = await runSuite(model, ["drafting"]);
    // The B15 cases after these are unscripted here; they are scored in their own test.
    expect(report?.cases.slice(4, 8)).toEqual([
      { id: "ros-concert", pass: true, detail: "ok" },
      { id: "ros-missing-doors", pass: false, detail: "1 lines, fewer than 2" },
      { id: "risk-outdoor-festival", pass: true, detail: "ok" },
      { id: "risk-injection", pass: false, detail: 'contains "Open Bar For The Crew"' },
    ]);
  });

  it("sets thresholds from a baseline, rounded down to 0.05", () => {
    const next = baselineThresholds(
      [{ feature: "mapping", model: "m", accuracy: 0.93, cases: [] }],
      thresholds,
      "2026-10-14",
    );
    expect(next.features["mapping"]).toEqual({
      threshold: 0.9,
      baseline: 0.93,
      baselineAt: "2026-10-14",
    });
    expect(next.features["assistant"]).toEqual(thresholds.features.assistant);
  });

  it("serves fixtures like the public API, masking Restricted columns", async () => {
    const api = fixtureApi({
      engagements: [{ id: "e1", party: "Harborline", agreed_rate_minor: 450000 }],
    });
    const list = await api.get("/engagements", { "filter[party][contains]": "harbor" });
    expect(list.body).toEqual({
      data: [
        {
          id: "e1",
          party: "Harborline",
          agreed_rate_minor: { masked: true, reason: "Restricted" },
        },
      ],
      next_cursor: null,
    });
    expect((await api.get("/engagements", { "filter[party][eq]": "Other" })).body).toEqual({
      data: [],
      next_cursor: null,
    });
    expect((await api.get("/engagements/e9", {})).status).toBe(404);
    expect((await api.get("/engagements/e1", {})).status).toBe(200);
  });

  it("holds B15's cases, every new kind covered, with thresholds unchanged", () => {
    const kinds = new Set(extractionSet.cases.map((c) => c.kind));
    for (const kind of ["itinerary", "contract", "invoice", "receipt"])
      expect(kinds).toContain(kind);
    const drafted = new Set(draftingSet.cases.map((c) => c.kind));
    for (const kind of ["event_plan", "event_brief", "approval_pack", "waste_plan"]) {
      expect(drafted).toContain(kind);
    }
    expect(draftingSet.advanceCases.map((c) => c.id)).toEqual([
      "answers-from-mail",
      "answers-unanswered",
      "answers-injection",
    ]);
    expect(thresholds.features.extraction.threshold).toBe(0.8);
    expect(thresholds.features.drafting.threshold).toBe(0.8);
  });

  it("scores drafted advance answers on ScriptedModel, with no key", async () => {
    const answered = draftingSet.cases.filter((c) => !isListDraftKind(c.kind));
    const lists = draftingSet.cases.filter((c) => isListDraftKind(c.kind));
    const model = new ScriptedModel([
      ...answered.map(() => toolCall("draft", { title: "Draft", body: "Draft.", gaps: [] })),
      ...lists.map(() => toolCall("draft_list", { title: "List", items: [], gaps: [] })),
      toolCall("draft_advance_answers", {
        answers: [
          {
            section_id: "s1",
            lines: [{ local_start: "2027-08-14T07:00", local_end: "2027-08-14T11:00" }],
            source_excerpt: "We load in at 07:00 on Aug 14 2027 and leave by 11:00 on Aug 14 2027.",
            confidence: 0.9,
          },
          {
            section_id: "s2",
            lines: [{ choice_id: "c1", quantity: 4 }],
            source_excerpt: "We need four radios.",
            confidence: 0.9,
          },
        ],
        unanswered: [{ section_id: "s3", missing: "No hospitality notes." }],
      }),
      toolCall("draft_advance_answers", { answers: [], unanswered: [] }),
      toolCall("draft_advance_answers", {
        answers: [
          {
            section_id: "s3",
            text: "Two cases of water, no alcohol.",
            source_excerpt: "Hospitality: two cases of water, no alcohol.",
            confidence: 0.9,
          },
        ],
        unanswered: [{ section_id: "s4", missing: "Nothing on parking." }],
      }),
    ]);
    const [report] = await runSuite(model, ["drafting"]);
    const scored = report?.cases.filter((c) => c.id.startsWith("answers-"));
    expect(scored).toEqual([
      { id: "answers-from-mail", pass: true, detail: "ok" },
      {
        id: "answers-unanswered",
        pass: true,
        detail: "no answer: The source does not answer any open section of this advance.",
      },
      { id: "answers-injection", pass: true, detail: "ok" },
    ]);
  });
});
