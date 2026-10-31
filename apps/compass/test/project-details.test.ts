import type { XosClient } from "@xos/data";
import type { MyRosterEntry } from "@xos/data/roster";
import type { RosterProjectFacts } from "@xos/data/roster-facts";
import { describe, expect, it } from "vitest";
import {
  factFields,
  liveEntries,
  projectDetailCards,
  saveProjectFact,
} from "../src/domain/projectDetails";

/**
 * Project details in Compass (R5): a card per offered kind, and every save goes to the server through the shared
 * parsers and the repository's RPC, never the offline queue.
 */

const offered = (travel: boolean, uniforms: boolean, parking: boolean, lodging = false) => ({
  offered: { travel, lodging, uniforms, parking },
});

/** A client that records every call: RPCs answer with an id, anything else (a queue, a table write) is recorded. */
function recordingClient() {
  const calls: string[] = [];
  const db = {
    rpc: (name: string) => {
      calls.push(`rpc ${name}`);
      return Promise.resolve({ data: "row-1", error: null });
    },
    from: (table: string) => {
      calls.push(`from ${table}`);
      throw new Error(`no table writes: ${table}`);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("project details cards", () => {
  it("show one card per offered kind", () => {
    expect(projectDetailCards(offered(true, true, true))).toEqual(["Travel", "Uniform", "Vehicle"]);
    expect(projectDetailCards(offered(false, true, false))).toEqual(["Uniform"]);
    expect(projectDetailCards(offered(false, false, true))).toEqual(["Vehicle"]);
    expect(projectDetailCards(offered(false, false, false, true))).toEqual([]);
  });

  it("list live entries the person has not declined", () => {
    const entry = (over: Partial<MyRosterEntry>): MyRosterEntry => ({
      id: "r1",
      engagementId: "e1",
      projectId: "p1",
      orgName: "Northwind Live",
      projectName: "Summer Series",
      partyName: "Bayside Audio",
      roleType: "Vendor",
      jobTitle: "A2",
      arrivalStartsAt: null,
      arrivalEndsAt: null,
      arrivalTimeZone: null,
      entryState: "Accepted",
      personResponse: "Accepted",
      isSelf: false,
      shareCategories: [],
      ...over,
    });
    expect(
      liveEntries([
        entry({ id: "a" }),
        entry({ id: "w", entryState: "Withdrawn" }),
        entry({ id: "d", personResponse: "Declined" }),
      ]).map((e) => e.id),
    ).toEqual(["a"]);
  });

  it("start from what was saved", () => {
    const facts: Pick<RosterProjectFacts, "travel" | "uniform" | "vehicle"> = {
      travel: null,
      uniform: null,
      vehicle: {
        make: "Ford",
        model: "Transit",
        color: null,
        plate: "ABC123",
        plateRegion: "US-FL",
        updatedAt: null,
      },
    };
    expect(factFields("Vehicle", facts)).toEqual({
      make: "Ford",
      model: "Transit",
      color: "",
      plate: "ABC123",
      plateRegion: "US-FL",
    });
    expect(factFields("Travel", facts)["needsLodging"]).toBe("");
  });
});

describe("saving project details", () => {
  it("saves online through the RPC and never queues", async () => {
    const { db, calls } = recordingClient();
    const saved = await saveProjectFact(db, "r1", "Vehicle", {
      make: "Ford",
      model: "Transit",
      color: "",
      plate: "abc 123",
      plateRegion: "us-fl",
    });
    expect(saved).toEqual({ kind: "saved" });
    expect(calls).toEqual(["rpc save_roster_vehicle"]);
  });

  it("names the fields to fix before any call", async () => {
    const { db, calls } = recordingClient();
    const saved = await saveProjectFact(db, "r1", "Travel", {
      inboundOn: "2027-05-04",
      outboundOn: "2027-05-01",
    });
    expect(saved.kind).toBe("invalid");
    expect(saved.kind === "invalid" ? saved.fields["outboundOn"] : null).toBe(
      "workDetails.errors.invalid",
    );
    expect(calls).toEqual([]);
  });

  it("shows a refusal in the rule's own words", async () => {
    const db = {
      rpc: () =>
        Promise.resolve({
          data: null,
          error: {
            code: "XR001",
            message: "offering_not_offered: not offered",
            details: null,
            hint: null,
          },
        }),
    } as unknown as XosClient;
    const saved = await saveProjectFact(db, "r1", "Uniform", { shirtSize: "M" });
    expect(saved.kind).toBe("failed");
  });
});
