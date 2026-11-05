/**
 * Contract tests for A10's Advancing handlers (Section 18, gate 5): packets, sections, recipients,
 * answers and their review, promotions, riders, rider lines and guest lists. Requests run through
 * `contractApp` against the in-memory client; every success is checked against openapi/v1.json with
 * `expectContract`. Refusals (422), hidden rows (404) and stale If-Match (412) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(10000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const PACKET = id(2);
const DRAFT = id(3);
const SECTION = id(4);
const RECIPIENT = id(5);
const PERSON = id(6);
const ANSWER = id(7);
const PROMOTION = id(8);
const RECORD = id(9);
const RIDER = id(10);
const LINE = id(11);
const GUEST = id(12);
const SHOW = id(13);
const TOKEN = id(14);
const SENT = "2026-10-01T12:00:00.000Z";
const STALE = 'W/"MjAyMC0wMS0wMQ"';

function world() {
  const db: MemoryDb = memoryDb(
    {
      advance_packets: [
        tenantRow(PACKET, ORG, {
          project_id: PROJECT,
          title: "Headliner Advance",
          due_at: "2026-10-20T12:00:00.000Z",
          sent_at: SENT,
        }),
        tenantRow(DRAFT, ORG, {
          project_id: PROJECT,
          title: "Vendor Advance",
          due_at: null,
          sent_at: null,
        }),
      ],
      advance_sections: [
        tenantRow(SECTION, ORG, {
          advance_packet_id: PACKET,
          position: 1,
          title: "Arrival",
          prompt: "When does the party arrive?",
          section_kind: "Text",
          window_kind: null,
          max_lines: null,
          per_person: false,
        }),
      ],
      advance_recipients: [
        tenantRow(RECIPIENT, ORG, {
          advance_packet_id: PACKET,
          person_id: PERSON,
          counterparty_id: null,
          engagement_id: null,
          names_due_at: null,
        }),
      ],
      advance_submissions: [
        tenantRow(ANSWER, ORG, {
          advance_section_id: SECTION,
          advance_recipient_id: RECIPIENT,
          body: "Party of 8 lands at 14:20.",
          submitted_at: SENT,
          reviewed_at: null,
          reviewed_by: null,
          review_outcome: null,
          return_reason: null,
          advance_recipient_token_id: TOKEN,
        }),
      ],
      advance_promotions: [
        { ...tenantRow(PROMOTION, ORG, { advance_submission_id: ANSWER, record_id: RECORD }) },
      ],
      riders: [
        tenantRow(RIDER, ORG, {
          project_id: PROJECT,
          counterparty_id: null,
          title: "Technical Rider",
        }),
      ],
      rider_lines: [
        tenantRow(LINE, ORG, {
          rider_id: RIDER,
          description: "Two wedge monitors",
          element_id: null,
          quantity: 2,
          fulfilled_at: null,
        }),
      ],
      guest_list_entries: [
        tenantRow(GUEST, ORG, {
          project_id: PROJECT,
          scope_node_id: SHOW,
          person_id: null,
          counterparty_id: null,
          engagement_id: null,
          guest_name: "Jordan Pike",
          plus_ones: 1,
          note: null,
          entry_state: "Requested",
          decided_at: null,
          decided_by: null,
          checked_in_at: null,
          checked_in_by: null,
        }),
      ],
    },
    {
      send_advance_packet: (args, self) => {
        const p = self.tables["advance_packets"]?.find(
          (x) => x["id"] === args["p_packet_id"],
        ) as Row;
        if (p["sent_at"] !== null)
          throw refusal("advance_packet_sent", "This packet was already sent.");
        p["sent_at"] = "2026-10-14T12:00:00.000Z";
        return p["sent_at"];
      },
    },
    {
      advance_packets: { sent_at: null, due_at: null },
      advance_sections: {
        prompt: null,
        section_kind: "Text",
        window_kind: null,
        max_lines: null,
        per_person: false,
      },
      advance_recipients: {
        person_id: null,
        counterparty_id: null,
        engagement_id: null,
        names_due_at: null,
      },
      advance_submissions: {
        submitted_at: SENT,
        reviewed_at: null,
        reviewed_by: null,
        review_outcome: null,
        return_reason: null,
        advance_recipient_token_id: null,
      },
      riders: { counterparty_id: null },
      rider_lines: { element_id: null, quantity: null, fulfilled_at: null },
      guest_list_entries: {
        scope_node_id: null,
        person_id: null,
        counterparty_id: null,
        engagement_id: null,
        plus_ones: 0,
        note: null,
        entry_state: "Requested",
        decided_at: null,
        decided_by: null,
        checked_in_at: null,
        checked_in_by: null,
      },
    },
  );
  const app = contractApp({ handlers: [advancing], db });
  return { db, http: requests(app) };
}

/** The table operations of one resource as successes, plus the stale and missing checks. */
async function exercise(path: string, existing: string, create: Row, update: Row | null) {
  const { http } = world();
  const list = await success(http.get(path));
  const get = await success(http.get(`${path}/${existing}`));
  const created = await success(http.post(path, create));
  let updated: Response | null = null;
  if (update !== null) {
    updated = await success(http.patch(`${path}/${existing}`, update));
    expect((await http.patch(`${path}/${existing}`, update, STALE)).status).toBe(412);
  }
  const removed = await success(http.delete(`${path}/${existing}`));
  expect((await http.get(`${path}/${existing}`)).status).toBe(404);
  return { list, get, created, updated, removed };
}

