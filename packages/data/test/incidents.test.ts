import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  addIncidentMedia,
  addIncidentParty,
  addMedicalEncounter,
  archiveRadioChannel,
  closeIncident,
  createRadioChannel,
  dispatchResponder,
  endCrisisAlert,
  getIncident,
  importStandardRadioPlan,
  INCIDENT_MOVES,
  issueCrisisAlert,
  listCrisisAlerts,
  listDispatchAssignments,
  listEmergencyCodes,
  listEmergencyProtocols,
  listIncidentHistory,
  listIncidentMedia,
  listIncidentParties,
  listIncidents,
  listIncidentSeverities,
  listIncidentsForDispatch,
  listMedicalEncounters,
  listMyDispatches,
  listRadioChannels,
  listStandardRadioChannels,
  markArrived,
  removeIncidentMedia,
  removeIncidentParty,
  reportIncident,
  transitionIncident,
  updateIncident,
  updateMedicalEncounter,
  updateRadioChannel,
  withdrawResponder,
} from "../src/incidents.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const db = Object.assign(fake.db, { schema: () => fake.db }) as XosClient;
  return { db, calls: fake.calls };
}

const down = errorResponse("08006", "down");
const ID = "01920000-0000-7000-8000-00000000b001";

const incidentRow = {
  id: "i1",
  project_id: "j1",
  incident_number: 142,
  title: "Guest Fall Near Gate 2",
  severity_enum_id: "ENM-099",
  zone_id: "z1",
  occurred_at: "2026-10-14T11:50:00Z",
  reported_by: "p4",
  incident_state: "Reported",
  latitude: "25.800100",
  longitude: "-80.199900",
  created_at: "2026-10-14T11:51:00Z",
  updated_at: "2026-10-14T11:51:00Z",
  project: { project_key: "NWL" },
  zone: { code: "FOH", name: "Front of House" },
  reporter: { full_name: "Frank Adeyemi" },
  signer: null,
  dispatch_assignments: [{ deleted_at: null }, { deleted_at: "2026-10-14T12:00:00Z" }],
};

describe("severities", () => {
  it("marks the first canon severity critical", async () => {
    const { db } = client({
      "from:std_enumeration": [
        okResponse([
          {
            record_id: "ENM-097",
            enum_code: "SEV_L1_CRITICAL",
            enum_label: "Level 1 - Critical",
            sort_order: 1,
          },
          { record_id: "ENM-098", enum_code: null, enum_label: null, sort_order: 2 },
        ]),
        okResponse([]),
        down,
      ],
    });
    const result = await listIncidentSeverities(db);
    expect(result.ok && result.data.map((s) => [s.id, s.isCritical])).toEqual([
      ["ENM-097", true],
      ["ENM-098", false],
    ]);
    expect(result.ok && result.data[1]?.label).toBe("ENM-098");
    expect(await listIncidentSeverities(db)).toEqual({ ok: true, data: [] });
    expect((await listIncidentSeverities(db)).ok).toBe(false);
  });
});

