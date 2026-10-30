/**
 * Contract tests for R5: roster entries and their project facts, the travel party, and the names lock (migrations 2654
 * to 2657). Requests run through `contractApp` and every success is checked against openapi/v1.json with
 * `expectContract`. Standing, logging and every refusal are the database's (pgTAP 2654 to 2657); here the RPCs answer
 * the way the database does, and queued failures stand in for its refusals (422) and for no standing (404).
 */
import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { handlers as opportunities } from "../src/handlers/opportunities.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(55000 + n).padStart(12, "0")}`;
const T = "2026-10-01T12:00:00.000Z";
const ENTRY = id(1);
const ENGAGEMENT = id(2);
const PROJECT = id(3);
const NOT_READABLE = { code: "42501", message: "the roster entry is not readable" };

const travel = {
  id: id(10),
  inbound_airport_code: "MIA",
  inbound_airport_name: "Miami International Airport",
  outbound_airport_code: "JFK",
  outbound_airport_name: "John F Kennedy International Airport",
  inbound_on: "2027-06-01",
  outbound_on: "2027-06-04",
  seat_preference: "Aisle",
  meal_preference: null,
  needs_ground_transport: true,
  needs_lodging: true,
  travel_notes: null,
  updated_at: T,
};

const facts = {
  roster_entry_id: ENTRY,
  engagement_id: ENGAGEMENT,
  org_id: ORG,
  person_id: ME,
  standing: "Producer",
  offered: { travel: true, lodging: true, uniforms: true, parking: false },
  present: { travel: true, uniform: true, vehicle: false },
  entered_by_person: { travel: true, uniform: false, vehicle: false },
  readable: ["Travel"],
  travel,
  uniform: null,
  vehicle: null,
};

function world() {
  const calls: Record<string, Row[]> = {};
  const record = (name: string, args: Row) => (calls[name] ??= []).push(args);
  const db = memoryDb(
    {
      roster_entry_people: [
        tenantRow(ENTRY, ORG, {
          project_id: PROJECT,
          engagement_id: ENGAGEMENT,
          party_name: "Bayside Audio",
          role_type: "Vendor",
          is_self: false,
          person_id: ME,
          full_name: "Kai Morgan",
          invited_email: null,
          invitation_expires_at: null,
          role_code: "9000.50.02",
          job_title: "Audio Technician",
          arrival_starts_at: null,
          arrival_ends_at: null,
          arrival_time_zone: null,
          entry_state: "Submitted",
          person_response: "Accepted",
          responded_at: T,
          return_reason: null,
          replaces_entry_id: null,
          share_categories: [],
        }),
      ],
    },
    {
      roster_project_facts: (args) => {
        if (args["p_roster_entry_id"] !== ENTRY) throw NOT_READABLE;
        return facts;
      },
      save_roster_travel_request: (args) => {
        record("save_roster_travel_request", args);
        if (args["p_inbound_airport_code"] === "XQZ")
          throw refusal("airport_unknown", "Choose an airport from the list.");
        return id(10);
      },
      save_roster_uniform_sizes: (args) => {
        record("save_roster_uniform_sizes", args);
        return id(11);
      },
      save_roster_vehicle: (args) => {
        record("save_roster_vehicle", args);
        if (args["p_plate_region"] === "Florida") throw refusal("plate_region_format");
        return id(12);
      },
      clear_roster_project_fact: (args) => {
        record("clear_roster_project_fact", args);
        return null;
      },
      roster_travel_party: (args) => {
        if (args["p_project_id"] !== PROJECT)
          throw { code: "42501", message: "hospitality.fulfillment.read is required" };
        return [
          {
            roster_entry_id: ENTRY,
            engagement_id: ENGAGEMENT,
            party_name: "Bayside Audio",
            person_id: ME,
            person_name: "Kai Morgan",
            role_code: "9000.50.02",
            arrival_starts_at: null,
            arrival_ends_at: null,
            arrival_time_zone: null,
            travel,
            room: { assigned: false, check_in_on: null, check_out_on: null, block_name: null },
            pickup: { booked: false },
            pass: null,
          },
        ];
      },
      roster_travel_day_counts: () => [
        {
          day: "2027-06-01",
          arriving: 1,
          departing: 0,
          on_site: 1,
          rooms_needed: 1,
          pickups_needed: 1,
          truncated: false,
        },
        {
          day: "2027-06-02",
          arriving: 0,
          departing: 0,
          on_site: 1,
          rooms_needed: 1,
          pickups_needed: 0,
          truncated: false,
        },
      ],
    },
  );
  return { calls, http: requests(contractApp({ handlers: [advancing], db })) };
}

