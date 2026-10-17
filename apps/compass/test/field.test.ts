import { describe, expect, it } from "vitest";
import {
  buildReport,
  buildTransition,
  CRITICAL_HOLD_MS,
  dispatchQueue,
  draftProblems,
  formatNoteLength,
  isCritical,
  keepVoiceNote,
  newDraft,
  nextStep,
  withIncidentDependency,
  type IncidentRow,
  type Severity,
} from "../src/domain/incidents";
import {
  answer,
  answerProblems,
  averageSecondsPerItem,
  buildInspection,
  buildSignOff,
  canSignOff,
  criticalFailures,
  currentItem,
  goTo,
  isComplete,
  progress,
  startWalk,
  type ResultValue,
} from "../src/domain/inspections";
import {
  buildCallCue,
  formatCountdown,
  showsCountdown,
  COUNTDOWN_HORIZON_MS,
  preCueHapticDue,
  PRE_CUE_WARNING_MS,
  showState,
  type Cue,
} from "../src/domain/show";
import {
  afterPin,
  afterServer,
  backspace,
  buildKioskPunch,
  canSubmitPin,
  KIOSK_START,
  kioskPunchKind,
  pickWorker,
  pressDigit,
  refusalFromServer,
  searchRoster,
  type KioskStep,
} from "../src/domain/kiosk";

// Canon rows as read from xpms.std_enumeration.
const severities: Severity[] = [
  {
    id: "ENM-097",
    code: "SEV_L1_CRITICAL",
    label: "Level 1 - Critical",
    sortOrder: 1,
    colorCode: "#D93025",
  },
  {
    id: "ENM-098",
    code: "SEV_L2_MAJOR",
    label: "Level 2 - Major",
    sortOrder: 2,
    colorCode: "#E37400",
  },
  {
    id: "ENM-101",
    code: "SEV_L5_ADVISORY",
    label: "Level 5 - Advisory",
    sortOrder: 5,
    colorCode: "#5F6368",
  },
];
const results: ResultValue[] = [
  { id: "ENM-082", code: "INSP_PASSED", label: "Passed", sortOrder: 1 },
  { id: "ENM-083", code: "INSP_CONDITIONAL", label: "Passed with Conditions", sortOrder: 2 },
  { id: "ENM-084", code: "INSP_FAILED", label: "Failed", sortOrder: 3 },
];
const now = Date.UTC(2026, 9, 14, 19, 0, 0);
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing");
  return value;
}
let n = 0;
const ids = () => `id-${(n += 1)}`;

