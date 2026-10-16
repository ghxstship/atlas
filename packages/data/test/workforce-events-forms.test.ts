import { describe, expect, it } from "vitest";
import {
  cancelWorkforceEvent,
  checkInOpen,
  checkInToEvent,
  createWorkforceEvent,
  eventPhase,
  listWorkforceEvents,
  myRsvp,
  rsvpCounts,
  rsvpToEvent,
  updateWorkforceEvent,
} from "../src/workforce-events.ts";
import {
  createFormTemplate,
  decideFormSubmission,
  fieldKey,
  fieldShown,
  formFieldProblems,
  formScore,
  getFormTemplate,
  listFormSubmissions,
  listFormTemplates,
  listRecordKindOptions,
  missingAnswers,
  publishFormTemplate,
  retireFormTemplate,
  submitForm,
  updateFormTemplate,
  type FormField,
} from "../src/workforce-forms.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const who = (name: string) => ({ person: { full_name: name } });

describe("events", () => {
  const row = {
    id: "e1",
    event_kind: "Crew Call",
    title: "Load-in call",
    agenda: null,
    location: "Dock 3",
    venue_id: null,
    space_id: null,
    audience_kind: "Project",
    project_id: "pr1",
    team_id: null,
    role_id: null,
    group_id: null,
    organizer_membership_id: "m1",
    starts_at: "2026-10-02T10:00:00Z",
    ends_at: "2026-10-02T11:00:00Z",
    rsvp_required: true,
    canceled_at: null,
    cancel_reason: null,
    organizer: who("Dave"),
    event_rsvps: [
      { membership_id: "m2", response: "Going", membership: who("Frank") },
      { membership_id: "m3", response: "Maybe", membership: who("Erin") },
    ],
    event_check_ins: [
      {
        membership_id: "m2",
        check_in_method: "Self",
        checked_in_at: "2026-10-02T09:30:00Z",
        membership: who("Frank"),
      },
    ],
  };

  it("lists events and derives RSVPs, check-in windows and phases", async () => {
    const { db, calls } = moduleClient({ "from:workforce_events": [okResponse([row])] });
    const events = await listWorkforceEvents(db, "o1", {
      from: "2026-10-01T00:00:00Z",
      projectId: "pr1",
    });
    expect(stepsOf(calls[0], "gte")).toEqual([["ends_at", "2026-10-01T00:00:00Z"]]);
    const e = events.ok ? events.data[0] : undefined;
    expect(e?.organizerName).toBe("Dave");
    if (!e) throw new Error("no event");
    expect(rsvpCounts(e)).toEqual({ Going: 1, Maybe: 1, Declined: 0 });
    expect(myRsvp(e, ["m3"])).toBe("Maybe");
    expect(myRsvp(e, ["m9"])).toBeNull();
    expect(checkInOpen(e, new Date("2026-10-02T09:10:00Z"))).toBe(true);
    expect(checkInOpen(e, new Date("2026-10-02T08:00:00Z"))).toBe(false);
    expect(eventPhase(e, new Date("2026-10-02T08:00:00Z"))).toBe("upcoming");
    expect(eventPhase(e, new Date("2026-10-02T10:30:00Z"))).toBe("live");
    expect(eventPhase(e, new Date("2026-10-03T00:00:00Z"))).toBe("past");
    expect(eventPhase({ ...e, canceledAt: "x" })).toBe("canceled");
    expect(checkInOpen({ ...e, canceledAt: "x" })).toBe(false);
  });

  it("schedules, edits, cancels, RSVPs and checks in", async () => {
    const { db, calls } = moduleClient({
      "from:workforce_events": [
        okResponse({ id: "e1" }),
        okResponse({ id: "e1" }),
        okResponse({ id: "e1" }),
      ],
      "rpc:rsvp_to_event": [okResponse("r1")],
      "rpc:check_in_to_event": [
        okResponse("c1"),
        errorResponse(
          "XR001",
          "workforce_event_check_in_window: closed",
          "workforce_event_check_in_window",
        ),
      ],
    });
    await createWorkforceEvent(db, "o1", "m1", {
      kind: "Briefing",
      title: "Safety brief",
      startsAt: "2026-10-02T10:00:00Z",
      endsAt: "2026-10-02T10:30:00Z",
      audience: { kind: "Team", teamId: "t1" },
    });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      audience_kind: "Team",
      team_id: "t1",
      project_id: null,
      rsvp_required: true,
    });
    await updateWorkforceEvent(db, "e1", { title: "Safety brief 2" });
    expect(stepsOf(calls[1], "update")[0]?.[0]).toEqual({ title: "Safety brief 2" });
    expect((await cancelWorkforceEvent(db, "e1", "Rain")).ok).toBe(true);
    expect((await rsvpToEvent(db, "e1", "Going")).ok).toBe(true);
    expect((await checkInToEvent(db, "e1", "m2", "Scan")).ok).toBe(true);
    expect(calls[4]?.steps[0]?.[1][0]).toEqual({
      p_event_id: "e1",
      p_membership_id: "m2",
      p_method: "Scan",
    });
    const closed = await checkInToEvent(db, "e1");
    expect(!closed.ok && closed.error.kind).toBe("refusal");
  });
});