describe("incidents", () => {
  it("lists with the display key, location and live responders", async () => {
    const { db, calls } = client({ "from:incidents": [okResponse([incidentRow])] });
    const result = await listIncidents(db, { orgId: "o1", projectId: "j1", states: ["Reported"] });
    expect(result.ok && result.data[0]).toMatchObject({
      key: "NWL-142",
      zoneCode: "FOH",
      reportedByName: "Frank Adeyemi",
      latitude: 25.8001,
      responderCount: 1,
    });
    expect(calls[0]?.steps).toContainEqual(["in", ["incident_state", ["Reported"]]]);
  });

  it("lists open incidents for dispatch", async () => {
    const bare = {
      ...incidentRow,
      project: null,
      zone: null,
      reporter: null,
      latitude: null,
      longitude: undefined,
      dispatch_assignments: null,
    };
    const { db, calls } = client({ "from:incidents": [okResponse([bare]), okResponse([]), down] });
    const result = await listIncidentsForDispatch(db, "o1", "j1");
    expect(result.ok && result.data[0]).toMatchObject({
      key: "-142",
      latitude: null,
      responderCount: 0,
    });
    expect(calls[0]?.steps).toContainEqual([
      "in",
      ["incident_state", ["Reported", "Dispatched", "Contained"]],
    ]);
    expect((await listIncidentsForDispatch(db, "o1")).ok).toBe(true);
    expect((await listIncidents(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reads one incident", async () => {
    const { db } = client({ "from:incidents": [okResponse(incidentRow), okResponse(null), down] });
    expect((await getIncident(db, "i1")).ok).toBe(true);
    expect(await getIncident(db, "ix")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getIncident(db, "i1")).ok).toBe(false);
  });

  it("reports through app.report_incident with the offline contract", async () => {
    const { db, calls } = client({
      "rpc:report_incident": [
        okResponse([{ id: ID, incident_number: 7, incident_state: "Reported", replayed: true }]),
        okResponse([]),
        down,
      ],
    });
    const input = {
      orgId: "o1",
      projectId: "j1",
      title: " Guest Fall ",
      severityId: "ENM-099",
      occurredAt: "2026-10-14T11:50:00Z",
      zoneId: "z1",
      id: ID,
      latitude: 25.8,
      longitude: -80.2,
      accuracyM: 12,
      deviceAt: "2026-10-14T11:51:00Z",
    };
    expect(await reportIncident(db, input)).toEqual({
      ok: true,
      data: { id: ID, incidentNumber: 7, incidentState: "Reported", replayed: true },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_project_id: "j1",
          p_title: "Guest Fall",
          p_severity_enum_id: "ENM-099",
          p_occurred_at: "2026-10-14T11:50:00Z",
          p_zone_id: "z1",
          p_latitude: 25.8,
          p_longitude: -80.2,
          p_accuracy_m: 12,
          p_device_reported_at: "2026-10-14T11:51:00Z",
          p_id: ID,
        },
      ],
    ]);
    const plain = { orgId: "o1", projectId: "j1", title: "T", severityId: "E", occurredAt: "x" };
    expect(await reportIncident(db, plain)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_project_id: "j1", p_title: "T", p_severity_enum_id: "E", p_occurred_at: "x" }],
    ]);
    expect((await reportIncident(db, plain)).ok).toBe(false);
  });

  it("edits, transitions and closes", async () => {
    const { db, calls } = client({
      "from:incidents": [okResponse([{ id: "i1" }]), okResponse([]), down],
      "rpc:transition_incident": [
        okResponse("t1"),
        errorResponse("XR001", "stale: moved", "stale"),
      ],
      "rpc:close_incident": [
        okResponse("t2"),
        errorResponse(
          "XR001",
          "sod_approval_requester: An approval is decided by an eligible approver, never the requester.",
          "sod_approval_requester",
        ),
      ],
    });
    const edit = {
      title: "T",
      severityId: "ENM-099",
      zoneId: null,
      occurredAt: "2026-10-14T11:50:00Z",
    };
    expect((await updateIncident(db, "i1", edit)).ok).toBe(true);
    expect((await updateIncident(db, "i1", edit)).ok).toBe(false);
    expect((await updateIncident(db, "i1", edit)).ok).toBe(false);
    const move = { id: "i1", expected: "Reported", next: "Dispatched", reason: " Sent. " } as const;
    expect((await transitionIncident(db, move)).ok).toBe(true);
    expect(calls.find((c) => c.target === "rpc:transition_incident")?.steps[0]).toEqual([
      "args",
      [{ p_incident_id: "i1", p_expected: "Reported", p_next: "Dispatched", p_reason: "Sent." }],
    ]);
    expect((await transitionIncident(db, move)).ok).toBe(false);
    expect((await closeIncident(db, "i1", "Signed off.")).ok).toBe(true);
    const refused = await closeIncident(db, "i1", "Signed off.");
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sod_approval_requester",
    );
  });

  it("allows only the database's moves", () => {
    expect(INCIDENT_MOVES.Contained).toContain("Closed");
    expect(INCIDENT_MOVES.Reported).not.toContain("Closed");
    expect(INCIDENT_MOVES.Closed).toEqual([]);
  });

  it("reads the state ledger", async () => {
    const { db } = client({
      "from:incident_state_transitions": [
        okResponse([
          {
            id: "t1",
            from_state: null,
            to_state: "Reported",
            reason: "Reported.",
            created_at: "x",
            by: null,
          },
          {
            id: "t2",
            from_state: "Reported",
            to_state: "Dispatched",
            reason: "Sent.",
            created_at: "y",
            by: { full_name: "Carol" },
          },
        ]),
        down,
      ],
    });
    const result = await listIncidentHistory(db, "i1");
    expect(result.ok && result.data.map((t) => t.byName)).toEqual([null, "Carol"]);
    expect((await listIncidentHistory(db, "i1")).ok).toBe(false);
  });
});

