import { describe, expect, it } from "vitest";
import { latestReview, reviewAttachmentVersion, type VersionReview } from "../src/attachments.ts";
import {
  createProjectFromIntake,
  listEventTypes,
  resolveTemplate,
  type EventTypeTemplateRule,
} from "../src/event-types.ts";
import { slotOutsideSiteWindows } from "../src/logistics.ts";
import { parseHirePeriod } from "../src/procurement.ts";
import {
  offsetBetween,
  previewProjectCopy,
  summarizeProjectCopy,
  type ProjectCopyItem,
} from "../src/project-copy.ts";
import { getSiteWindows, summarizeSetup, unmetForGate, type SetupItem } from "../src/projects.ts";
import { parseTstzRange, rangeOrNull } from "../src/ranges.ts";
import { listSubmittalFiles } from "../src/gateway-operations.ts";
import { copyRosterFromEngagement } from "../src/roster.ts";
import { currentReview, type RecordReview } from "../src/work.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

/** B14 (RRR-238): event types, setup completeness, bump windows, copying a past project, reviews and file reviews. */

describe("ranges", () => {
  it("parses a tstzrange into ISO bounds, and the hire period reads through the same parser", () => {
    const literal = '["2027-06-12 04:00:00+00","2027-06-15 04:00:00+00")';
    expect(parseTstzRange(literal)).toEqual({
      startsAt: "2027-06-12T04:00:00.000Z",
      endsAt: "2027-06-15T04:00:00.000Z",
    });
    expect(parseHirePeriod(literal)).toEqual(parseTstzRange(literal));
  });

  it("reads an unbounded side as null and nothing as no range", () => {
    expect(parseTstzRange('["2027-06-12 04:00:00+00",)')).toEqual({
      startsAt: "2027-06-12T04:00:00.000Z",
      endsAt: null,
    });
    expect(rangeOrNull(null)).toBeNull();
    expect(rangeOrNull("empty")).toBeNull();
  });
});

describe("template resolution", () => {
  const rule = (
    scale: EventTypeTemplateRule["scale"],
    audience: EventTypeTemplateRule["audience"],
    templateId: string,
  ) => ({
    id: templateId,
    scale,
    audience,
    templateId,
    templateName: null,
  });
  const type = {
    templates: [
      rule(null, null, "default"),
      rule("Large", null, "large"),
      rule("Large", "Trade", "large-trade"),
      rule(null, "Internal", "internal"),
    ],
  };

  it("takes the most specific rule: (scale, audience), (scale, any), (any, audience), then (any, any)", () => {
    expect(resolveTemplate(type, "Large", "Trade")?.templateId).toBe("large-trade");
    expect(resolveTemplate(type, "Large", "Internal")?.templateId).toBe("large");
    expect(resolveTemplate(type, "Small", "Internal")?.templateId).toBe("internal");
    expect(resolveTemplate(type, "Small", null)?.templateId).toBe("default");
  });

  it("falls through to a less specific rule when the specific template is unpublished, and to none", () => {
    expect(resolveTemplate(type, "Large", "Trade", (id) => id !== "large-trade")?.templateId).toBe(
      "large",
    );
    expect(resolveTemplate({ templates: [] }, "Large", null)).toBeNull();
  });
});

