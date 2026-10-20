/**
 * Contract tests for A14's handlers (Section 18, gate 5): Credentials (categories, issued credentials
 * with revocation, the access grid, scans decided by app.record_scan, certifications and holders) and
 * Safety incidents (incidents through app.report_incident, transitions and close with sign-off,
 * parties, media, dispatch, masked medical encounters, crisis alerts with the all-clear, the global
 * emergency codes and the radio plan). Requests run through `contractApp`, every response is checked
 * against openapi/v1.json with `expectContract`, and the database is a recording stand-in for
 * supabase-js: each `from(table)` or `rpc(name)` call takes the next queued response. Refusals (422)
 * and hidden rows (404) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers as credentialHandlers } from "../src/handlers/credentials.ts";
import { handlers as safetyHandlers } from "../src/handlers/safety.ts";
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
  const db: Record<string, unknown> = {
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
  db["schema"] = () => db;
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const T = "2026-10-15T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a14-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "If-Match": "*", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const del = { method: "DELETE" };

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [credentialHandlers, safetyHandlers], db: fake.db as never }),
    calls: fake.calls,
  };
}

/**
 * List, get, create, update and delete of a table-backed resource. The queue follows the table
 * handlers: list and get read once; create inserts then reads; update reads, updates and reads;
 * delete reads then soft-deletes. A last read answers 404. Each test checks the responses against
 * the contract with literal operationIds, which the operation coverage gate reads.
 */
async function crud(input: {
  path: string;
  table: string;
  row: Record<string, unknown>;
  create: Record<string, unknown>;
  update?: Record<string, unknown>;
  remove?: boolean;
}) {
  const { row } = input;
  const queue: Response[] = [ok([row]), ok(row), ok({ id: row["id"] }), ok(row)];
  if (input.update) queue.push(ok(row), ok([{ id: row["id"] }]), ok(row));
  if (input.remove) queue.push(ok({ id: row["id"] }), ok(null));
  queue.push(hidden);
  const { api, calls } = app({ [`from:${input.table}`]: queue });
  const item = `${input.path}/${String(row["id"])}`;
  const list = await api.request(input.path);
  const get = await api.request(item);
  const made = await api.request(input.path, post(input.create));
  expect(made.status).toBe(201);
  const updated = input.update ? await api.request(item, patch(input.update)) : undefined;
  const removed = input.remove ? await api.request(item, del) : undefined;
  if (removed) expect(removed.status).toBe(204);
  expect((await api.request(`${input.path}/${id(999)}`)).status).toBe(404);
  return {
    list,
    get,
    made,
    updated: updated as globalThis.Response,
    removed: removed as globalThis.Response,
    calls,
  };
}