describe("forms", () => {
  const fields: FormField[] = [
    {
      key: "hoist_ok",
      label: "Hoist inspected",
      kind: "yes_no",
      required: true,
      points: { true: 2 },
    },
    {
      key: "defect",
      label: "Defect",
      kind: "long_text",
      required: true,
      show_if: { key: "hoist_ok", equals: false },
    },
    {
      key: "load",
      label: "Load",
      kind: "choice",
      choices: ["Light", "Heavy"],
      points: { Light: 1, Heavy: 0 },
    },
    {
      key: "extras",
      label: "Extras",
      kind: "multi_choice",
      choices: ["Gloves", "Hat"],
      points: { Gloves: 1, Hat: 1 },
    },
    { key: "photos", label: "Photos", kind: "photo", required: true },
  ];

  it("checks fields, keys, conditions, scores and missing answers", () => {
    expect(formFieldProblems(fields)).toEqual([]);
    expect(formFieldProblems([])).toEqual(["fieldCount"]);
    expect(
      formFieldProblems([
        { key: "A", label: "", kind: "choice", choices: ["x"] },
        { key: "b", label: "B", kind: "text", show_if: { key: "zzz", equals: 1 } },
        { key: "b", label: "B", kind: "text" },
      ]),
    ).toEqual(["key:0", "label:0", "choices:0", "condition:1", "duplicate:2"]);
    expect(fieldKey("Hoist inspected?", [])).toBe("hoist_inspected");
    expect(fieldKey("Hoist inspected", ["hoist_inspected"])).toBe("hoist_inspected_2");
    expect(fieldKey("1st check", [])).toBe("f_1st_check");
    expect(fieldKey("!!!", [])).toBe("field");
    const answers = { hoist_ok: true, load: "Light", extras: ["Gloves"] };
    expect(fieldShown(fields[1] as FormField, answers)).toBe(false);
    expect(fieldShown(fields[1] as FormField, { hoist_ok: false })).toBe(true);
    expect(
      fieldShown(
        { key: "x", label: "X", kind: "text", show_if: { key: "extras", equals: "Hat" } },
        answers,
      ),
    ).toBe(false);
    expect(formScore(fields, answers)).toEqual({ score: 4, max: 4 });
    expect(formScore([{ key: "a", label: "A", kind: "text" }], {})).toBeNull();
    expect(missingAnswers(fields, answers)).toEqual(["photos"]);
    expect(missingAnswers(fields, { hoist_ok: false, photos: [] })).toEqual(["defect", "photos"]);
  });

  it("reads and writes templates and submissions", async () => {
    const template = {
      id: "t1",
      name: "Pre-use check",
      description: null,
      record_kind: "Inspection",
      record_subtype: "Safety",
      fields,
      requires_signature: true,
      requires_location: false,
      pass_score: 2,
      approver_role_id: "r1",
      template_state: "Published",
      current_version: 1,
      updated_at: "2026-10-01T00:00:00Z",
    };
    const { db, calls } = moduleClient({
      "from:form_templates": [
        okResponse([template]),
        okResponse(template),
        okResponse({ id: "t2" }),
        okResponse({ id: "t2" }),
      ],
      "rpc:publish_form_template": [okResponse(1)],
      "rpc:retire_form_template": [okResponse("l1")],
      "rpc:submit_form": [okResponse("s1")],
      "rpc:decide_form_submission": [okResponse("l2")],
      "from:form_submissions": [
        okResponse([
          {
            id: "s1",
            form_template_id: "t1",
            project_id: "pr1",
            record_id: "rec1",
            submitted_by_membership_id: "m2",
            answers: { hoist_ok: true },
            score: 2,
            max_score: 4,
            passed: true,
            latitude: 25.77,
            longitude: -80.19,
            signer_name: "Frank",
            signed_at: "2026-10-02T00:00:00Z",
            submission_state: "Submitted",
            decision_note: null,
            created_at: "2026-10-02T00:00:00Z",
            template: { name: "Pre-use check" },
            version: { version: 1 },
            submitter: who("Frank"),
          },
        ]),
      ],
      "xpms:from:dim_record_kind": [
        okResponse([{ record_kind: "Inspection" }, { record_kind: "Task" }]),
      ],
      "xpms:from:dim_record_subtype": [
        okResponse([{ record_kind: "Inspection", record_subtype: "Safety" }]),
      ],
    });
    const list = await listFormTemplates(db, "o1");
    expect(list.ok && list.data[0]?.fields).toHaveLength(5);
    expect((await getFormTemplate(db, "t1")).ok).toBe(true);
    const invalid = await createFormTemplate(db, "o1", {
      name: "x",
      recordKind: "Task",
      fields: [],
    });
    expect(!invalid.ok && invalid.error.kind).toBe("invalid");
    expect(
      (await updateFormTemplate(db, "t1", { name: "x", recordKind: "Task", fields: [] })).ok,
    ).toBe(false);
    expect(
      (
        await createFormTemplate(db, "o1", {
          name: "Handover",
          recordKind: "Document",
          fields: [{ key: "n", label: "Notes", kind: "text" }],
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await updateFormTemplate(db, "t2", {
          name: "Handover",
          recordKind: "Document",
          fields: [{ key: "n", label: "Notes", kind: "text" }],
        })
      ).ok,
    ).toBe(true);
    expect(await publishFormTemplate(db, "t1")).toEqual({ ok: true, data: 1 });
    expect((await retireFormTemplate(db, "t1", "Replaced")).ok).toBe(true);
    await submitForm(db, "t1", {
      answers: { hoist_ok: true },
      projectId: "pr1",
      location: { latitude: 25.77, longitude: -80.19 },
      signature: { signerName: "Frank", signaturePath: "o/sig.png" },
    });
    expect(calls.find((c) => c.target === "rpc:submit_form")?.steps[0]?.[1][0]).toEqual({
      p_template_id: "t1",
      p_answers: { hoist_ok: true },
      p_project_id: "pr1",
      p_location: { latitude: 25.77, longitude: -80.19 },
      p_signature: { signer_name: "Frank", signature_path: "o/sig.png" },
    });
    const subs = await listFormSubmissions(db, "o1", { templateId: "t1" });
    expect(subs.ok && subs.data[0]).toMatchObject({
      templateName: "Pre-use check",
      version: 1,
      passed: true,
      submittedByName: "Frank",
    });
    expect((await decideFormSubmission(db, "s1", false, "Missing photo")).ok).toBe(true);
    const kinds = await listRecordKindOptions(db);
    expect(kinds.ok && kinds.data).toEqual([
      { kind: "Inspection", subtypes: ["Safety"] },
      { kind: "Task", subtypes: [] },
    ]);
  });
});