describe("event type reads and intake", () => {
  it("drops deleted rules, fields and requirements and orders rules by band", async () => {
    const { db } = fakeClient({
      "from:event_types": [
        okResponse([
          {
            id: "t1",
            name: "Music Festival",
            description: null,
            intake_guidance: "Have the site plan ready.",
            sort_order: 1,
            retired_at: null,
            templates: [
              {
                id: "r1",
                event_scale: null,
                event_audience: null,
                template_id: "d",
                deleted_at: null,
                template: { name: "Default" },
              },
              {
                id: "r2",
                event_scale: "Large",
                event_audience: null,
                template_id: "l",
                deleted_at: null,
                template: { name: "Large" },
              },
              {
                id: "r3",
                event_scale: "Small",
                event_audience: null,
                template_id: "s",
                deleted_at: "x",
                template: null,
              },
            ],
            fields: [
              {
                id: "f1",
                custom_field_definition_id: "cfd",
                required_for_type: true,
                required_by_gate: 1,
                sort_order: 1,
                deleted_at: null,
                definition: { field_key: "capacity", label: "Capacity", deleted_at: null },
              },
              {
                id: "f2",
                custom_field_definition_id: "gone",
                required_for_type: false,
                required_by_gate: 1,
                sort_order: 2,
                deleted_at: null,
                definition: { field_key: "gone", label: "Gone", deleted_at: "x" },
              },
            ],
            requirements: [],
          },
        ]),
      ],
    });
    const listed = await listEventTypes(db, "o1");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data[0]?.templates.map((r) => r.templateId)).toEqual(["l", "d"]);
    expect(listed.data[0]?.fields.map((f) => f.fieldKey)).toEqual(["capacity"]);
    expect(listed.data[0]?.intakeGuidance).toBe("Have the site plan ready.");
  });

  it("sends every intake input by name, and a refusal comes back typed", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_project_from_intake": [
        okResponse("p1"),
        errorResponse("XR001", "copy_offset_unknown: Set the show dates.", "copy_offset_unknown"),
      ],
    });
    const made = await createProjectFromIntake(db, {
      orgId: "o1",
      key: "NWF",
      name: " Northwind Fest ",
      timeZone: "America/New_York",
      eventTypeId: "t1",
      eventScale: "Large",
      templateChoice: "type",
      loadInFrom: "2027-06-12",
      loadInTo: "2027-06-14",
      copyFromProjectId: "p0",
      copyParts: ["Hotel Blocks"],
    });
    expect(made).toEqual({ ok: true, data: { id: "p1" } });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({
      p_name: "Northwind Fest",
      p_event_scale: "Large",
      p_event_audience: null,
      p_template_choice: "type",
      p_load_in_from: "2027-06-12",
      p_copy_parts: ["Hotel Blocks"],
    });
    const refused = await createProjectFromIntake(db, {
      orgId: "o1",
      key: "NWD",
      name: "x",
      timeZone: "UTC",
      templateChoice: "none",
    });
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "copy_offset_unknown",
    });
  });
});

describe("setup completeness", () => {
  const item = (
    kind: SetupItem["kind"],
    requirement: SetupItem["requirement"],
    gate: number,
    satisfied: boolean,
  ): SetupItem => ({
    kind,
    requirementId: `${kind}${gate}${requirement}`,
    documentTypeId: null,
    customFieldDefinitionId: null,
    label: `${kind} ${gate}`,
    requirement,
    requiredByGate: gate,
    documentsCount: kind === "Document" ? Number(satisfied) : null,
    satisfied,
  });
  const items = [
    item("Document", "Required", 3, false),
    item("Document", "Recommended", 1, false),
    item("Document", "Required", 1, true),
    item("Field", "Required", 1, false),
  ];

  it("counts Required and Recommended met per kind", () => {
    expect(summarizeSetup(items, "Document")).toEqual({
      required: { met: 1, total: 2 },
      recommended: { met: 0, total: 1 },
    });
    expect(summarizeSetup(items).required).toEqual({ met: 1, total: 3 });
  });

  it("lists what a gate still needs: Required, due by the gate, not met; Recommended never", () => {
    expect(unmetForGate(items, 1).map((i) => i.label)).toEqual(["Field 1"]);
    expect(unmetForGate(items, 3).map((i) => i.label)).toEqual(["Document 3", "Field 1"]);
  });
});

