import { describe, expect, it } from "vitest";
import {
  listEngagementOptions,
  listProjectPeople,
  resolveProjectPerson,
} from "../src/project-people.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const member = {
  person_id: "per1",
  full_name: "Dave Doyle",
  membership_id: "m1",
  engagement_id: null,
  role_type: null,
  engagement_state: null,
  account_name: null,
};
const supplied = {
  person_id: "per2",
  full_name: "Sam Kowalski",
  membership_id: null,
  engagement_id: "e1",
  role_type: "Vendor",
  engagement_state: "Active",
  account_name: "Bayside Audio",
};

describe("project people", () => {
  it("maps members and engaged people", async () => {
    const { db, calls } = moduleClient({
      "rpc:project_people": [okResponse([member, supplied]), errorResponse("42501", "denied")],
    });
    expect(await listProjectPeople(db, "p1")).toEqual({
      ok: true,
      data: [
        {
          personId: "per1",
          fullName: "Dave Doyle",
          membershipId: "m1",
          engagementId: null,
          roleType: null,
          engagementState: null,
          accountName: null,
        },
        {
          personId: "per2",
          fullName: "Sam Kowalski",
          membershipId: null,
          engagementId: "e1",
          roleType: "Vendor",
          engagementState: "Active",
          accountName: "Bayside Audio",
        },
      ],
    });
    expect(stepsOf(calls[0], "args")).toEqual([[{ p_project_id: "p1" }]]);
    expect(await listProjectPeople(db, "p1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("resolves a picked person to their membership or engagement", async () => {
    const { db } = moduleClient({
      "rpc:project_people": [
        okResponse([member, supplied]),
        okResponse([member, supplied]),
        okResponse([member]),
        errorResponse("XX000", "down"),
      ],
    });
    expect(await resolveProjectPerson(db, "p1", "per1")).toEqual({
      ok: true,
      data: { membershipId: "m1", engagementId: null },
    });
    expect(await resolveProjectPerson(db, "p1", "per2")).toEqual({
      ok: true,
      data: { membershipId: null, engagementId: "e1" },
    });
    const refused = await resolveProjectPerson(db, "p1", "per2");
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "person_not_on_project",
    );
    expect((await resolveProjectPerson(db, "p1", "per1")).ok).toBe(false);
  });

  it("lists engagement options for the org or one project", async () => {
    const option = {
      engagement_id: "e1",
      project_id: "p1",
      project_key: "NWL",
      role_type: "Vendor",
      engagement_state: "Active",
      person_id: null,
      person_name: null,
      account_name: "Bayside Audio",
    };
    const { db, calls } = moduleClient({
      "rpc:engagement_options": [
        okResponse([option]),
        okResponse([]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await listEngagementOptions(db, { orgId: "o1" })).toEqual({
      ok: true,
      data: [
        {
          engagementId: "e1",
          projectId: "p1",
          projectKey: "NWL",
          roleType: "Vendor",
          engagementState: "Active",
          personId: null,
          personName: null,
          accountName: "Bayside Audio",
        },
      ],
    });
    expect((await listEngagementOptions(db, { orgId: "o1", projectId: "p1" })).ok).toBe(true);
    expect(stepsOf(calls[0], "args")).toEqual([[{ p_org_id: "o1" }]]);
    expect(stepsOf(calls[1], "args")).toEqual([[{ p_org_id: "o1", p_project_id: "p1" }]]);
    expect((await listEngagementOptions(db, { orgId: "o1" })).ok).toBe(false);
  });
});