describe("parties and media", () => {
  it("lists, adds and removes parties", async () => {
    const { db, calls } = client({
      "from:incident_parties": [
        okResponse([{ id: "pa", person_id: null, description: "Witness", person: null }]),
        okResponse([{ id: "pa" }]),
        okResponse([]),
        down,
        down,
      ],
      "rpc:add_incident_party": [okResponse("pb"), okResponse(ID), down],
    });
    const listed = await listIncidentParties(db, "i1");
    expect(listed.ok && listed.data[0]?.personName).toBeNull();
    expect(
      await addIncidentParty(db, { orgId: "o1", incidentId: "i1", description: " Witness " }),
    ).toEqual({ ok: true, data: { id: "pb", replayed: false } });
    expect(
      await addIncidentParty(db, {
        orgId: "o1",
        incidentId: "i1",
        description: "W",
        id: ID,
        personId: "p2",
      }),
    ).toEqual({ ok: true, data: { id: ID, replayed: false } });
    expect(calls.filter((c) => c.target === "rpc:add_incident_party")[1]?.steps[0]).toEqual([
      "args",
      [{ p_incident_id: "i1", p_description: "W", p_person_id: "p2", p_id: ID }],
    ]);
    expect(
      (await addIncidentParty(db, { orgId: "o1", incidentId: "i1", description: "W" })).ok,
    ).toBe(false);
    expect((await removeIncidentParty(db, "pa")).ok).toBe(true);
    expect((await removeIncidentParty(db, "pa")).ok).toBe(false);
    expect((await removeIncidentParty(db, "pa")).ok).toBe(false);
    expect((await listIncidentParties(db, "i1")).ok).toBe(false);
  });

  it("lists, adds and removes media", async () => {
    const { db, calls } = client({
      "from:incident_media": [
        okResponse([
          { id: "m1", media_uri: "incidents/a.jpg", captured_at: null, created_at: "x" },
        ]),
        okResponse([{ id: "m1" }]),
        down,
      ],
      "rpc:add_incident_media": [okResponse("m2"), okResponse(ID), down],
    });
    expect((await listIncidentMedia(db, "i1")).ok).toBe(true);
    const media = { orgId: "o1", incidentId: "i1", mediaUri: "incidents/b.jpg" };
    expect(await addIncidentMedia(db, media)).toEqual({
      ok: true,
      data: { id: "m2", replayed: false },
    });
    expect((await addIncidentMedia(db, { ...media, id: ID, capturedAt: "y" })).ok).toBe(true);
    expect(calls.filter((c) => c.target === "rpc:add_incident_media")[1]?.steps[0]).toEqual([
      "args",
      [{ p_incident_id: "i1", p_media_uri: "incidents/b.jpg", p_captured_at: "y", p_id: ID }],
    ]);
    expect((await addIncidentMedia(db, media)).ok).toBe(false);
    expect((await removeIncidentMedia(db, "m1")).ok).toBe(true);
    expect((await listIncidentMedia(db, "i1")).ok).toBe(false);
  });
});