describe("bump windows", () => {
  const windows = {
    bumpIn: { startsAt: "2027-06-12T04:00:00.000Z", endsAt: "2027-06-15T04:00:00.000Z" },
    bumpOut: { startsAt: "2027-06-17T04:00:00.000Z", endsAt: "2027-06-19T04:00:00.000Z" },
  };

  it("flags a slot outside both windows and nothing that meets one", () => {
    expect(
      slotOutsideSiteWindows(
        { startsAt: "2027-06-13T12:00:00Z", endsAt: "2027-06-13T14:00:00Z" },
        windows,
      ),
    ).toBe(false);
    expect(
      slotOutsideSiteWindows(
        { startsAt: "2027-06-16T12:00:00Z", endsAt: "2027-06-16T14:00:00Z" },
        windows,
      ),
    ).toBe(true);
    expect(
      slotOutsideSiteWindows(
        { startsAt: "2027-06-15T03:00:00Z", endsAt: "2027-06-15T05:00:00Z" },
        windows,
      ),
    ).toBe(false);
  });

  it("treats the window end as open, and raises nothing without windows", () => {
    expect(
      slotOutsideSiteWindows(
        { startsAt: "2027-06-15T04:00:00Z", endsAt: "2027-06-15T06:00:00Z" },
        windows,
      ),
    ).toBe(true);
    expect(
      slotOutsideSiteWindows(
        { startsAt: "2027-06-16T12:00:00Z", endsAt: "2027-06-16T14:00:00Z" },
        { bumpIn: null, bumpOut: null },
      ),
    ).toBe(false);
  });

  it("reads the windows of a project from app.project_site_windows", async () => {
    const { db } = fakeClient({
      "from:project_site_windows": [
        okResponse({
          bump_in: '["2027-06-12 04:00:00+00","2027-06-15 04:00:00+00")',
          bump_out: null,
          site_window: null,
        }),
      ],
    });
    const read = await getSiteWindows(db, "p1");
    expect(read.ok && read.data).toEqual({
      bumpIn: { startsAt: "2027-06-12T04:00:00.000Z", endsAt: "2027-06-15T04:00:00.000Z" },
      bumpOut: null,
      siteWindow: null,
    });
  });
});

describe("copying a past project", () => {
  it("prefills the offset from the first show days", () => {
    expect(offsetBetween("2026-06-01", "2027-05-31")).toBe(364);
    expect(offsetBetween("2027-03-01", "2027-03-29")).toBe(28);
    expect(offsetBetween(null, "2027-03-29")).toBeNull();
  });

  it("maps the preview rows and counts each part", async () => {
    const { db, calls } = fakeClient({
      "rpc:copy_project_setup": [
        okResponse([
          {
            part: "Budgets",
            item_kind: "Budget",
            source_id: "b",
            label: "Show budget",
            outcome: "copy",
            skip_reason: null,
            new_on: null,
            new_at: null,
          },
          {
            part: "Budgets",
            item_kind: "Budget Line",
            source_id: "l",
            label: "Truss",
            outcome: "copy",
            skip_reason: "event_cost_center_cleared",
            new_on: null,
            new_at: null,
          },
          {
            part: "Pass Categories",
            item_kind: "Access Grid",
            source_id: "g",
            label: "PRK Gate",
            outcome: "skip",
            skip_reason: "zone_other_venue",
            new_on: null,
            new_at: null,
          },
        ]),
      ],
    });
    const preview = await previewProjectCopy(db, {
      sourceProjectId: "s",
      targetProjectId: null,
      parts: ["Budgets", "Pass Categories"],
      offsetDays: 28,
    });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({
      p_target_project_id: null,
      p_commit: false,
      p_offset_days: 28,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(summarizeProjectCopy(preview.data as ProjectCopyItem[])).toEqual([
      { part: "Pass Categories", copied: 0, skipped: 1 },
      { part: "Budgets", copied: 2, skipped: 0 },
    ]);
  });
});

describe("roster reuse", () => {
  it("reads the outcome and the moved arrival of each entry", async () => {
    const { db } = fakeClient({
      "rpc:copy_roster_from_engagement": [
        okResponse([
          {
            source_entry_id: "e1",
            label: "Pia Larsen",
            outcome: "copy",
            skip_reason: null,
            arrival_window: '["2027-06-29 13:00:00+00","2027-06-29 15:00:00+00")',
          },
          {
            source_entry_id: "e2",
            label: "nell@touring.test",
            outcome: "invite",
            skip_reason: null,
            arrival_window: null,
          },
        ]),
      ],
    });
    const preview = await copyRosterFromEngagement(db, {
      engagementId: "a",
      sourceEngagementId: "b",
      commit: false,
    });
    expect(preview.ok && preview.data).toEqual([
      {
        sourceEntryId: "e1",
        label: "Pia Larsen",
        outcome: "copy",
        skipReason: null,
        arrivalStartsAt: "2027-06-29T13:00:00.000Z",
        arrivalEndsAt: "2027-06-29T15:00:00.000Z",
      },
      {
        sourceEntryId: "e2",
        label: "nell@touring.test",
        outcome: "invite",
        skipReason: null,
        arrivalStartsAt: null,
        arrivalEndsAt: null,
      },
    ]);
  });
});

describe("reviews", () => {
  const review = (id: string, state: string, at: string): RecordReview => ({
    approvalRecordId: id,
    approvalKey: `NWL-${id}`,
    approvalState: state,
    reviewerId: null,
    reviewerName: null,
    requesterId: "carol",
    requesterName: null,
    decision: null,
    approverName: null,
    decidedAt: null,
    requestedAt: at,
  });

  it("decides by the latest review that is not Canceled", () => {
    expect(
      currentReview([review("2", "Canceled", "b"), review("1", "Complete", "a")])?.approvalRecordId,
    ).toBe("1");
    expect(currentReview([])).toBeNull();
  });

  it("takes a version's latest review as its decision, and none for a new version", () => {
    const reviews: VersionReview[] = [
      {
        id: "r2",
        attachmentVersionId: "v1",
        decision: "Approved",
        note: null,
        reviewerId: null,
        reviewerName: null,
        reviewedAt: "b",
      },
      {
        id: "r1",
        attachmentVersionId: "v1",
        decision: "Changes Requested",
        note: "Add the points.",
        reviewerId: null,
        reviewerName: null,
        reviewedAt: "a",
      },
    ];
    expect(latestReview(reviews, "v1")?.decision).toBe("Approved");
    expect(latestReview(reviews, "v2")).toBeNull();
  });

  it("sends a blank note as none and returns the uploader refusal typed", async () => {
    const { db, calls } = fakeClient({
      "rpc:review_attachment_version": [
        errorResponse(
          "XR001",
          "sod_file_review_uploader: The person who uploaded a file version cannot review it.",
          "sod_file_review_uploader",
        ),
      ],
    });
    const refused = await reviewAttachmentVersion(db, {
      versionId: "v1",
      decision: "Approved",
      note: "  ",
    });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({ p_note: null });
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "sod_file_review_uploader",
    });
  });
});