describe("Advancing: roster entries and project facts (R5)", () => {
  it("lists and reads roster entries", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/roster-entries")),
      "rosterEntries.list",
    )) as {
      data: { full_name: string }[];
    };
    expect(page.data[0]?.full_name).toBe("Kai Morgan");
    await expectContract(await success(http.get(`/roster-entries/${ENTRY}`)), "rosterEntries.get");
  });

  it("reads project facts through the logged RPC, 404 without standing", async () => {
    const { http } = world();
    const read = (await expectContract(
      await success(http.get(`/roster-entries/${ENTRY}/project-facts`)),
      "rosterEntries.projectFacts",
    )) as typeof facts;
    expect(read.readable).toEqual(["Travel"]);
    expect(read.uniform).toBeNull();
    expect((await http.get(`/roster-entries/${id(99)}/project-facts`)).status).toBe(404);
  });

  it("saves each kind as a full replacement and refuses with the rule", async () => {
    const { http, calls } = world();
    const response1 = await success(
      http.post(`/roster-entries/${ENTRY}/save-travel-request`, {
        inbound_airport_code: "mia",
        outbound_airport_code: "JFK",
        inbound_on: "2027-06-01",
        outbound_on: "2027-06-04",
        needs_lodging: true,
      }),
    );
    const saved = (await expectContract(response1, "rosterEntries.saveTravelRequest")) as {
      id: string;
    };
    expect(saved.id).toBe(id(10));
    expect(calls["save_roster_travel_request"]?.[0]).toMatchObject({
      p_roster_entry_id: ENTRY,
      p_inbound_airport_code: "mia",
      p_needs_lodging: true,
      p_needs_ground_transport: false,
      p_meal_preference: null,
    });
    const unknown = await http.post(`/roster-entries/${ENTRY}/save-travel-request`, {
      inbound_airport_code: "XQZ",
      outbound_airport_code: null,
      inbound_on: null,
      outbound_on: null,
    });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(await unknown.json())).toContain("airport_unknown");

    const response2 = await success(
      http.post(`/roster-entries/${ENTRY}/save-uniform-sizes`, {
        shirt_size: "M",
        shoe_size: 10.5,
        shoe_size_system: "US Men",
      }),
    );
    await expectContract(response2, "rosterEntries.saveUniformSizes");
    expect(calls["save_roster_uniform_sizes"]?.[0]).toMatchObject({
      p_shirt_size: "M",
      p_jacket_size: null,
      p_shoe_size: 10.5,
    });

    const response3 = await success(
      http.post(`/roster-entries/${ENTRY}/save-vehicle`, {
        make: "Ford",
        model: "Transit",
        plate: "ABC 1234",
        plate_region: "US-FL",
      }),
    );
    await expectContract(response3, "rosterEntries.saveVehicle");
    const region = await http.post(`/roster-entries/${ENTRY}/save-vehicle`, {
      make: "Ford",
      model: "Transit",
      plate: "ABC1234",
      plate_region: "Florida",
    });
    expect(region.status).toBe(422);

    const response4 = await success(
      http.post(`/roster-entries/${ENTRY}/clear-project-fact`, { kind: "Vehicle" }),
    );
    await expectContract(response4, "rosterEntries.clearProjectFact");
    expect(calls["clear_roster_project_fact"]?.[0]).toEqual({
      p_roster_entry_id: ENTRY,
      p_kind: "Vehicle",
    });
  });

  it("reads the travel party and its day counts", async () => {
    const { http } = world();
    const party = (await expectContract(
      await success(http.get(`/roster-entries/travel-party?project_id=${PROJECT}`)),
      "rosterEntries.travelParty",
    )) as { data: { room: { assigned: boolean } }[] };
    expect(party.data[0]?.room.assigned).toBe(false);
    const counts = (await expectContract(
      await success(http.get(`/roster-entries/travel-day-counts?project_id=${PROJECT}`)),
      "rosterEntries.travelDayCounts",
    )) as { data: { rooms_needed: number }[] };
    expect(counts.data.map((d) => d.rooms_needed)).toEqual([1, 1]);
    expect((await http.get(`/roster-entries/travel-party?project_id=${id(98)}`)).status).toBe(404);
  });
});