describe("Advancing contract: packets", () => {
  it("lists, reads, creates, edits, sends and archives packets", async () => {
    const r = await exercise(
      "/advance-packets",
      DRAFT,
      { project_id: PROJECT, title: "Staging Vendor Advance" },
      { title: "Staging Vendor Advance v2", due_at: "2026-11-01T12:00:00Z" },
    );
    const page = (await expectContract(r.list, "advancePackets.list")) as { data: Row[] };
    expect(page.data).toHaveLength(2);
    expect(page.data[0]).not.toHaveProperty("advance_state");
    await expectContract(r.get, "advancePackets.get");
    const made = (await expectContract(r.created, "advancePackets.create")) as Row;
    expect(made["due_at"]).toBeNull();
    await expectContract(r.updated as Response, "advancePackets.update");
    await expectContract(r.removed, "advancePackets.delete");
  });

  it("sends a draft once and refuses a second send", async () => {
    const { http, db } = world();
    const sent = await success(http.post(`/advance-packets/${DRAFT}/send`));
    const packet = (await expectContract(sent, "advancePackets.send")) as Row;
    expect(packet["sent_at"]).toBe("2026-10-14T12:00:00.000Z");
    expect(db.calls.map((c) => c.name)).toContain("send_advance_packet");
    const again = await http.post(`/advance-packets/${PACKET}/send`);
    expect(again.status).toBe(422);
    expect(((await again.json()) as Row)["rule"]).toBe("advance_packet_sent");
    expect((await http.post(`/advance-packets/${id(99)}/send`)).status).toBe(404);
  });
});

describe("Advancing contract: sections, recipients and promotions", () => {
  it("serves sections", async () => {
    const r = await exercise(
      "/advance-sections",
      SECTION,
      { advance_packet_id: DRAFT, position: 1, title: "Power", prompt: null },
      { prompt: "Total load at the stage." },
    );
    await expectContract(r.list, "advanceSections.list");
    await expectContract(r.get, "advanceSections.get");
    await expectContract(r.created, "advanceSections.create");
    await expectContract(r.updated as Response, "advanceSections.update");
    await expectContract(r.removed, "advanceSections.delete");
  });

  it("serves recipients", async () => {
    const r = await exercise(
      "/advance-recipients",
      RECIPIENT,
      { advance_packet_id: DRAFT, counterparty_id: id(20) },
      null,
    );
    await expectContract(r.list, "advanceRecipients.list");
    await expectContract(r.get, "advanceRecipients.get");
    const made = (await expectContract(r.created, "advanceRecipients.create")) as Row;
    expect(made["counterparty_id"]).toBe(id(20));
    await expectContract(r.removed, "advanceRecipients.delete");
  });

  it("serves promotions", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/advance-promotions")), "advancePromotions.list");
    await expectContract(
      await success(http.get(`/advance-promotions/${PROMOTION}`)),
      "advancePromotions.get",
    );
    const made = await success(
      http.post("/advance-promotions", { advance_submission_id: ANSWER, record_id: id(21) }),
    );
    expect(((await expectContract(made, "advancePromotions.create")) as Row)["record_id"]).toBe(
      id(21),
    );
  });
});