describe("incident quick report", () => {
  it("reads critical from canon order and holds to confirm", () => {
    expect(isCritical(must(severities[0]), severities)).toBe(true);
    expect(isCritical(must(severities[1]), severities)).toBe(false);
    expect(CRITICAL_HOLD_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("walks three steps then review", () => {
    expect(nextStep("severity")).toBe("location");
    expect(nextStep("location")).toBe("evidence");
    expect(nextStep("evidence")).toBe("review");
    expect(nextStep("review")).toBe("review");
  });

  it("validates as the person types", () => {
    const draft = newDraft("org-1", "proj-1", new Date(now).toISOString(), null, now, ids);
    expect(draftProblems(draft)).toEqual(["severity-missing", "title-missing"]);
    expect(draftProblems({ ...draft, severityId: "ENM-097", title: "x".repeat(201) })).toEqual([
      "title-too-long",
    ]);
    expect(() => buildReport(draft, now)).toThrow("not ready");
  });

  it("queues the incident with its pin, then photos and parties depending on it", () => {
    const fix = { longitude: -97.744, latitude: 30.266, accuracyM: 12, at: now };
    const draft = {
      ...newDraft("org-1", "proj-1", new Date(now).toISOString(), fix, now, () => "inc-1"),
      severityId: "ENM-098",
      title: "  Fall near Gate B  ",
      photos: [{ id: "ph-1", uri: "file:///a.jpg", capturedAt: new Date(now).toISOString() }],
      parties: [{ id: "", personId: null, description: "Guest, about 40, blue jacket" }],
    };
    const writes = buildReport(draft, now, () => "party-1");
    expect(writes.map((w) => `${w.table}:${w.rowId}`)).toEqual([
      "incidents:inc-1",
      "incident_media:ph-1",
      "incident_parties:party-1",
    ]);
    expect(writes.map((w) => w.target)).toEqual([
      "app.report_incident",
      "app.add_incident_media",
      "app.add_incident_party",
    ]);
    expect(writes[0]?.payload).toMatchObject({
      p_id: "inc-1",
      p_title: "Fall near Gate B",
      p_latitude: 30.266,
      p_longitude: -97.744,
      p_accuracy_m: 12,
      p_severity_enum_id: "ENM-098",
    });
    expect(writes[0]?.optimistic).toMatchObject({
      title: "Fall near Gate B",
      incident_state: "Reported",
    });
    expect(writes[1]?.payload).toMatchObject({
      p_id: "ph-1",
      p_incident_id: "inc-1",
      p_media_uri: "org-1/incidents/inc-1/ph-1.jpg",
      local_uri: "file:///a.jpg",
    });
    expect(writes[2]?.payload).toMatchObject({
      p_id: "party-1",
      p_description: "Guest, about 40, blue jacket",
    });
    const dependents = withIncidentDependency(writes, "mut-1");
    expect(dependents.map((d) => d.dependsOn)).toEqual([["mut-1"], ["mut-1"]]);
  });

  it("keeps a voice note longer than half a second and caps it at ten minutes", () => {
    const at = new Date(now).toISOString();
    expect(keepVoiceNote("file:///n.m4a", 12_345.6, at, () => "vn-1")).toEqual({
      id: "vn-1",
      uri: "file:///n.m4a",
      capturedAt: at,
      durationMs: 12_346,
    });
    expect(keepVoiceNote("file:///n.m4a", 300, at)).toBeNull();
    expect(keepVoiceNote(null, 5_000, at)).toBeNull();
    expect(keepVoiceNote("file:///n.m4a", Number.NaN, at)).toBeNull();
    expect(keepVoiceNote("file:///n.m4a", 700_000, at, () => "vn-2")?.durationMs).toBe(600_000);
    expect(formatNoteLength(12_345)).toBe("0:12");
    expect(formatNoteLength(75_000)).toBe("1:15");
  });

  it("queues a voice note like a photo, in the incident's folder, after the incident", () => {
    const draft = {
      ...newDraft("org-1", "proj-1", new Date(now).toISOString(), null, now, () => "inc-2"),
      severityId: "ENM-098",
      title: "Smoke at the merch tent",
      voiceNotes: [
        {
          id: "vn-1",
          uri: "file:///vn.m4a",
          capturedAt: new Date(now).toISOString(),
          durationMs: 9_000,
        },
      ],
    };
    const writes = buildReport(draft, now);
    expect(writes.map((w) => `${w.table}:${w.rowId}`)).toEqual([
      "incidents:inc-2",
      "incident_media:vn-1",
    ]);
    expect(writes[1]?.payload).toMatchObject({
      p_media_uri: "org-1/incidents/inc-2/vn-1.m4a",
      p_media_kind: "Voice Note",
      p_duration_ms: 9_000,
      local_uri: "file:///vn.m4a",
      storage_path: "org-1/incidents/inc-2/vn-1.m4a",
    });
    expect(writes[1]?.optimistic).toMatchObject({ media_kind: "Voice Note", duration_ms: 9_000 });
    expect(withIncidentDependency(writes, "mut-2").map((d) => d.dependsOn)).toEqual([["mut-2"]]);
  });

  it("orders the dispatch queue by severity then age and hides closed incidents", () => {
    const row = (
      id: string,
      sev: string,
      at: number,
      state: IncidentRow["incident_state"] = "Reported",
    ): IncidentRow => ({
      id,
      incident_number: 1,
      title: id,
      severity_enum_id: sev,
      incident_state: state,
      occurred_at: new Date(at).toISOString(),
      zone_id: null,
    });
    const queue = dispatchQueue(
      [
        row("minor-old", "ENM-101", now - 60_000),
        row("crit-new", "ENM-097", now),
        row("crit-old", "ENM-097", now - 1_000),
        row("closed", "ENM-097", now - 9_000, "Closed"),
        row("unknown", "X", now),
      ],
      severities,
    );
    expect(queue.map((i) => i.id)).toEqual(["crit-old", "crit-new", "minor-old", "unknown"]);
  });

  it("dispatches with compare-and-set on the current state", () => {
    const incident: IncidentRow = {
      id: "i1",
      incident_number: 4,
      title: "t",
      severity_enum_id: "ENM-097",
      incident_state: "Reported",
      occurred_at: "",
      zone_id: null,
    };
    const m = buildTransition(incident, "Dispatched", "Medic 2 sent");
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.transition_incident",
      policy: "cas",
      payload: { p_expected: "Reported", p_next: "Dispatched" },
    });
    expect(m.optimistic).toMatchObject({ incident_state: "Dispatched" });
  });
});

describe("inspection walk", () => {
  const items = [
    { id: "it-2", position: 2, prompt: "Fire exits clear", is_critical: true },
    { id: "it-1", position: 1, prompt: "Extinguisher tagged", is_critical: false },
  ];
  const pass = { resultId: "ENM-082", note: "", photoUri: null, answeredAt: now + 3_000 };

  it("shows one item per card in template order", () => {
    const walk = startWalk("org-1", "tpl-1", "proj-1", items, now, () => "insp-1");
    expect(currentItem(walk)?.id).toBe("it-1");
    expect(progress(walk)).toEqual({ done: 0, total: 2 });
    expect(averageSecondsPerItem(walk)).toBeNull();
    expect(currentItem(goTo(walk, 9))?.id).toBe("it-2");
    expect(currentItem(goTo(walk, -1))?.id).toBe("it-1");
  });

  it("asks a Fail for a photo and a note", () => {
    expect(
      answerProblems({ resultId: "ENM-084", note: " ", photoUri: null, answeredAt: now }, results),
    ).toEqual(["photo-required", "note-required"]);
    expect(
      answerProblems(
        { resultId: "ENM-083", note: "Tag faded", photoUri: "file:///x.jpg", answeredAt: now },
        results,
      ),
    ).toEqual([]);
    expect(
      answerProblems({ resultId: "nope", note: "", photoUri: null, answeredAt: now }, results),
    ).toEqual(["unknown-result"]);
    const walk = startWalk("org-1", "tpl-1", "proj-1", items, now);
    expect(() =>
      answer(
        walk,
        "it-1",
        { resultId: "ENM-084", note: "", photoUri: null, answeredAt: now },
        results,
      ),
    ).toThrow("photo-required");
  });

  it("advances, completes, flags critical failures and queues rows", () => {
    let walk = startWalk("org-1", "tpl-1", "proj-1", items, now, () => "insp-1");
    walk = answer(walk, "it-1", pass, results);
    expect(currentItem(walk)?.id).toBe("it-2");
    expect(isComplete(walk)).toBe(false);
    expect(() => buildInspection(walk, now)).toThrow("every item");
    walk = answer(
      walk,
      "it-2",
      {
        resultId: "ENM-084",
        note: "Exit 3 blocked by cases",
        photoUri: "file:///exit3.jpg",
        answeredAt: now + 8_000,
      },
      results,
    );
    expect(isComplete(walk)).toBe(true);
    expect(currentItem(walk)).toBeNull();
    expect(averageSecondsPerItem(walk)).toBe(4);
    expect(criticalFailures(walk, results).map((i) => i.id)).toEqual(["it-2"]);
    const writes = buildInspection(walk, now, ids);
    expect(writes[0]).toMatchObject({ table: "inspections", rowId: "insp-1" });
    // Results go through app.record_inspection_result, which opens the punch item for a Failed result
    // (journey 17; a plain insert, as before, opened none).
    expect(writes.slice(1).map((w) => [w.op, w.target])).toEqual([
      ["rpc", "app.record_inspection_result"],
      ["rpc", "app.record_inspection_result"],
    ]);
    expect(writes.slice(1).map((w) => w.payload["p_item_id"])).toEqual(["it-1", "it-2"]);
    expect(writes[2]?.payload).toMatchObject({
      p_inspection_id: "insp-1",
      p_result_enum_id: "ENM-084",
      p_note: "Exit 3 blocked by cases",
      p_photo_uri: expect.stringMatching(/^org-1\/inspections\/insp-1\/id-\d+\.jpg$/),
      local_uri: "file:///exit3.jpg",
    });
    expect(writes[2]?.payload["storage_path"]).toBe(writes[2]?.payload["p_photo_uri"]);
    expect(writes[2]?.optimistic).toMatchObject({
      project_id: "proj-1",
      inspection_item_id: "it-2",
    });
    expect(writes[1]?.payload["p_note"]).toBeNull();
    expect(writes[1]?.payload).not.toHaveProperty("local_uri");
    expect(isComplete(startWalk("org-1", "t", "p", [], now))).toBe(false);
  });

  it("never lets the inspector sign off their own inspection", () => {
    expect(canSignOff({ inspector_person_id: "p1", signed_off_at: null }, "p1", true)).toBe(
      "own-inspection",
    );
    expect(canSignOff({ inspector_person_id: "p1", signed_off_at: null }, "p2", false)).toBe(
      "capability",
    );
    expect(
      canSignOff({ inspector_person_id: "p1", signed_off_at: "2026-10-14T00:00:00Z" }, "p2", true),
    ).toBe("already-signed");
    expect(canSignOff({ inspector_person_id: "p1", signed_off_at: null }, "p2", true)).toBe(
      "allowed",
    );
    expect(buildSignOff("insp-1", now)).toMatchObject({
      op: "update",
      policy: "guarded",
      payload: { signed_off_at: new Date(now).toISOString() },
    });
  });
});

describe("live run of show", () => {
  const cue = (
    position: number,
    plannedOffsetMin: number | null,
    calledOffsetMin: number | null = null,
  ): Cue => ({
    id: `c${position}`,
    run_of_show_id: "ros-1",
    position,
    label: `Cue ${position}`,
    planned_at:
      plannedOffsetMin === null ? null : new Date(now + plannedOffsetMin * 60_000).toISOString(),
    duration: null,
    called_at:
      calledOffsetMin === null ? null : new Date(now + calledOffsetMin * 60_000).toISOString(),
  });

  it("stands by before the first cue", () => {
    const s = showState([cue(1, 5), cue(2, 10)], now);
    expect(s).toMatchObject({
      status: "standby",
      current: null,
      calledCount: 0,
      total: 2,
      msToNext: 300_000,
    });
    expect(s.next?.id).toBe("c1");
    expect(showState([], now).status).toBe("standby");
  });

  it("follows the last called cue and counts down to the next", () => {
    const s = showState(
      [cue(3, 20), cue(1, -10, -10), cue(2, 2, -1), cue(4, null), cue(5, 40)],
      now,
    );
    expect(s.current?.id).toBe("c2");
    expect(s.next?.id).toBe("c3");
    expect(s.upcoming.map((c) => c.id)).toEqual(["c4", "c5"]);
    expect(s.status).toBe("running");
    expect(s.msToNext).toBe(20 * 60_000);
  });

  it("flags a late cue and finishes after the last", () => {
    expect(showState([cue(1, -10, -10), cue(2, -1)], now).status).toBe("late");
    expect(showState([cue(1, -10, -10), cue(2, -1, 0)], now).status).toBe("complete");
    expect(showState([cue(1, -10, -10), cue(2, null)], now).msToNext).toBeNull();
  });

  it("fires the pre-cue haptic once as the countdown crosses the warning", () => {
    expect(preCueHapticDue(PRE_CUE_WARNING_MS + 500, PRE_CUE_WARNING_MS - 500)).toBe(true);
    expect(preCueHapticDue(PRE_CUE_WARNING_MS - 500, PRE_CUE_WARNING_MS - 1_500)).toBe(false);
    expect(preCueHapticDue(null, 1)).toBe(false);
  });

  it("formats countdowns readable at arm's length", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    // A cue months away names its day instead of a countdown such as "3547:45:52".
    expect(showsCountdown(COUNTDOWN_HORIZON_MS)).toBe(true);
    expect(showsCountdown(COUNTDOWN_HORIZON_MS + 1)).toBe(false);
    expect(showsCountdown(-5_000)).toBe(true);
    expect(showsCountdown(null)).toBe(false);
    expect(formatCountdown(-12_000)).toBe("+0:12");
  });

  it("calls a cue once; a second operator's call stands as applied", () => {
    const m = buildCallCue(cue(2, 2), now);
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.call_cue",
      table: "cues",
      rowId: "c2",
      policy: "append",
      payload: { p_cue_id: "c2" },
    });
    expect(m.optimistic).toMatchObject({ called_at: new Date(now).toISOString() });
  });
});