describe("the vendor's submittal files", () => {
  it("reads api_external.submittal_files newest version first and keeps only known decisions", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:submittal_files": [
        {
          data: [
            {
              submittal_id: "s1",
              attachment_id: "a1",
              title: "cut-sheets.pdf",
              version_id: "v2",
              version_number: 2,
              filename: "cut-sheets-v2.pdf",
              content_type: "application/pdf",
              size_bytes: 2048,
              uploaded_at: "2027-05-02T10:00:00Z",
              is_current: true,
              review_decision: "Changes Requested",
              review_comment: "Add the rigging points.",
              reviewed_at: "2027-05-03T09:00:00Z",
            },
            {
              submittal_id: "s1",
              attachment_id: "a1",
              version_id: "v1",
              version_number: 1,
              review_decision: "Maybe",
            },
          ],
          error: null,
        },
      ],
    });
    const files = await listSubmittalFiles(db, ["s1"]);
    expect(stepsOf(calls[0], "in")).toEqual([["submittal_id", ["s1"]]]);
    expect(stepsOf(calls[0], "order")).toEqual([["version_number", { ascending: false }]]);
    expect(files.ok && files.data[0]).toMatchObject({
      versionId: "v2",
      isCurrent: true,
      reviewDecision: "Changes Requested",
      reviewComment: "Add the rigging points.",
      reviewedAt: "2027-05-03T09:00:00Z",
    });
    expect(files.ok && files.data[1]).toMatchObject({ isCurrent: false, reviewDecision: null });
    expect(await listSubmittalFiles(db, [])).toEqual({ ok: true, data: [] });
  });
});

describe("band literals", () => {
  it("match the generated enums", async () => {
    const { Constants } = await import("../src/database.types.ts");
    const { EVENT_AUDIENCES, EVENT_SCALES } = await import("../src/setup.ts");
    expect([...EVENT_SCALES]).toEqual([...Constants.app.Enums.event_scale]);
    expect([...EVENT_AUDIENCES]).toEqual([...Constants.app.Enums.event_audience]);
    expect(["Required", "Recommended"]).toEqual([...Constants.app.Enums.document_requirement]);
  });
});
