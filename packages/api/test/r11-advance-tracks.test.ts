/**
 * Contract tests for R11's advance tracks (RRR-192, migration 2743; parity gap G-176): `advanceSections.setTrack`,
 * `advanceRecipients.signOffTrack`, the `advanceTrackSignoffs` resource with its `revoke` action, and
 * `advanceTrackProgress`. Requests run through `contractApp` against the in-memory client; every success is checked
 * against openapi/v1.json with `expectContract`, and a database refusal answers 422 with its rule.
 */
import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(29400 + n).padStart(12, "0")}`;
const PACKET = id(1);
const SECTION = id(2);
const RECIPIENT = id(3);
const SIGNOFF = id(4);
const PROJECT = id(5);
const NEW_SIGNOFF = id(6);

function world() {
  const db: MemoryDb = memoryDb(
    {
      advance_sections: [
        tenantRow(SECTION, ORG, {
          advance_packet_id: PACKET,
          position: 1,
          title: "Hotel",
          prompt: null,
          section_kind: "Text",
          window_kind: null,
          max_lines: null,
          per_person: false,
          track: "General",
        }),
      ],
      advance_recipients: [
        tenantRow(RECIPIENT, ORG, {
          advance_packet_id: PACKET,
          person_id: null,
          counterparty_id: id(7),
          engagement_id: null,
          names_due_at: null,
        }),
      ],
      advance_track_signoffs: [
        tenantRow(SIGNOFF, ORG, {
          advance_recipient_id: RECIPIENT,
          track: "Technical",
          signed_off_at: "2026-10-30T12:00:00.000Z",
          revoked_at: null,
          revoke_reason: null,
        }),
      ],
      advance_track_progress: [
        {
          org_id: ORG,
          project_id: PROJECT,
          advance_packet_id: PACKET,
          advance_recipient_id: RECIPIENT,
          recipient_label: "Bayside Audio",
          track: "Hospitality",
          sections_total: 2,
          sections_done: 2,
          sections_outstanding: 0,
          overdue: false,
          signoff_id: null,
          signed_off_at: null,
          signed_off_by_name: null,
          track_state: "Ready for Sign-off",
        },
      ],
    },
    {
      sign_off_advance_track: (args, mem) => {
        mem.tables["advance_track_signoffs"]?.push(
          tenantRow(NEW_SIGNOFF, ORG, {
            advance_recipient_id: args["p_recipient_id"],
            track: args["p_track"],
            signed_off_at: "2026-10-31T12:00:00.000Z",
            revoked_at: null,
            revoke_reason: null,
          }),
        );
        return NEW_SIGNOFF;
      },
      revoke_advance_track_signoff: (args, mem) => {
        const row = mem.tables["advance_track_signoffs"]?.find(
          (r) => r["id"] === args["p_signoff_id"],
        );
        if (row) {
          row["revoked_at"] = "2026-10-31T13:00:00.000Z";
          row["revoke_reason"] = args["p_reason"];
        }
        return null;
      },
    },
  );
  const app = contractApp({ handlers: [advancing], db });
  return { db, http: requests(app) };
}

describe("R11 contract: section tracks", () => {
  it("moves a section to another track", async () => {
    const { http, db } = world();
    const res = await success(
      http.post(`/advance-sections/${SECTION}/set-track`, { track: "Hospitality" }),
    );
    const section = (await expectContract(res, "advanceSections.setTrack")) as Row;
    expect(section["track"]).toBe("Hospitality");
    expect(db.tables["advance_sections"]?.[0]?.["track"]).toBe("Hospitality");
    expect(
      (await http.post(`/advance-sections/${SECTION}/set-track`, { track: "Backstage" })).status,
    ).toBe(422);
    expect(
      (await http.post(`/advance-sections/${id(99)}/set-track`, { track: "Finance" })).status,
    ).toBe(404);
  });
});

describe("R11 contract: sign-offs", () => {
  it("signs off a recipient's track and revokes a sign-off", async () => {
    const { http, db } = world();
    const signed = await success(
      http.post(`/advance-recipients/${RECIPIENT}/sign-off-track`, { track: "Hospitality" }),
    );
    const signoff = (await expectContract(signed, "advanceRecipients.signOffTrack")) as Row;
    expect(signoff["id"]).toBe(NEW_SIGNOFF);
    expect(signoff["track"]).toBe("Hospitality");

    const page = (await expectContract(
      await success(http.get("/advance-track-signoffs")),
      "advanceTrackSignoffs.list",
    )) as { data: Row[] };
    expect(page.data.length).toBe(2);
    await expectContract(
      await success(http.get(`/advance-track-signoffs/${SIGNOFF}`)),
      "advanceTrackSignoffs.get",
    );
    const revoke = await success(
      http.post(`/advance-track-signoffs/${SIGNOFF}/revoke`, {
        reason: "The power answer came in after sign-off.",
      }),
    );
    const revoked = (await expectContract(revoke, "advanceTrackSignoffs.revoke")) as Row;
    expect(revoked["revoke_reason"]).toBe("The power answer came in after sign-off.");

    db.fail("rpc:sign_off_advance_track", {
      code: "XR001",
      message:
        "advance_track_incomplete: Every section on the track must be accepted, complete or not applicable first.",
    });
    const refused = await http.post(`/advance-recipients/${RECIPIENT}/sign-off-track`, {
      track: "Technical",
    });
    expect(refused.status).toBe(422);
  });
});

describe("R11 contract: track progress", () => {
  it("lists each recipient's computed track state", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/advance-track-progress")),
      "advanceTrackProgress.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["track_state"]).toBe("Ready for Sign-off");
    expect(page.data[0]?.["sections_done"]).toBe(2);
  });
});