describe("Credentials contract", () => {
  it("serves credential categories", async () => {
    const rCredentialCategories = await crud({
      path: "/credential-categories",
      table: "credential_categories",
      row: { ...audit(1), project_id: id(100), code: "ALL-ACCESS", name: "All Access" },
      create: { project_id: id(100), code: "ALL-ACCESS", name: "All Access" },
      update: { name: "All Areas" },
      remove: true,
    });

    await expectContract(rCredentialCategories.list, "credentialCategories.list");
    await expectContract(rCredentialCategories.get, "credentialCategories.get");
    await expectContract(rCredentialCategories.made, "credentialCategories.create");
    await expectContract(rCredentialCategories.updated, "credentialCategories.update");
    await expectContract(rCredentialCategories.removed, "credentialCategories.delete");
    expect(rCredentialCategories.calls[2]?.steps[0]).toEqual([
      "insert",
      [{ org_id: ORG, name: "All Access", project_id: id(100), code: "ALL-ACCESS" }],
    ]);
  });

  const credential = {
    ...audit(2),
    project_id: id(100),
    credential_category_id: id(1),
    engagement_id: null,
    issued_by: ME,
    valid_from: T,
    valid_to: null,
    holder_person_id: id(200),
    credential_number: "CR-000001",
    revoked_at: null,
    revoked_by: null,
  };

  it("issues credentials and revokes them once", async () => {
    const rCredentials = await crud({
      path: "/credentials",
      table: "credentials",
      row: credential,
      create: { credential_category_id: id(1), holder_person_id: id(200) },
    });

    await expectContract(rCredentials.list, "credentials.list");
    await expectContract(rCredentials.get, "credentials.get");
    await expectContract(rCredentials.made, "credentials.create");
    const revoked = { ...credential, revoked_at: T, revoked_by: ME };
    const { api } = app({
      "from:credentials": [
        ok({ id: id(2) }),
        ok([{ id: id(2) }]),
        ok(revoked),
        ok({ id: id(2) }),
        refusal("credential_revoked"),
      ],
    });
    const done = await api.request(`/credentials/${id(2)}/revoke`, post({}));
    await expectContract(done, "credentials.revoke");
    const again = await api.request(`/credentials/${id(2)}/revoke`, post({}));
    expect(again.status).toBe(422);
    await expectContract(again, "credentials.revoke");
  });

  it("refuses self-issue with its rule", async () => {
    const { api } = app({ "from:credentials": [refusal("credential_self_issue")] });
    const refused = await api.request(
      "/credentials",
      post({ credential_category_id: id(1), holder_person_id: ME }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "credentials.create");
  });

  it("serves the access grid", async () => {
    const rAccessGridEntries = await crud({
      path: "/access-grid",
      table: "access_grid",
      row: {
        ...audit(3),
        zone_id: id(300),
        credential_category_id: id(1),
        access_level_enum_id: "ENM-036",
        window_starts_at: T,
        window_ends_at: "2026-11-15T12:00:00.000Z",
        project_id: id(100),
      },
      create: {
        zone_id: id(300),
        credential_category_id: id(1),
        access_level_enum_id: "ENM-036",
        window_starts_at: T,
        window_ends_at: "2026-11-15T12:00:00.000Z",
      },
      update: { access_level_enum_id: "ENM-037" },
      remove: true,
    });

    await expectContract(rAccessGridEntries.list, "accessGridEntries.list");
    await expectContract(rAccessGridEntries.get, "accessGridEntries.get");
    await expectContract(rAccessGridEntries.made, "accessGridEntries.create");
    await expectContract(rAccessGridEntries.updated, "accessGridEntries.update");
    await expectContract(rAccessGridEntries.removed, "accessGridEntries.delete");
  });

  it("records scans through app.record_scan and lists the log", async () => {
    const scan = {
      ...audit(4),
      zone_id: id(300),
      credential_id: id(2),
      scanned_at: T,
      result: "Denied",
      project_id: id(100),
      device_scanned_at: "2026-10-15T11:59:00.000Z",
      offline_result: "Granted",
    };
    const decision = {
      id: id(4),
      credential_id: id(2),
      credential_number: "CR-000001",
      holder_name: "Demo Field Lead",
      category_code: "CREW",
      zone_id: id(300),
      zone_code: "LAWN",
      scanned_at: T,
      result: "Denied",
      replayed: false,
    };
    const { api, calls } = app({
      "from:access_scans": [ok([scan]), ok(scan), ok(scan), hidden],
      "rpc:record_scan": [ok([decision]), refusal("credential_unknown")],
    });
    await expectContract(await api.request("/access-scans"), "accessScans.list");
    await expectContract(await api.request(`/access-scans/${id(4)}`), "accessScans.get");
    const made = await api.request(
      "/access-scans",
      post({
        zone_id: id(300),
        credential_id: id(2),
        device_scanned_at: "2026-10-15T11:59:00.000Z",
        offline_result: "Granted",
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "accessScans.create");
    expect(calls.find((c) => c.target === "rpc:record_scan")?.steps[0]?.[1]).toEqual([
      {
        p_zone_id: id(300),
        p_credential_id: id(2),
        p_device_scanned_at: "2026-10-15T11:59:00.000Z",
        p_offline_result: "Granted",
      },
    ]);
    const unknown = await api.request(
      "/access-scans",
      post({ zone_id: id(300), credential_id: id(9) }),
    );
    expect(unknown.status).toBe(422);
    await expectContract(unknown, "accessScans.create");
    expect((await api.request(`/access-scans/${id(999)}`)).status).toBe(404);
  });

  it("serves certifications and holders", async () => {
    const rCertifications = await crud({
      path: "/certifications",
      table: "certifications",
      row: { ...audit(5), name: "OSHA 10", issuing_body: "OSHA" },
      create: { name: "OSHA 10", issuing_body: "OSHA" },
      update: { issuing_body: "US OSHA" },
      remove: true,
    });

    await expectContract(rCertifications.list, "certifications.list");
    await expectContract(rCertifications.get, "certifications.get");
    await expectContract(rCertifications.made, "certifications.create");
    await expectContract(rCertifications.updated, "certifications.update");
    await expectContract(rCertifications.removed, "certifications.delete");
    const rCertificationHolders = await crud({
      path: "/certification-holders",
      table: "certification_holders",
      row: {
        ...audit(6),
        certification_id: id(5),
        person_id: id(200),
        expires_on: null,
        verified_by: ME,
        issued_on: "2026-01-10",
        public_verification_consented: false,
      },
      create: { certification_id: id(5), person_id: id(200), issued_on: "2026-01-10" },
      update: { public_verification_consented: true },
      remove: true,
    });

    await expectContract(rCertificationHolders.list, "certificationHolders.list");
    await expectContract(rCertificationHolders.get, "certificationHolders.get");
    await expectContract(rCertificationHolders.made, "certificationHolders.create");
    await expectContract(rCertificationHolders.updated, "certificationHolders.update");
    await expectContract(rCertificationHolders.removed, "certificationHolders.delete");
  });
});

describe("Safety incidents contract", () => {
  const incident = {
    ...audit(10),
    project_id: id(100),
    title: "Guest Fall Near Gate 2",
    occurred_at: T,
    zone_id: id(300),
    latitude: 25.8001,
    longitude: -80.1999,
    severity_enum_id: "ENM-097",
    incident_number: 142,
    incident_state: "Reported",
    reported_by: ME,
    closed_signed_off_by: null,
    accuracy_m: 8,
    device_reported_at: null,
  };

  it("files incidents through app.report_incident, lists, reads and edits them", async () => {
    const { api, calls } = app({
      "from:incidents": [
        ok([incident]),
        ok(incident),
        ok(incident),
        ok(incident),
        ok([{ id: id(10) }]),
        ok(incident),
        hidden,
      ],
      // closed_at reads the transition ledger once per full read (A54-002).
      "from:incident_state_transitions": [ok([]), ok([]), ok([]), ok([]), ok([])],
      "rpc:report_incident": [
        ok([{ id: id(10), incident_number: 142, incident_state: "Reported", replayed: false }]),
      ],
    });
    await expectContract(await api.request("/incidents"), "incidents.list");
    await expectContract(await api.request(`/incidents/${id(10)}`), "incidents.get");
    const made = await api.request(
      "/incidents",
      post({
        project_id: id(100),
        title: "Guest Fall Near Gate 2",
        severity_enum_id: "ENM-097",
        occurred_at: T,
        zone_id: id(300),
        latitude: 25.8001,
        longitude: -80.1999,
        accuracy_m: 8,
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "incidents.create");
    expect(calls.find((c) => c.target === "rpc:report_incident")?.steps[0]?.[1]).toEqual([
      {
        p_project_id: id(100),
        p_title: "Guest Fall Near Gate 2",
        p_severity_enum_id: "ENM-097",
        p_occurred_at: T,
        p_zone_id: id(300),
        p_latitude: 25.8001,
        p_longitude: -80.1999,
        p_accuracy_m: 8,
      },
    ]);
    const edited = await api.request(
      `/incidents/${id(10)}`,
      patch({ title: "Guest Fall at Gate 2" }),
    );
    await expectContract(edited, "incidents.update");
    expect((await api.request(`/incidents/${id(999)}`)).status).toBe(404);
  });

  it("moves incidents with compare-and-set and closes them only with sign-off", async () => {
    const contained = { ...incident, incident_state: "Contained" };
    const closed = { ...incident, incident_state: "Closed", closed_signed_off_by: id(201) };
    const { api, calls } = app({
      "from:incidents": [
        ok({ id: id(10) }),
        ok(contained),
        ok({ id: id(10) }),
        ok({ id: id(10) }),
        ok(closed),
      ],
      "from:incident_state_transitions": [
        ok([]),
        ok([{ incident_id: id(10), created_at: T, created_by: id(201) }]),
      ],
      "rpc:transition_incident": [ok(id(50))],
      "rpc:close_incident": [refusal("sod_approval_requester"), ok(id(51))],
    });
    const moved = await api.request(
      `/incidents/${id(10)}/transitions`,
      post({ expected_state: "Reported", to_state: "Contained", reason: "Area cleared." }),
    );
    await expectContract(moved, "incidents.transition");
    expect(calls.find((c) => c.target === "rpc:transition_incident")?.steps[0]?.[1]).toEqual([
      {
        p_incident_id: id(10),
        p_expected: "Reported",
        p_next: "Contained",
        p_reason: "Area cleared.",
      },
    ]);
    // The contract's transition never names Closed: closing goes through /close with sign-off.
    const toClosed = await api.request(
      `/incidents/${id(10)}/transitions`,
      post({ expected_state: "Contained", to_state: "Closed", reason: "Done." }),
    );
    expect(toClosed.status).toBe(422);
    await expectContract(toClosed, "incidents.transition");
    const selfSignoff = await api.request(
      `/incidents/${id(10)}/close`,
      post({ note: "Signed off." }),
    );
    expect(selfSignoff.status).toBe(422);
    await expectContract(selfSignoff, "incidents.close");
    const signed = await api.request(
      `/incidents/${id(10)}/close`,
      post({ note: "Inspected and safe." }),
    );
    const signedBody = (await expectContract(signed, "incidents.close")) as { closed_at: string };
    expect(signedBody.closed_at).toBe(T);
    const missing = await api.request(`/incidents/${id(10)}/close`, post({}));
    expect(missing.status).toBe(422);
  });

  it("serves parties, media, dispatch and the radio plan", async () => {
    const rIncidentParties = await crud({
      path: "/incident-parties",
      table: "incident_parties",
      row: { ...audit(11), incident_id: id(10), person_id: null, description: "Witness" },
      create: { incident_id: id(10), description: "Witness" },
      update: { description: "Bartender, witness" },
      remove: true,
    });

    await expectContract(rIncidentParties.list, "incidentParties.list");
    await expectContract(rIncidentParties.get, "incidentParties.get");
    await expectContract(rIncidentParties.made, "incidentParties.create");
    await expectContract(rIncidentParties.updated, "incidentParties.update");
    await expectContract(rIncidentParties.removed, "incidentParties.delete");
    const rIncidentMediaItems = await crud({
      path: "/incident-media",
      table: "incident_media",
      row: {
        ...audit(12),
        incident_id: id(10),
        media_uri: "org/incidents/gate.jpg",
        captured_at: null,
        project_id: id(100),
      },
      create: { incident_id: id(10), media_uri: "org/incidents/gate.jpg" },
      remove: true,
    });

    await expectContract(rIncidentMediaItems.list, "incidentMediaItems.list");
    await expectContract(rIncidentMediaItems.get, "incidentMediaItems.get");
    await expectContract(rIncidentMediaItems.made, "incidentMediaItems.create");
    await expectContract(rIncidentMediaItems.removed, "incidentMediaItems.delete");
    const rDispatchAssignments = await crud({
      path: "/dispatch-assignments",
      table: "dispatch_assignments",
      row: {
        ...audit(13),
        incident_id: id(10),
        dispatched_at: T,
        arrived_at: null,
        membership_id: id(400),
      },
      create: { incident_id: id(10), membership_id: id(400) },
      update: { arrived_at: "2026-10-15T12:05:00.000Z" },
    });

    await expectContract(rDispatchAssignments.list, "dispatchAssignments.list");
    await expectContract(rDispatchAssignments.get, "dispatchAssignments.get");
    await expectContract(rDispatchAssignments.made, "dispatchAssignments.create");
    await expectContract(rDispatchAssignments.updated, "dispatchAssignments.update");
    const rRadioChannels = await crud({
      path: "/radio-channels",
      table: "radio_channels",
      row: { ...audit(14), channel_number: 4, name: "Medical", project_id: id(100), zone_id: null },
      create: { channel_number: 4, name: "Medical", project_id: id(100) },
      update: { name: "Medical and First Aid" },
      remove: true,
    });

    await expectContract(rRadioChannels.list, "radioChannels.list");
    await expectContract(rRadioChannels.get, "radioChannels.get");
    await expectContract(rRadioChannels.made, "radioChannels.create");
    await expectContract(rRadioChannels.updated, "radioChannels.update");
    await expectContract(rRadioChannels.removed, "radioChannels.delete");
  });

  it("masks medical notes and writes them through the encrypting RPCs", async () => {
    const encounter = {
      ...audit(15),
      incident_id: id(10),
      patient_description: "Guest, adult",
      disposition: "Released",
    };
    const { api, calls } = app({
      "from:medical_encounters": [
        ok([encounter]),
        ok(encounter),
        ok(encounter),
        ok({ id: id(15) }),
        ok(encounter),
        hidden,
      ],
      "from:medical_encounters_masked": [
        ok([{ id: id(15), treatment_notes: null }]),
        ok([{ id: id(15), treatment_notes: "Cooled, fluids." }]),
        ok([{ id: id(15), treatment_notes: "Cooled, fluids." }]),
        ok([{ id: id(15), treatment_notes: "Cooled, fluids." }]),
        ok([{ id: id(15), treatment_notes: "Cooled, oral fluids." }]),
      ],
      "rpc:record_medical_encounter": [ok(id(15))],
      "rpc:update_medical_encounter": [ok(null)],
    });
    const list = (await expectContract(
      await api.request("/medical-encounters"),
      "medicalEncounters.list",
    )) as { data: { treatment_notes: string | null }[] };
    expect(list.data[0]?.treatment_notes).toBeNull();
    await expectContract(
      await api.request(`/medical-encounters/${id(15)}`),
      "medicalEncounters.get",
    );
    const made = await api.request(
      "/medical-encounters",
      post({
        incident_id: id(10),
        patient_description: "Guest, adult",
        treatment_notes: "Cooled, fluids.",
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "medicalEncounters.create");
    expect(calls.find((c) => c.target === "rpc:record_medical_encounter")?.steps[0]?.[1]).toEqual([
      {
        p_incident_id: id(10),
        p_patient_description: "Guest, adult",
        p_treatment_notes: "Cooled, fluids.",
      },
    ]);
    const revised = await api.request(
      `/medical-encounters/${id(15)}`,
      patch({ treatment_notes: "Cooled, oral fluids." }),
    );
    await expectContract(revised, "medicalEncounters.update");
    expect((await api.request(`/medical-encounters/${id(999)}`)).status).toBe(404);
  });

  it("announces crisis alerts and gives the all-clear once", async () => {
    const alert = {
      ...audit(16),
      project_id: id(100),
      message: "Power failure at the lawn stage.",
      issued_at: T,
      ended_at: null,
      emergency_code: "CODE_YELLOW",
    };
    const ended = { ...alert, ended_at: "2026-10-15T12:40:00.000Z" };
    const { api } = app({
      "from:crisis_alerts": [
        ok([alert]),
        ok(alert),
        ok({ id: id(16) }),
        ok(alert),
        ok(alert),
        ok([{ id: id(16) }]),
        ok(ended),
        ok(ended),
        hidden,
      ],
    });
    await expectContract(await api.request("/crisis-alerts"), "crisisAlerts.list");
    await expectContract(await api.request(`/crisis-alerts/${id(16)}`), "crisisAlerts.get");
    const made = await api.request(
      "/crisis-alerts",
      post({
        project_id: id(100),
        message: "Power failure at the lawn stage.",
        emergency_code: "CODE_YELLOW",
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "crisisAlerts.create");
    await expectContract(
      await api.request(`/crisis-alerts/${id(16)}/clear`, post({})),
      "crisisAlerts.clear",
    );
    const twice = await api.request(`/crisis-alerts/${id(16)}/clear`, post({}));
    expect(twice.status).toBe(422);
    await expectContract(twice, "crisisAlerts.clear");
    expect((await api.request(`/crisis-alerts/${id(999)}`)).status).toBe(404);
  });

  it("reads the global emergency codes in canon order", async () => {
    const code = {
      code: "CODE_RED",
      label: "Code Red",
      emergency: "Fire Emergency",
      swatch: "ecode-red",
      sort_order: 1,
    };
    const { api, calls } = app({ "from:emergency_code": [ok([code]), ok(code), hidden] });
    await expectContract(await api.request("/emergency-codes"), "emergencyCodes.list");
    await expectContract(await api.request("/emergency-codes/CODE_RED"), "emergencyCodes.get");
    expect(calls[1]?.steps).toContainEqual(["eq", ["code", "CODE_RED"]]);
    expect((await api.request("/emergency-codes/CODE_NONE")).status).toBe(404);
  });
});
