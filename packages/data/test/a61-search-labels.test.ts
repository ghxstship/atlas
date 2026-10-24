import { describe, expect, it } from "vitest";
import { labelActivity, type ActivityEntry } from "../src/activity.ts";
import { isPartnerOrganization } from "../src/identity.ts";
import { fillPersonNames, personNames } from "../src/person-names.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * A61 (RRR-106): activity labels, name resolution and the partner condition. The command menu search
 * moved to app.global_search (A87, test/search.test.ts).
 */

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: "a",
    at: "2026-10-19T12:00:00Z",
    type: "shift.created",
    subjectTable: "shifts",
    subjectId: "s1",
    project: null,
    actor: "Demo Producer",
    recordKey: null,
    recordTitle: null,
    data: {},
    description: null,
    actorPersonId: null,
    ...partial,
  };
}

describe("labelActivity (A59-030)", () => {
  it("names shifts and time entries by their record, credentials, engagements, approvals and domains", async () => {
    const { db } = fakeClient({
      "from:shifts": [
        okResponse([
          {
            id: "s1",
            record: {
              record_number: 17,
              title: "Stagehand · Load-in",
              project: { project_key: "NWS" },
            },
          },
          { id: "s2", role_code: "5000.51.02", starts_at: "2026-10-18T12:00:00Z", record: null },
        ]),
      ],
      "from:xpms.role": [okResponse([{ role_code: "5000.51.02", job_title: "Stagehand" }])],
      "from:credentials": [
        okResponse([{ id: "c1", credential_number: "CR-000003", holder_person_id: "p9" }]),
      ],
      "from:engagement_board": [
        okResponse([{ engagement_id: "e1", party_name: "Demo Crew Member" }]),
      ],
      "from:approval_instances": [
        okResponse([{ id: "ap1", document_type: "Purchase Order", subject_reference: "PO-44" }]),
      ],
      "rpc:person_names": [okResponse([{ person_id: "p9", full_name: "Demo Field Tech" }])],
    });
    const labelled = await labelActivity(db, [
      entry({ id: "1" }),
      entry({
        id: "2",
        type: "time_entry.clocked_in",
        subjectTable: "time_entries",
        subjectId: "t1",
        data: { shift_id: "s1" },
      }),
      entry({ id: "3", type: "credential.issued", subjectTable: "credentials", subjectId: "c1" }),
      entry({ id: "4", type: "engagement.created", subjectTable: "engagements", subjectId: "e1" }),
      entry({
        id: "5",
        type: "approval.requested",
        subjectTable: "approval_instances",
        subjectId: "ap1",
      }),
      entry({
        id: "6",
        type: "organization.domain_added",
        subjectTable: "org_domains",
        subjectId: "d1",
        data: { hostname: "atlas.example.com" },
      }),
      entry({ id: "7", recordKey: "NWS-1", recordTitle: "Kickoff" }),
      entry({ id: "8", subjectId: "s2" }),
    ]);
    expect(labelled[7]?.subjectAt).toBe("2026-10-18T12:00:00Z");
    expect(labelled.map((e) => [e.recordKey, e.recordTitle, e.subjectLabel ?? null])).toEqual([
      ["NWS-17", "Stagehand · Load-in", null],
      ["NWS-17", "Stagehand · Load-in", null],
      [null, null, "CR-000003 · Demo Field Tech"],
      [null, null, "Demo Crew Member"],
      [null, null, "Purchase Order PO-44"],
      [null, null, "atlas.example.com"],
      ["NWS-1", "Kickoff", null],
      [null, null, "Stagehand"],
    ]);
  });

  it("keeps the generic noun when a lookup fails or nothing needs a label", async () => {
    const { db } = fakeClient({ "from:credentials": [errorResponse("42501", "denied")] });
    const [only] = await labelActivity(db, [
      entry({ type: "credential.issued", subjectTable: "credentials", subjectId: "c1" }),
    ]);
    expect(only?.subjectLabel).toBeUndefined();
    const none = fakeClient({});
    expect(await labelActivity(none.db, [entry({ recordKey: "NWS-1" })])).toHaveLength(1);
  });
});

describe("person names (A59-011)", () => {
  it("skips the lookup when every name is known and survives a failed lookup", async () => {
    const { db, calls } = fakeClient({ "rpc:person_names": [errorResponse("XX000", "down")] });
    expect(
      await fillPersonNames(
        db,
        [{ id: "p1", name: "Known" }],
        (x) => x.id,
        (x) => x.name,
        (x) => x,
      ),
    ).toEqual([{ id: "p1", name: "Known" }]);
    expect(calls).toHaveLength(0);
    expect((await personNames(db, ["p1", "p1", null, ""])).size).toBe(0);
    expect(calls[0]?.steps).toContainEqual(["args", [{ p_person_ids: ["p1"] }]]);
  });
});

describe("isPartnerOrganization (A59-020)", () => {
  it("counts a partner agreement before any client org", async () => {
    const withAgreement = fakeClient({
      "from:partner_agreements": [{ data: null, error: null, count: 1 } as never],
    });
    expect(await isPartnerOrganization(withAgreement.db, "o1")).toEqual({ ok: true, data: true });
    const clientsOnly = fakeClient({
      "from:partner_agreements": [{ data: null, error: null, count: 0 } as never],
      "from:organizations": [{ data: null, error: null, count: 2 } as never],
    });
    expect(await isPartnerOrganization(clientsOnly.db, "o1")).toEqual({ ok: true, data: true });
    const denied = fakeClient({ "from:partner_agreements": [errorResponse("42501", "denied")] });
    expect((await isPartnerOrganization(denied.db, "o1")).ok).toBe(false);
  });
});