describe("Advancing contract: answers and review", () => {
  it("lists, reads and records answers", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/advance-submissions")),
      "advanceSubmissions.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["via_link"]).toBe(true);
    const one = (await expectContract(
      await success(http.get(`/advance-submissions/${ANSWER}`)),
      "advanceSubmissions.get",
    )) as Row;
    expect(one["review_outcome"]).toBeNull();
    const made = await success(
      http.post("/advance-submissions", {
        advance_section_id: SECTION,
        advance_recipient_id: RECIPIENT,
        body: "Drum riser 8 ft x 8 ft, by phone.",
      }),
    );
    const recorded = (await expectContract(made, "advanceSubmissions.create")) as Row;
    expect(recorded["via_link"]).toBe(false);
  });

  it("reviews once, returning with a reason", async () => {
    const { http } = world();
    const returned = await success(
      http.post(`/advance-submissions/${ANSWER}/review`, {
        outcome: "Returned",
        return_reason: "Please add the flight number.",
      }),
    );
    const answer = (await expectContract(returned, "advanceSubmissions.review")) as Row;
    expect(answer["review_outcome"]).toBe("Returned");
    expect(answer["return_reason"]).toBe("Please add the flight number.");
    const again = await http.post(`/advance-submissions/${ANSWER}/review`, { outcome: "Accepted" });
    expect(again.status).toBe(422);
    expect(((await again.json()) as Row)["rule"]).toBe("advance_submission_reviewed");
    expect(
      (await http.post(`/advance-submissions/${ANSWER}/review`, { outcome: "Returned" })).status,
    ).toBe(422);
    expect(
      (await http.post(`/advance-submissions/${id(98)}/review`, { outcome: "Accepted" })).status,
    ).toBe(404);
  });
});

describe("Advancing contract: riders and lines", () => {
  it("serves riders", async () => {
    const r = await exercise(
      "/riders",
      RIDER,
      { project_id: PROJECT, title: "Hospitality Rider" },
      { title: "Technical Rider 2027", counterparty_id: id(20) },
    );
    await expectContract(r.list, "riders.list");
    await expectContract(r.get, "riders.get");
    await expectContract(r.created, "riders.create");
    await expectContract(r.updated as Response, "riders.update");
    await expectContract(r.removed, "riders.delete");
  });

  it("serves rider lines and keeps a blank quantity blank", async () => {
    const r = await exercise(
      "/rider-lines",
      LINE,
      { rider_id: RIDER, description: "Towels", quantity: null },
      { fulfilled_at: "2026-10-14T12:00:00Z" },
    );
    await expectContract(r.list, "riderLines.list");
    await expectContract(r.get, "riderLines.get");
    const made = (await expectContract(r.created, "riderLines.create")) as Row;
    expect(made["quantity"]).toBeNull();
    const done = (await expectContract(r.updated as Response, "riderLines.update")) as Row;
    expect(done["fulfilled_at"]).not.toBeNull();
    await expectContract(r.removed, "riderLines.delete");
  });
});

describe("Advancing contract: guest list", () => {
  it("serves guest list entries", async () => {
    const r = await exercise(
      "/guest-list-entries",
      GUEST,
      { project_id: PROJECT, guest_name: "Morgan Lee", plus_ones: 0 },
      { plus_ones: 2, note: "Press." },
    );
    await expectContract(r.list, "guestListEntries.list");
    await expectContract(r.get, "guestListEntries.get");
    const made = (await expectContract(r.created, "guestListEntries.create")) as Row;
    expect(made["entry_state"]).toBe("Requested");
    await expectContract(r.updated as Response, "guestListEntries.update");
    await expectContract(r.removed, "guestListEntries.delete");
  });

  it("decides and checks in, refusing out-of-order moves", async () => {
    const { http } = world();
    expect((await http.post(`/guest-list-entries/${GUEST}/check-in`)).status).toBe(422);
    const approved = await success(
      http.post(`/guest-list-entries/${GUEST}/decide`, { outcome: "Approved" }),
    );
    expect(
      ((await expectContract(approved, "guestListEntries.decide")) as Row)["entry_state"],
    ).toBe("Approved");
    const inside = await success(http.post(`/guest-list-entries/${GUEST}/check-in`));
    expect(((await expectContract(inside, "guestListEntries.checkIn")) as Row)["entry_state"]).toBe(
      "Checked In",
    );
  });
});