describe("Opportunities: the names lock (R5, G-142)", () => {
  type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
  function fakeDb(queues: Record<string, Response[]>) {
    const take = (key: string): Response => {
      const next = queues[key]?.shift();
      if (!next) throw new Error(`no queued response for ${key}`);
      return next;
    };
    const args: unknown[] = [];
    const builder = (key: string): Record<string, unknown> => {
      const response = take(key);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
            return () => proxy;
          },
        },
      );
      return proxy;
    };
    return {
      args,
      db: {
        from: (table: string) => builder(`from:${table}`),
        rpc: (name: string, values: unknown) => {
          args.push(values);
          return builder(`rpc:${name}`);
        },
      },
    };
  }
  const engagement = {
    id: ENGAGEMENT,
    org_id: ORG,
    created_at: T,
    created_by: ME,
    updated_at: T,
    updated_by: ME,
    project_id: PROJECT,
    person_id: null,
    role_type: "Vendor",
    engagement_state: "Active",
    application_id: null,
    worker_classification: "VENDOR_SUPPLIED",
    pay_basis: "Day Rate",
    arrangement: "Per Engagement",
    start_date: "2027-06-01",
    end_date: null,
    counterparty_id: id(4),
    roster_locks_at: "2027-05-20T23:59:00.000Z",
    counterparty: { organization_id: id(5) },
    transitions: [{ to_state: "Active", created_at: T }],
    application: null,
  };

  it("sets the lock and reads it back; refusals answer 422", async () => {
    const fake = fakeDb({
      "rpc:set_roster_lock": [
        { data: null, error: null },
        {
          data: null,
          error: {
            code: "XR001",
            message: "roster_lock_engagement_closed: Refused.",
            hint: "roster_lock_engagement_closed",
          },
        },
      ],
      "from:engagements": [{ data: engagement, error: null }],
    });
    const http = requests(contractApp({ handlers: [opportunities], db: fake.db }));
    const response5 = await success(
      http.post(`/engagements/${ENGAGEMENT}/roster-lock`, { locks_at: "2027-05-20T23:59:00.000Z" }),
    );
    const locked = (await expectContract(response5, "engagements.setRosterLock")) as {
      roster_locks_at: string | null;
    };
    expect(locked.roster_locks_at).toBe("2027-05-20T23:59:00.000Z");
    expect(fake.args[0]).toEqual({
      p_engagement_id: ENGAGEMENT,
      p_locks_at: "2027-05-20T23:59:00.000Z",
    });
    const closed = await http.post(`/engagements/${ENGAGEMENT}/roster-lock`, { locks_at: null });
    expect(closed.status).toBe(422);
    expect(fake.args[1]).toEqual({ p_engagement_id: ENGAGEMENT, p_locks_at: null });
  });
});