describe("dispatch", () => {
  const row = {
    id: "d1",
    incident_id: "i1",
    membership_id: "m4",
    dispatched_at: "x",
    arrived_at: null,
    membership: { person: { full_name: "Frank Adeyemi" } },
  };

  it("lists responders for incidents and for me", async () => {
    const { db } = client({
      "from:dispatch_assignments": [
        okResponse([row, { ...row, id: "d2", membership: null }]),
        okResponse([row]),
        down,
        down,
      ],
    });
    expect(await listDispatchAssignments(db, [])).toEqual({ ok: true, data: [] });
    expect(await listMyDispatches(db, [])).toEqual({ ok: true, data: [] });
    const listed = await listDispatchAssignments(db, ["i1"]);
    expect(listed.ok && listed.data.map((d) => d.responderName)).toEqual(["Frank Adeyemi", null]);
    expect((await listMyDispatches(db, ["m4"])).ok).toBe(true);
    expect((await listDispatchAssignments(db, ["i1"])).ok).toBe(false);
    expect((await listMyDispatches(db, ["m4"])).ok).toBe(false);
  });

  it("dispatches, records arrival and withdraws", async () => {
    const { db, calls } = client({
      "rpc:dispatch_responder": [okResponse("d3"), okResponse(ID), down],
      "rpc:mark_dispatch_arrived": [okResponse("2026-10-14T12:05:00Z"), down],
      "from:dispatch_assignments": [okResponse([{ id: "d3" }])],
    });
    const input = { orgId: "o1", incidentId: "i1", membershipId: "m4" };
    expect(await dispatchResponder(db, input)).toEqual({
      ok: true,
      data: { id: "d3", replayed: false },
    });
    expect((await dispatchResponder(db, { ...input, id: ID })).ok).toBe(true);
    expect(calls.filter((c) => c.target === "rpc:dispatch_responder")[1]?.steps[0]).toEqual([
      "args",
      [{ p_incident_id: "i1", p_membership_id: "m4", p_id: ID }],
    ]);
    expect((await dispatchResponder(db, input)).ok).toBe(false);
    expect(await markArrived(db, "d3")).toEqual({
      ok: true,
      data: { arrivedAt: "2026-10-14T12:05:00Z" },
    });
    expect((await markArrived(db, "d3")).ok).toBe(false);
    expect((await withdrawResponder(db, "d3")).ok).toBe(true);
  });
});

describe("medical encounters", () => {
  it("reads only the masked view", async () => {
    const { db, calls } = client({
      "from:medical_encounters_masked": [
        okResponse([
          {
            id: "e1",
            incident_id: "i1",
            patient_description: "Guest, adult.",
            disposition: "Released",
            treatment_notes: null,
            is_masked: true,
          },
          {
            id: null,
            incident_id: null,
            patient_description: null,
            disposition: null,
            treatment_notes: "Dressed.",
            is_masked: null,
          },
        ]),
        down,
      ],
    });
    const result = await listMedicalEncounters(db, "i1");
    expect(result.ok && result.data[0]).toMatchObject({ treatmentNotes: null, isMasked: true });
    expect(result.ok && result.data[1]).toMatchObject({ id: "", incidentId: "i1", isMasked: true });
    expect(calls[0]?.target).toBe("from:medical_encounters_masked");
    expect((await listMedicalEncounters(db, "i1")).ok).toBe(false);
  });

  it("records and updates encounters through the encrypting RPCs", async () => {
    const { db, calls } = client({
      "rpc:record_medical_encounter": [okResponse("e2"), down],
      "rpc:update_medical_encounter": [okResponse(null), down],
    });
    const input = {
      orgId: "o1",
      incidentId: "i1",
      patientDescription: " Guest ",
      treatmentNotes: "  ",
      disposition: null,
    };
    expect(await addMedicalEncounter(db, input)).toEqual({ ok: true, data: { id: "e2" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_incident_id: "i1", p_patient_description: "Guest" }],
    ]);
    expect(
      (await addMedicalEncounter(db, { ...input, treatmentNotes: "x", disposition: "y" })).ok,
    ).toBe(false);
    expect(
      await updateMedicalEncounter(db, "e2", { treatmentNotes: " Dressed. ", disposition: "" }),
    ).toEqual({ ok: true, data: null });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_medical_encounter_id: "e2", p_treatment_notes: "Dressed." }],
    ]);
    expect((await updateMedicalEncounter(db, "e2", { patientDescription: "Guest" })).ok).toBe(
      false,
    );
  });
});