describe("kiosk", () => {
  const roster = [
    { membershipId: "m2", displayName: "Riley Stone", onShift: true },
    { membershipId: "m1", displayName: "Avery Cole", onShift: false },
    { membershipId: "m3", displayName: "Avery Brooks", onShift: false },
  ];

  it("searches the roster by name prefixes", () => {
    expect(searchRoster(roster, "").map((r) => r.membershipId)).toEqual(["m3", "m1", "m2"]);
    expect(searchRoster(roster, "av c").map((r) => r.membershipId)).toEqual(["m1"]);
    expect(searchRoster(roster, "stone").map((r) => r.membershipId)).toEqual(["m2"]);
  });

  it("collects a 4 to 8 digit PIN", () => {
    let step: KioskStep = pickWorker(must(roster[1]));
    for (const d of "12a3") step = pressDigit(step, d);
    expect(canSubmitPin(step)).toBe(false);
    step = pressDigit(step, "4");
    expect(canSubmitPin(step)).toBe(true);
    for (const d of "56789") step = pressDigit(step, d);
    expect(step.kind === "pin" && step.digits).toBe("12345678");
    step = backspace(step);
    expect(step.kind === "pin" && step.digits).toBe("1234567");
    expect(pressDigit(KIOSK_START, "1")).toBe(KIOSK_START);
    expect(backspace(KIOSK_START)).toBe(KIOSK_START);
  });

  it("asks for a photo when the org enables it", () => {
    const pin = { kind: "pin", worker: must(roster[1]), digits: "1234", attemptsLeft: 5 } as const;
    expect(afterPin(pin, true).kind).toBe("photo");
    expect(afterPin(pin, false)).toBe(pin);
    expect(afterPin({ ...pin, digits: "12" }, true).kind).toBe("pin");
  });

  it("offers clock out to someone on shift and clock in otherwise", () => {
    expect(kioskPunchKind(must(roster[0]))).toBe("Out");
    expect(kioskPunchKind(must(roster[1]))).toBe("In");
  });

  it("reports verified, queued and refused punches", () => {
    const pin: KioskStep = {
      kind: "pin",
      worker: must(roster[1]),
      digits: "1234",
      attemptsLeft: 5,
    };
    expect(afterServer(pin, { ok: true })).toEqual({
      kind: "done",
      worker: roster[1],
      punch: "In",
      verified: true,
    });
    expect(afterServer(pin, { ok: "queued" })).toMatchObject({ kind: "done", verified: false });
    expect(afterServer(pin, { ok: false, reason: "kiosk_pin_invalid" })).toMatchObject({
      kind: "pin",
      digits: "",
      attemptsLeft: 4,
    });
    expect(
      afterServer({ ...pin, attemptsLeft: 1 }, { ok: false, reason: "kiosk_pin_invalid" }),
    ).toMatchObject({ kind: "refused", reason: "pin-locked" });
    expect(afterServer(pin, { ok: false, reason: "kiosk_device_revoked" })).toMatchObject({
      kind: "refused",
      reason: "device-revoked",
    });
    expect(afterServer(KIOSK_START, { ok: true })).toBe(KIOSK_START);
    expect(refusalFromServer("kiosk_pin_locked")).toBe("pin-locked");
    expect(refusalFromServer("kiosk_device_unknown")).toBe("device-revoked");
    expect(refusalFromServer("kiosk_request_invalid")).toBe("request-invalid");
  });

  it("queues the punch with an id, device time and the optional photo", () => {
    const m = buildKioskPunch(
      {
        deviceKey: "xkio_abc",
        projectId: "proj-1",
        worker: must(roster[0]),
        pin: "1234",
        deviceAt: "2026-10-14T19:00:00Z",
        monotonicAt: 12,
        bootId: "b1",
        photoUri: null,
      },
      now,
      () => "kp-1",
    );
    expect(m).toMatchObject({ op: "rpc", target: "kiosk-punch", rowId: "kp-1", policy: "append" });
    expect(m.payload).toMatchObject({
      punchId: "kp-1",
      membershipId: "m2",
      punchKind: "Out",
      monotonic_at: 12,
      boot_id: "b1",
      projectId: "proj-1",
    });
    // The Edge Function refuses null for its optional fields and an id under any other name.
    expect(m.payload).not.toHaveProperty("photoUri");
    expect(m.payload).not.toHaveProperty("id");
    expect(Object.values(m.payload).includes(null)).toBe(false);
  });
});