describe("emergency codes and crisis alerts", () => {
  it("reads the global codes and protocols with ordered steps", async () => {
    const { db, calls } = client({
      "from:emergency_code": [
        okResponse([
          {
            code: "CODE_RED",
            label: "Code Red",
            emergency: "Fire",
            swatch: "ecode-red",
            sort_order: 1,
          },
        ]),
        down,
      ],
      "from:emergency_protocol": [
        okResponse([
          {
            record_key: "EMG-001",
            code: "CODE_RED",
            domain: "Site Operations",
            notes: null,
            steps: [
              { step_no: 2, body: "Contact {fire}." },
              { step_no: 1, body: "Identify the fire source." },
            ],
          },
          {
            record_key: "EMG-002",
            code: "CODE_RED",
            domain: "Stage Operations",
            notes: null,
            steps: null,
          },
        ]),
        down,
      ],
    });
    expect((await listEmergencyCodes(db)).ok).toBe(true);
    const protocols = await listEmergencyProtocols(db, "CODE_RED");
    expect(protocols.ok && protocols.data[0]?.steps).toEqual([
      "Identify the fire source.",
      "Contact {fire}.",
    ]);
    expect(protocols.ok && protocols.data[1]?.steps).toEqual([]);
    expect(calls[1]?.steps).toContainEqual(["eq", ["code", "CODE_RED"]]);
    expect((await listEmergencyCodes(db)).ok).toBe(false);
    expect((await listEmergencyProtocols(db)).ok).toBe(false);
  });

  it("lists, issues and ends crisis alerts", async () => {
    const alert = {
      id: "a1",
      project_id: "j1",
      emergency_code: "CODE_RED",
      message: "Evacuate the north lawn.",
      issued_at: "x",
      ended_at: null,
      project: { project_key: "NWL" },
    };
    const { db, calls } = client({
      "from:crisis_alerts": [
        okResponse([alert, { ...alert, id: "a2", project: null }]),
        okResponse({ id: "a3" }),
        okResponse([{ id: "a3" }]),
        okResponse([]),
        down,
        down,
        down,
      ],
    });
    const listed = await listCrisisAlerts(db, { orgId: "o1", projectId: "j1", activeOnly: true });
    expect(listed.ok && listed.data.map((a) => a.projectKey)).toEqual(["NWL", ""]);
    expect(calls[0]?.steps).toContainEqual(["is", ["ended_at", null]]);
    const input = { orgId: "o1", projectId: "j1", emergencyCode: "CODE_RED", message: " Go. " };
    expect(await issueCrisisAlert(db, input)).toEqual({ ok: true, data: { id: "a3" } });
    expect((await endCrisisAlert(db, "a3")).ok).toBe(true);
    expect((await endCrisisAlert(db, "a3")).ok).toBe(false);
    expect((await listCrisisAlerts(db, { orgId: "o1" })).ok).toBe(false);
    expect((await issueCrisisAlert(db, input)).ok).toBe(false);
    expect((await endCrisisAlert(db, "a3")).ok).toBe(false);
  });
});

describe("radio plan", () => {
  const channel = (n: number, key = "NWL") => ({
    id: `r${n}`,
    project_id: "j1",
    channel_number: n,
    name: `Channel ${n}`,
    zone_id: null,
    zone: null,
    project: { project_key: key },
  });

  it("lists channels by project then number and edits them", async () => {
    const { db } = client({
      "from:radio_channels": [
        okResponse([
          channel(2),
          channel(1),
          { ...channel(3), project: null, zone: { code: "FOH", name: "Front" } },
        ]),
        okResponse({ id: "r9" }),
        okResponse([{ id: "r9" }]),
        okResponse([]),
        okResponse([{ id: "r9" }]),
        down,
        down,
        down,
      ],
    });
    const listed = await listRadioChannels(db, { orgId: "o1", projectId: "j1" });
    expect(listed.ok && listed.data.map((c) => c.channelNumber)).toEqual([3, 1, 2]);
    const input = { channelNumber: 9, name: " Medical ", zoneId: null };
    expect(await createRadioChannel(db, { ...input, orgId: "o1", projectId: "j1" })).toEqual({
      ok: true,
      data: { id: "r9" },
    });
    expect((await updateRadioChannel(db, "r9", input)).ok).toBe(true);
    expect((await updateRadioChannel(db, "r9", input)).ok).toBe(false);
    expect((await archiveRadioChannel(db, "r9")).ok).toBe(true);
    expect((await listRadioChannels(db, { orgId: "o1" })).ok).toBe(false);
    expect((await createRadioChannel(db, { ...input, orgId: "o1", projectId: "j1" })).ok).toBe(
      false,
    );
    expect((await updateRadioChannel(db, "r9", input)).ok).toBe(false);
  });

  it("imports one library zone group, skipping channels in use", async () => {
    const library = [
      { record_id: "RCH-001", zone: "1", channel: "1", assignment: "Emergency", notes: "Primary" },
      { record_id: "RCH-002", zone: 1, channel: 2, assignment: null, notes: null },
      { record_id: "RCH-017", zone: 2, channel: 1, assignment: "All Call", notes: null },
    ];
    const { db, calls } = client({
      "from:std_radio_channel": [
        okResponse(library),
        okResponse(library),
        down,
        okResponse(library),
        okResponse(library),
      ],
      "from:radio_channels": [
        okResponse([channel(1)]),
        okResponse(null),
        okResponse([channel(1), channel(2)]),
        okResponse([]),
        okResponse([]),
        down,
        down,
      ],
    });
    expect(
      await importStandardRadioPlan(db, { orgId: "o1", projectId: "j1", libraryZone: 1 }),
    ).toEqual({
      ok: true,
      data: { added: 1 },
    });
    const insert = calls.filter((c) => c.target === "from:radio_channels")[1];
    expect(insert?.steps[0]).toEqual([
      "insert",
      [[{ org_id: "o1", project_id: "j1", channel_number: 2, name: "RCH-002" }]],
    ]);
    expect(
      await importStandardRadioPlan(db, { orgId: "o1", projectId: "j1", libraryZone: 1 }),
    ).toEqual({
      ok: true,
      data: { added: 0 },
    });
    expect(
      (await importStandardRadioPlan(db, { orgId: "o1", projectId: "j1", libraryZone: 2 })).ok,
    ).toBe(false);
    expect(
      (await importStandardRadioPlan(db, { orgId: "o1", projectId: "j1", libraryZone: 2 })).ok,
    ).toBe(false);
    expect(
      (await importStandardRadioPlan(db, { orgId: "o1", projectId: "j1", libraryZone: 2 })).ok,
    ).toBe(false);
  });

  it("reads the standard library", async () => {
    const { db } = client({ "from:std_radio_channel": [okResponse([]), down] });
    expect(await listStandardRadioChannels(db)).toEqual({ ok: true, data: [] });
    expect((await listStandardRadioChannels(db)).ok).toBe(false);
  });
});
