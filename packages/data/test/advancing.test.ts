import { describe, expect, it } from "vitest";
import {
  addGuest,
  addRecipient,
  addRiderLine,
  addSection,
  archivePacket,
  archiveRider,
  checkInGuest,
  confirmRiderLineProposals,
  createPacket,
  createRider,
  decideGuest,
  getAdvancingProject,
  getPacket,
  getReconciliation,
  getRider,
  issueAdvanceLink,
  linkStatus,
  listAdvanceLinks,
  listAdvanceParties,
  listAdvancingProjects,
  listCapabilityStatements,
  listGuests,
  listPackets,
  listProjectScopes,
  listReconciliations,
  listRiders,
  listSubmissions,
  moveSection,
  packetProgress,
  packetState,
  recordSubmission,
  removeGuest,
  removeRecipient,
  removeRiderLine,
  removeSection,
  revokeAdvanceLink,
  reviewSubmission,
  runReconciliation,
  sendPacket,
  setRiderLineFulfilled,
  updateGuest,
  updatePacket,
  updateRider,
  updateRiderLine,
  updateSection,
} from "../src/advancing.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const down = () => errorResponse("08006", "connection lost");
const denied = () => errorResponse("42501", "denied");

const packetRow = {
  id: "pk1",
  project_id: "pr1",
  title: "Headliner Advance",
  due_at: "2026-10-20T12:00:00.000Z",
  sent_at: "2026-10-01T12:00:00.000Z",
  created_at: "2026-09-30T12:00:00.000Z",
};

const submission = (over: Record<string, unknown>) => ({
  id: "s1",
  advance_section_id: "sec1",
  advance_recipient_id: "r1",
  body: "Party of 8.",
  submitted_at: "2026-10-02T12:00:00.000Z",
  reviewed_at: null,
  reviewed_by: null,
  review_outcome: null,
  return_reason: null,
  advance_recipient_token_id: null,
  ...over,
});

describe("projects and parties", () => {
  it("lists projects in key order", async () => {
    const { db, calls } = fakeClient({
      "from:projects": [okResponse([{ id: "pr1", project_key: "NWL", name: "Summer" }])],
    });
    expect(await listAdvancingProjects(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "pr1", key: "NWL", name: "Summer" }],
    });
    expect(calls[0]?.steps).toContainEqual(["order", ["project_key"]]);
  });

  it("surfaces project read failures", async () => {
    const { db } = fakeClient({ "from:projects": [down(), down()] });
    expect((await listAdvancingProjects(db, "o1")).ok).toBe(false);
    expect((await getAdvancingProject(db, "o1", "NWL")).ok).toBe(false);
  });

  it("finds one project by key or answers not found", async () => {
    const { db } = fakeClient({
      "from:projects": [
        okResponse({ id: "pr1", project_key: "NWL", name: "Summer" }),
        okResponse(null),
      ],
    });
    expect((await getAdvancingProject(db, "o1", "NWL")).ok).toBe(true);
    expect(await getAdvancingProject(db, "o1", "ZZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("lists people first, then counterparties, each by name", async () => {
    const { db } = fakeClient({
      "from:people": [
        okResponse([
          { id: "p2", full_name: "Zed" },
          { id: "p1", full_name: "Ana" },
        ]),
      ],
      "from:counterparties": [
        okResponse([{ id: "c1", counterparty_type: "Vendor", counterparty_name: null }]),
      ],
    });
    const result = await listAdvanceParties(db, "o1");
    expect(result.ok && result.data.map((p) => p.id)).toEqual(["p1", "p2", "c1"]);
    expect(result.ok && result.data[2]).toEqual({
      kind: "counterparty",
      id: "c1",
      name: null,
      counterpartyType: "Vendor",
    });
  });

  it("surfaces party read failures", async () => {
    const people = fakeClient({ "from:people": [down()], "from:counterparties": [okResponse([])] });
    expect((await listAdvanceParties(people.db, "o1")).ok).toBe(false);
    const cps = fakeClient({ "from:people": [okResponse([])], "from:counterparties": [down()] });
    expect((await listAdvanceParties(cps.db, "o1")).ok).toBe(false);
  });
});

describe("packet state", () => {
  const facts = (outcome: "Accepted" | "Returned" | null, at = "2026-10-02") => ({
    sectionId: "sec1",
    recipientId: "r1",
    submittedAt: at,
    reviewOutcome: outcome,
  });

  it("counts the latest answer per pair", () => {
    expect(
      packetProgress(["sec1"], ["r1"], [facts(null, "2026-10-01"), facts("Accepted")]),
    ).toEqual({ expected: 1, answered: 1, reviewed: 1 });
  });

  it("treats a returned answer as open", () => {
    expect(packetProgress(["sec1"], ["r1"], [facts("Returned")])).toEqual({
      expected: 1,
      answered: 0,
      reviewed: 0,
    });
  });

  it("ignores answers to removed sections or recipients", () => {
    expect(packetProgress(["sec2"], ["r1"], [facts("Accepted")]).answered).toBe(0);
  });

  it("derives every state", () => {
    const due = "2026-10-10T00:00:00.000Z";
    const open = { expected: 2, answered: 1, reviewed: 0 };
    expect(packetState({ sentAt: null, dueAt: null }, open, NOW)).toBe("Draft");
    expect(packetState({ sentAt: due, dueAt: null }, open, NOW)).toBe("Awaiting");
    expect(packetState({ sentAt: due, dueAt: "2026-12-01T00:00:00.000Z" }, open, NOW)).toBe(
      "Awaiting",
    );
    expect(packetState({ sentAt: due, dueAt: due }, open, NOW)).toBe("Overdue");
    expect(packetState({ sentAt: due, dueAt: due }, { ...open, answered: 2 }, NOW)).toBe(
      "InReview",
    );
    expect(
      packetState({ sentAt: due, dueAt: due }, { expected: 2, answered: 2, reviewed: 2 }, NOW),
    ).toBe("Complete");
    expect(
      packetState({ sentAt: due, dueAt: null }, { expected: 0, answered: 0, reviewed: 0 }, NOW),
    ).toBe("Awaiting");
  });
});

describe("packets", () => {
  it("lists packets with derived progress", async () => {
    const { db, calls } = fakeClient({
      "from:advance_packets": [okResponse([packetRow, { ...packetRow, id: "pk2", sent_at: null }])],
      "from:advance_sections": [okResponse([{ id: "sec1", advance_packet_id: "pk1" }])],
      "from:advance_recipients": [okResponse([{ id: "r1", advance_packet_id: "pk1" }])],
      "from:advance_submissions": [okResponse([submission({ review_outcome: "Accepted" })])],
    });
    const result = await listPackets(db, { orgId: "o1", projectId: "pr1" }, NOW);
    expect(result.ok && result.data.map((p) => p.state)).toEqual(["Complete", "Draft"]);
    expect(result.ok && result.data[1]?.sectionCount).toBe(0);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "pr1"]]);
  });

  it("returns no packets without further reads", async () => {
    const { db, calls } = fakeClient({ "from:advance_packets": [okResponse([])] });
    expect(await listPackets(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(1);
  });

  it("lists packets that have no sections", async () => {
    const { db } = fakeClient({
      "from:advance_packets": [okResponse([{ ...packetRow, sent_at: null }])],
      "from:advance_sections": [okResponse([])],
      "from:advance_recipients": [okResponse([])],
    });
    const result = await listPackets(db, { orgId: "o1" }, NOW);
    expect(result.ok && result.data[0]?.progress).toEqual({
      expected: 0,
      answered: 0,
      reviewed: 0,
    });
  });

  it("surfaces packet list failures at each read", async () => {
    for (const failing of ["packets", "sections", "recipients", "submissions"] as const) {
      const { db } = fakeClient({
        "from:advance_packets": [failing === "packets" ? down() : okResponse([packetRow])],
        "from:advance_sections": [
          failing === "sections" ? down() : okResponse([{ id: "sec1", advance_packet_id: "pk1" }]),
        ],
        "from:advance_recipients": [
          failing === "recipients" ? down() : okResponse([{ id: "r1", advance_packet_id: "pk1" }]),
        ],
        "from:advance_submissions": [failing === "submissions" ? down() : okResponse([])],
      });
      expect((await listPackets(db, { orgId: "o1" })).ok, failing).toBe(false);
    }
  });

  it("reads a packet with sections, named recipients and answers", async () => {
    const { db } = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [
        okResponse([
          { id: "sec2", position: 2, title: "Backline", prompt: null },
          { id: "sec1", position: 1, title: "Arrival", prompt: "When?" },
        ]),
      ],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [
        okResponse([
          { id: "r1", person_id: "p1", counterparty_id: null },
          { id: "r2", person_id: null, counterparty_id: "c1" },
        ]),
      ],
      "from:people": [okResponse([{ id: "p1", full_name: "Mia" }])],
      "from:counterparties": [okResponse([{ id: "c1", counterparty_name: "Harbor Audio" }])],
      "from:advance_submissions": [
        okResponse([
          submission({ id: "s2", submitted_at: "2026-10-03", advance_recipient_token_id: "t1" }),
          submission({ id: "s1", review_outcome: "Returned", return_reason: "Add flights." }),
        ]),
      ],
    });
    const result = await getPacket(db, "pk1", NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sections.map((s) => s.title)).toEqual(["Arrival", "Backline"]);
    expect(result.data.recipients.map((r) => r.party.name)).toEqual(["Mia", "Harbor Audio"]);
    expect(result.data.submissions.map((s) => [s.id, s.latest, s.viaLink])).toEqual([
      ["s2", true, true],
      ["s1", false, false],
    ]);
    expect(result.data.state).toBe("Awaiting");
  });

  it("answers not found for a missing packet and surfaces failures", async () => {
    const missing = fakeClient({ "from:advance_packets": [okResponse(null)] });
    expect(await getPacket(missing.db, "pk1")).toEqual({ ok: false, error: { kind: "not-found" } });
    const failing = fakeClient({ "from:advance_packets": [down()] });
    expect((await getPacket(failing.db, "pk1")).ok).toBe(false);
    const sections = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [down()],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [okResponse([])],
    });
    expect((await getPacket(sections.db, "pk1")).ok).toBe(false);
    const recipients = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [okResponse([])],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [down()],
    });
    expect((await getPacket(recipients.db, "pk1")).ok).toBe(false);
    const names = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [okResponse([])],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [
        okResponse([{ id: "r1", person_id: "p1", counterparty_id: null }]),
      ],
      "from:people": [down()],
    });
    expect((await getPacket(names.db, "pk1")).ok).toBe(false);
    const cpNames = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [okResponse([])],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [
        okResponse([{ id: "r1", person_id: null, counterparty_id: "c1" }]),
      ],
      "from:counterparties": [down()],
    });
    expect((await getPacket(cpNames.db, "pk1")).ok).toBe(false);
    const answers = fakeClient({
      "from:advance_packets": [okResponse(packetRow)],
      "from:advance_sections": [
        okResponse([{ id: "sec1", position: 1, title: "A", prompt: null }]),
      ],
      "from:advance_section_choices": [okResponse([])],
      "from:advance_recipients": [okResponse([])],
      "from:advance_submissions": [down()],
    });
    expect((await getPacket(answers.db, "pk1")).ok).toBe(false);
  });

  it("creates, updates and archives packets", async () => {
    const { db, calls } = fakeClient({
      "from:advance_packets": [
        okResponse({ id: "pk1" }),
        okResponse([{ id: "pk1" }]),
        okResponse([]),
        okResponse([{ id: "pk1" }]),
        okResponse([]),
      ],
    });
    expect(
      await createPacket(db, { orgId: "o1", projectId: "pr1", title: "  Advance  ", dueAt: null }),
    ).toEqual({ ok: true, data: { id: "pk1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", project_id: "pr1", title: "Advance", due_at: null }],
    ]);
    expect((await updatePacket(db, "pk1", { title: "New", dueAt: null })).ok).toBe(true);
    expect(await updatePacket(db, "pk1", { title: "New", dueAt: null })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await archivePacket(db, "pk1", NOW)).ok).toBe(true);
    expect((await archivePacket(db, "pk1", NOW)).ok).toBe(false);
  });

  it("refuses blank titles before writing", async () => {
    const { db, calls } = fakeClient({});
    const invalid = { ok: false, error: { kind: "invalid", message: "title" } };
    expect(
      await createPacket(db, { orgId: "o1", projectId: "p", title: " ", dueAt: null }),
    ).toEqual(invalid);
    expect(await updatePacket(db, "pk1", { title: "", dueAt: null })).toEqual(invalid);
    expect(await addSection(db, { orgId: "o1", packetId: "pk1", title: "", prompt: null })).toEqual(
      invalid,
    );
    expect(await updateSection(db, "s", { title: "x".repeat(201), prompt: null })).toEqual(invalid);
    expect(
      await createRider(db, {
        orgId: "o1",
        projectId: "p",
        title: "",
        counterpartyId: null,
        engagementId: null,
      }),
    ).toEqual(invalid);
    expect(
      await updateRider(db, "r", { title: "", counterpartyId: null, engagementId: null }),
    ).toEqual(invalid);
    expect(calls).toHaveLength(0);
  });

  it("surfaces write failures", async () => {
    const { db } = fakeClient({ "from:advance_packets": [denied(), down(), down()] });
    expect(
      await createPacket(db, { orgId: "o1", projectId: "pr1", title: "A", dueAt: null }),
    ).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updatePacket(db, "pk1", { title: "A", dueAt: null })).ok).toBe(false);
    expect((await archivePacket(db, "pk1")).ok).toBe(false);
  });

  it("sends through the RPC and passes refusals on", async () => {
    const { db, calls } = fakeClient({
      "rpc:send_advance_packet": [
        okResponse("2026-10-14T12:00:00.000Z"),
        errorResponse(
          "XR001",
          "advance_packet_no_sections: Add a section before sending.",
          "advance_packet_no_sections",
        ),
      ],
    });
    expect(await sendPacket(db, "pk1")).toEqual({
      ok: true,
      data: { sentAt: "2026-10-14T12:00:00.000Z" },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_packet_id: "pk1" }]]);
    expect(await sendPacket(db, "pk1")).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "advance_packet_no_sections",
        message: "Add a section before sending.",
      },
    });
  });
});

describe("sections and recipients", () => {
  it("appends a section after the last position", async () => {
    const { db, calls } = fakeClient({
      "from:advance_sections": [okResponse([{ position: 3 }]), okResponse({ id: "sec4" })],
    });
    expect(
      await addSection(db, { orgId: "o1", packetId: "pk1", title: "Hospitality", prompt: "  " }),
    ).toEqual({ ok: true, data: { id: "sec4" } });
    expect(calls[1]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "o1",
          advance_packet_id: "pk1",
          position: 4,
          title: "Hospitality",
          prompt: null,
          section_kind: "Text",
          window_kind: null,
          max_lines: null,
          per_person: false,
        },
      ],
    ]);
  });

  it("starts at position 1 and surfaces failures", async () => {
    const { db, calls } = fakeClient({
      "from:advance_sections": [
        okResponse([]),
        okResponse({ id: "sec1" }),
        down(),
        okResponse([]),
        down(),
      ],
    });
    expect((await addSection(db, { orgId: "o", packetId: "p", title: "A", prompt: "Q" })).ok).toBe(
      true,
    );
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        org_id: "o",
        advance_packet_id: "p",
        position: 1,
        title: "A",
        prompt: "Q",
        section_kind: "Text",
        window_kind: null,
        max_lines: null,
        per_person: false,
      },
    ]);
    expect((await addSection(db, { orgId: "o", packetId: "p", title: "A", prompt: null })).ok).toBe(
      false,
    );
    expect((await addSection(db, { orgId: "o", packetId: "p", title: "A", prompt: null })).ok).toBe(
      false,
    );
  });

  it("updates and removes sections", async () => {
    const { db } = fakeClient({
      "from:advance_sections": [
        okResponse([{ id: "s" }]),
        okResponse([]),
        down(),
        okResponse([{ id: "s" }]),
        okResponse([]),
        down(),
      ],
    });
    expect((await updateSection(db, "s", { title: "A", prompt: " Q " })).ok).toBe(true);
    expect((await updateSection(db, "s", { title: "A", prompt: null })).ok).toBe(false);
    expect((await updateSection(db, "s", { title: "A", prompt: null })).ok).toBe(false);
    expect((await removeSection(db, "s", NOW)).ok).toBe(true);
    expect((await removeSection(db, "s", NOW)).ok).toBe(false);
    expect((await removeSection(db, "s", NOW)).ok).toBe(false);
  });

  it("swaps a section with its neighbour through a parked position", async () => {
    const rows = [
      { id: "a", position: 1 },
      { id: "b", position: 2 },
      { id: "c", position: 3 },
    ];
    const { db, calls } = fakeClient({
      "from:advance_sections": [
        okResponse(rows),
        okResponse(null),
        okResponse(null),
        okResponse(null),
      ],
    });
    expect(await moveSection(db, { packetId: "pk", sectionId: "b", direction: "up" })).toEqual({
      ok: true,
      data: null,
    });
    expect(calls.slice(1).map((c) => [c.steps[0]?.[1], c.steps[1]?.[1]])).toEqual([
      [[{ position: 4 }], ["id", "b"]],
      [[{ position: 2 }], ["id", "a"]],
      [[{ position: 1 }], ["id", "b"]],
    ]);
  });

  it("leaves the edges alone and reports missing sections and failures", async () => {
    const rows = [{ id: "a", position: 1 }];
    const { db } = fakeClient({
      "from:advance_sections": [
        okResponse(rows),
        okResponse(rows),
        down(),
        okResponse([
          { id: "a", position: 1 },
          { id: "b", position: 2 },
        ]),
        down(),
      ],
    });
    expect((await moveSection(db, { packetId: "p", sectionId: "a", direction: "up" })).ok).toBe(
      true,
    );
    expect(await moveSection(db, { packetId: "p", sectionId: "z", direction: "down" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await moveSection(db, { packetId: "p", sectionId: "a", direction: "down" })).ok).toBe(
      false,
    );
    expect((await moveSection(db, { packetId: "p", sectionId: "a", direction: "down" })).ok).toBe(
      false,
    );
  });

  it("adds a party once", async () => {
    const { db, calls } = fakeClient({
      "from:advance_recipients": [
        okResponse([]),
        okResponse({ id: "r1" }),
        okResponse([{ id: "r1" }]),
        down(),
        okResponse([]),
        down(),
      ],
    });
    const input = {
      orgId: "o1",
      packetId: "pk1",
      party: { kind: "counterparty", id: "c1" },
    } as const;
    expect(await addRecipient(db, input)).toEqual({ ok: true, data: { id: "r1" } });
    expect(calls[1]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "o1",
          advance_packet_id: "pk1",
          person_id: null,
          counterparty_id: "c1",
          engagement_id: null,
          names_due_at: null,
        },
      ],
    ]);
    const again = await addRecipient(db, { ...input, party: { kind: "person", id: "p1" } });
    expect(!again.ok && again.error.kind === "refusal" && again.error.rule).toBe(
      "advance_recipient_duplicate",
    );
    expect((await addRecipient(db, input)).ok).toBe(false);
    expect((await addRecipient(db, input)).ok).toBe(false);
  });

  it("removes recipients", async () => {
    const { db } = fakeClient({
      "from:advance_recipients": [okResponse([{ id: "r1" }]), okResponse([]), down()],
    });
    expect((await removeRecipient(db, "r1", NOW)).ok).toBe(true);
    expect((await removeRecipient(db, "r1", NOW)).ok).toBe(false);
    expect((await removeRecipient(db, "r1", NOW)).ok).toBe(false);
  });
});

describe("advance links", () => {
  const link = {
    id: "t1",
    recipientId: "r1",
    recipientEmail: "mia@example.com",
    expiresAt: "2026-11-01T00:00:00.000Z",
    usedAt: null,
    revokedAt: null,
    locked: false,
    claimedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };

  it("derives each link status", () => {
    expect(linkStatus(link, NOW)).toBe("Live");
    expect(linkStatus({ ...link, usedAt: "2026-10-02" }, NOW)).toBe("Used");
    expect(linkStatus({ ...link, expiresAt: "2026-10-01" }, NOW)).toBe("Expired");
    expect(linkStatus({ ...link, locked: true }, NOW)).toBe("Locked");
    expect(linkStatus({ ...link, revokedAt: "2026-10-03" }, NOW)).toBe("Revoked");
    expect(linkStatus(link)).toBeTypeOf("string");
  });

  it("lists links without their secrets", async () => {
    const { db, calls } = fakeClient({
      "from:advance_recipient_tokens": [
        okResponse([
          {
            id: "t1",
            advance_recipient_id: "r1",
            recipient_email: "mia@example.com",
            expires_at: "2026-11-01T00:00:00.000Z",
            used_at: null,
            revoked_at: null,
            failed_attempts: 5,
            claimed_at: null,
            created_at: "2026-10-01T00:00:00.000Z",
          },
        ]),
        down(),
      ],
    });
    const result = await listAdvanceLinks(db, ["r1"]);
    expect(result.ok && result.data[0]?.locked).toBe(true);
    expect(String(calls[0]?.steps[0]?.[1])).not.toContain("hash");
    expect((await listAdvanceLinks(db, ["r1"])).ok).toBe(false);
    expect(await listAdvanceLinks(db, [])).toEqual({ ok: true, data: [] });
  });

  it("issues a link once and shows the token and code", async () => {
    const { db, calls } = fakeClient({
      "rpc:issue_advance_token": [
        okResponse([
          { token_id: "t1", token: "xadv_ab", access_code: "123456", expires_at: "2026-11-13" },
        ]),
        okResponse([]),
        errorResponse(
          "XR001",
          "advance_packet_unsent: Send the packet before issuing links.",
          "advance_packet_unsent",
        ),
      ],
    });
    const input = { recipientId: "r1", email: " mia@example.com ", validDays: 30 };
    expect(await issueAdvanceLink(db, input)).toEqual({
      ok: true,
      data: { id: "t1", token: "xadv_ab", accessCode: "123456", expiresAt: "2026-11-13" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_recipient_id: "r1", p_recipient_email: "mia@example.com", p_valid_for: "30 days" }],
    ]);
    expect((await issueAdvanceLink(db, input)).ok).toBe(false);
    const refused = await issueAdvanceLink(db, input);
    expect(!refused.ok && refused.error.kind).toBe("refusal");
    expect(await issueAdvanceLink(db, { ...input, validDays: 91 })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "validDays" },
    });
  });

  it("revokes a link", async () => {
    const { db } = fakeClient({ "rpc:revoke_advance_token": [okResponse(null), denied()] });
    expect(await revokeAdvanceLink(db, "t1")).toEqual({ ok: true, data: null });
    expect(await revokeAdvanceLink(db, "t1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

describe("submissions", () => {
  const world = () => ({
    "from:advance_packets": [okResponse([{ id: "pk1", project_id: "pr1", title: "Advance" }])],
    "from:advance_sections": [
      okResponse([{ id: "sec1", advance_packet_id: "pk1", title: "Arrival", prompt: null }]),
    ],
    "from:advance_recipients": [okResponse([{ id: "r1", person_id: "p1", counterparty_id: null }])],
    "from:people": [okResponse([{ id: "p1", full_name: "Mia" }])],
    "from:advance_submissions": [
      okResponse([
        submission({ id: "new", submitted_at: "2026-10-05" }),
        submission({ id: "old", review_outcome: "Returned", reviewed_at: "2026-10-03" }),
        submission({ id: "orphan", advance_recipient_id: "gone" }),
      ]),
    ],
  });

  it("lists every answer with its packet, section and recipient", async () => {
    const { db } = fakeClient(world());
    const result = await listSubmissions(db, { orgId: "o1", projectId: "pr1" });
    expect(result.ok && result.data.map((s) => s.id)).toEqual(["new", "old"]);
    expect(result.ok && result.data[0]?.recipient.name).toBe("Mia");
    expect(result.ok && result.data[0]?.sectionTitle).toBe("Arrival");
  });

  it("filters to the queue of unreviewed latest answers, or to reviewed ones", async () => {
    const queue = await listSubmissions(fakeClient(world()).db, {
      orgId: "o1",
      review: "unreviewed",
    });
    expect(queue.ok && queue.data.map((s) => s.id)).toEqual(["new"]);
    const done = await listSubmissions(fakeClient(world()).db, { orgId: "o1", review: "reviewed" });
    expect(done.ok && done.data.map((s) => s.id)).toEqual(["old"]);
  });

  it("returns nothing for an org without packets or sections", async () => {
    const none = fakeClient({ "from:advance_packets": [okResponse([])] });
    expect(await listSubmissions(none.db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    const empty = fakeClient({
      "from:advance_packets": [okResponse([{ id: "pk1", project_id: "pr1", title: "A" }])],
      "from:advance_sections": [okResponse([])],
      "from:advance_recipients": [okResponse([])],
    });
    expect(await listSubmissions(empty.db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });

  it("surfaces failures at each read", async () => {
    for (const key of [
      "from:advance_packets",
      "from:advance_sections",
      "from:advance_recipients",
      "from:advance_submissions",
      "from:people",
    ] as const) {
      const queues: Record<string, ReturnType<typeof okResponse>[]> = world();
      queues[key] = [down()];
      expect((await listSubmissions(fakeClient(queues).db, { orgId: "o1" })).ok, key).toBe(false);
    }
  });

  it("records an answer only for a sent packet", async () => {
    const { db, calls } = fakeClient({
      "from:advance_sections": [
        okResponse({ id: "sec1", advance_packet_id: "pk1", packet: { sent_at: "2026-10-01" } }),
        okResponse({ id: "sec1", advance_packet_id: "pk1", packet: { sent_at: null } }),
        okResponse(null),
        down(),
        okResponse({ id: "sec1", advance_packet_id: "pk1", packet: { sent_at: "2026-10-01" } }),
      ],
      "from:advance_submissions": [okResponse({ id: "s9" }), down()],
    });
    const input = { orgId: "o1", sectionId: "sec1", recipientId: "r1", body: " By phone. " };
    expect(await recordSubmission(db, input)).toEqual({ ok: true, data: { id: "s9" } });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { org_id: "o1", advance_section_id: "sec1", advance_recipient_id: "r1", body: "By phone." },
    ]);
    const unsent = await recordSubmission(db, input);
    expect(!unsent.ok && unsent.error.kind === "refusal" && unsent.error.rule).toBe(
      "advance_packet_unsent",
    );
    expect(await recordSubmission(db, input)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await recordSubmission(db, input)).ok).toBe(false);
    expect((await recordSubmission(db, input)).ok).toBe(false);
    expect(await recordSubmission(db, { ...input, body: " " })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "body" },
    });
  });

  it("reviews once, with a reason when returning", async () => {
    const { db, calls } = fakeClient({
      "from:advance_submissions": [
        okResponse([{ id: "s1" }]),
        okResponse([]),
        errorResponse(
          "XR001",
          "sod_advance_submitter: The person who submitted an advance answer cannot review it.",
          "sod_advance_submitter",
        ),
      ],
    });
    const input = { submissionId: "s1", reviewerPersonId: "p2" };
    expect(
      await reviewSubmission(
        db,
        { ...input, outcome: "Returned", returnReason: " Add flights. " },
        NOW,
      ),
    ).toEqual({ ok: true, data: { reviewedAt: NOW.toISOString() } });
    expect(calls[0]?.steps[0]).toEqual([
      "update",
      [
        {
          reviewed_at: NOW.toISOString(),
          reviewed_by: "p2",
          review_outcome: "Returned",
          return_reason: "Add flights.",
        },
      ],
    ]);
    const again = await reviewSubmission(db, { ...input, outcome: "Accepted" }, NOW);
    expect(!again.ok && again.error.kind === "refusal" && again.error.rule).toBe(
      "advance_submission_reviewed",
    );
    const own = await reviewSubmission(db, { ...input, outcome: "Accepted" });
    expect(!own.ok && own.error.kind === "refusal" && own.error.rule).toBe("sod_advance_submitter");
    expect(await reviewSubmission(db, { ...input, outcome: "Returned" })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "returnReason" },
    });
  });
});

describe("riders", () => {
  const riderRow = {
    id: "rd1",
    project_id: "pr1",
    title: "Technical Rider",
    counterparty_id: "c1",
    engagement_id: null,
    created_at: "2026-10-01",
  };

  it("lists riders with line counts and party names", async () => {
    const { db } = fakeClient({
      "from:riders": [okResponse([riderRow, { ...riderRow, id: "rd2", counterparty_id: null }])],
      "from:rider_lines": [
        okResponse([
          { rider_id: "rd1", fulfilled_at: null },
          { rider_id: "rd1", fulfilled_at: "2026-10-02" },
        ]),
      ],
      "from:counterparties": [okResponse([{ id: "c1", counterparty_name: "Harbor Audio" }])],
    });
    const result = await listRiders(db, { orgId: "o1", projectId: "pr1" });
    expect(result.ok && result.data[0]).toMatchObject({
      counterpartyName: "Harbor Audio",
      lineCount: 2,
      fulfilledCount: 1,
    });
    expect(result.ok && result.data[1]?.counterpartyName).toBeNull();
  });

  it("returns no riders and surfaces failures", async () => {
    expect(
      await listRiders(fakeClient({ "from:riders": [okResponse([])] }).db, { orgId: "o" }),
    ).toEqual({ ok: true, data: [] });
    expect((await listRiders(fakeClient({ "from:riders": [down()] }).db, { orgId: "o" })).ok).toBe(
      false,
    );
    const lines = fakeClient({
      "from:riders": [okResponse([riderRow])],
      "from:rider_lines": [down()],
    });
    expect((await listRiders(lines.db, { orgId: "o" })).ok).toBe(false);
    const names = fakeClient({
      "from:riders": [okResponse([riderRow])],
      "from:rider_lines": [okResponse([])],
      "from:counterparties": [down()],
    });
    expect((await listRiders(names.db, { orgId: "o" })).ok).toBe(false);
  });

  it("reads a rider with its lines", async () => {
    const { db } = fakeClient({
      "from:riders": [
        okResponse({ ...riderRow, counterparty_id: null }),
        okResponse(null),
        down(),
        okResponse(riderRow),
        okResponse(riderRow),
      ],
      "from:rider_lines": [
        okResponse([
          {
            id: "l1",
            description: "Two wedge monitors",
            element_id: null,
            quantity: 2,
            fulfilled_at: null,
          },
        ]),
        down(),
        okResponse([]),
      ],
      "from:counterparties": [down()],
    });
    const result = await getRider(db, "rd1");
    expect(result.ok && result.data.lines[0]?.quantity).toBe(2);
    expect(result.ok && result.data.counterpartyName).toBeNull();
    expect(await getRider(db, "rd1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getRider(db, "rd1")).ok).toBe(false);
    expect((await getRider(db, "rd1")).ok).toBe(false);
    expect((await getRider(db, "rd1")).ok).toBe(false);
  });

  it("creates, updates and archives riders", async () => {
    const { db } = fakeClient({
      "from:riders": [
        okResponse({ id: "rd1" }),
        down(),
        okResponse([{ id: "rd1" }]),
        okResponse([]),
        down(),
        okResponse([{ id: "rd1" }]),
        okResponse([]),
        down(),
      ],
    });
    const create = {
      orgId: "o1",
      projectId: "pr1",
      title: "Hospitality Rider",
      counterpartyId: null,
      engagementId: null,
    };
    const none = { counterpartyId: null, engagementId: null };
    expect(await createRider(db, create)).toEqual({ ok: true, data: { id: "rd1" } });
    expect((await createRider(db, create)).ok).toBe(false);
    expect(
      (await updateRider(db, "rd1", { title: "A", counterpartyId: "c1", engagementId: null })).ok,
    ).toBe(true);
    expect((await updateRider(db, "rd1", { title: "A", ...none })).ok).toBe(false);
    expect((await updateRider(db, "rd1", { title: "A", ...none })).ok).toBe(false);
    expect((await archiveRider(db, "rd1", NOW)).ok).toBe(true);
    expect((await archiveRider(db, "rd1", NOW)).ok).toBe(false);
    expect((await archiveRider(db, "rd1", NOW)).ok).toBe(false);
  });

  it("creates a rider for an individual artist's engagement and names one party at most", async () => {
    const { db, calls } = fakeClient({
      "from:riders": [okResponse({ id: "rd3" }), okResponse([{ id: "rd3" }])],
    });
    expect(
      await createRider(db, {
        orgId: "o1",
        projectId: "pr1",
        title: " Arturo Bell Technical Rider ",
        counterpartyId: null,
        engagementId: "e1",
      }),
    ).toEqual({ ok: true, data: { id: "rd3" } });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        org_id: "o1",
        project_id: "pr1",
        title: "Arturo Bell Technical Rider",
        counterparty_id: null,
        engagement_id: "e1",
      },
    ]);
    expect(
      (await updateRider(db, "rd3", { title: "A", counterpartyId: null, engagementId: "e1" })).ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { title: "A", counterparty_id: null, engagement_id: "e1" },
    ]);
    const both = { counterpartyId: "c1", engagementId: "e1" };
    const party = { ok: false, error: { kind: "invalid", message: "party" } };
    expect(await createRider(db, { orgId: "o1", projectId: "pr1", title: "A", ...both })).toEqual(
      party,
    );
    expect(await updateRider(db, "rd3", { title: "A", ...both })).toEqual(party);
  });

  it("names the artist of an engagement rider", async () => {
    const { db } = fakeClient({
      "from:riders": [
        okResponse([{ ...riderRow, id: "rd3", counterparty_id: null, engagement_id: "e1" }]),
        okResponse({ ...riderRow, id: "rd3", counterparty_id: null, engagement_id: "e1" }),
      ],
      "from:rider_lines": [okResponse([]), okResponse([])],
      "from:engagements": [
        okResponse([{ id: "e1", person_id: "pe1" }]),
        okResponse([{ id: "e1", person_id: "pe1" }]),
      ],
      "from:people": [
        okResponse([{ id: "pe1", full_name: "Arturo Bell" }]),
        okResponse([{ id: "pe1", full_name: "Arturo Bell" }]),
      ],
    });
    const list = await listRiders(db, { orgId: "o1" });
    expect(list.ok && list.data[0]).toMatchObject({
      counterpartyId: null,
      engagementId: "e1",
      engagementName: "Arturo Bell",
    });
    const one = await getRider(db, "rd3");
    expect(one.ok && one.data.engagementName).toBe("Arturo Bell");
    const down2 = fakeClient({
      "from:riders": [okResponse([{ ...riderRow, counterparty_id: null, engagement_id: "e1" }])],
      "from:rider_lines": [okResponse([])],
      "from:engagements": [down()],
    });
    expect((await listRiders(down2.db, { orgId: "o1" })).ok).toBe(false);
  });

  it("keeps a blank quantity blank and refuses invalid lines", async () => {
    const { db, calls } = fakeClient({
      "from:rider_lines": [okResponse({ id: "l1" }), down()],
    });
    const line = { description: " Towels ", elementId: " ", quantity: null };
    expect(await addRiderLine(db, { orgId: "o1", riderId: "rd1", line })).toEqual({
      ok: true,
      data: { id: "l1" },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { org_id: "o1", rider_id: "rd1", description: "Towels", element_id: null, quantity: null },
    ]);
    expect((await addRiderLine(db, { orgId: "o1", riderId: "rd1", line })).ok).toBe(false);
    const invalid = { ok: false, error: { kind: "invalid", message: "line" } };
    expect(
      await addRiderLine(db, { orgId: "o1", riderId: "rd1", line: { ...line, quantity: -1 } }),
    ).toEqual(invalid);
    expect(
      await addRiderLine(db, { orgId: "o1", riderId: "rd1", line: { ...line, description: "" } }),
    ).toEqual(invalid);
    expect(await updateRiderLine(db, "l1", { ...line, quantity: Number.NaN })).toEqual(invalid);
  });

  it("updates, fulfills, reopens and removes lines", async () => {
    const { db, calls } = fakeClient({
      "from:rider_lines": [
        okResponse([{ id: "l1" }]),
        okResponse([]),
        down(),
        okResponse([{ id: "l1" }]),
        okResponse([{ id: "l1" }]),
        okResponse([]),
        down(),
        okResponse([{ id: "l1" }]),
        okResponse([]),
        down(),
      ],
    });
    const line = { description: "Towels", elementId: "E-1", quantity: 12 };
    expect((await updateRiderLine(db, "l1", line)).ok).toBe(true);
    expect((await updateRiderLine(db, "l1", line)).ok).toBe(false);
    expect((await updateRiderLine(db, "l1", line)).ok).toBe(false);
    expect(await setRiderLineFulfilled(db, "l1", true, NOW)).toEqual({
      ok: true,
      data: { fulfilledAt: NOW.toISOString() },
    });
    expect(await setRiderLineFulfilled(db, "l1", false, NOW)).toEqual({
      ok: true,
      data: { fulfilledAt: null },
    });
    expect(calls[4]?.steps[0]).toEqual(["update", [{ fulfilled_at: null }]]);
    expect((await setRiderLineFulfilled(db, "l1", true)).ok).toBe(false);
    expect((await setRiderLineFulfilled(db, "l1", true)).ok).toBe(false);
    expect((await removeRiderLine(db, "l1", NOW)).ok).toBe(true);
    expect((await removeRiderLine(db, "l1", NOW)).ok).toBe(false);
    expect((await removeRiderLine(db, "l1", NOW)).ok).toBe(false);
  });

  it("stores only confirmed extraction proposals", async () => {
    const { db, calls } = fakeClient({
      "from:rider_lines": [okResponse([{ id: "l1" }, { id: "l2" }]), down()],
    });
    const proposal = {
      description: "Two wedges",
      elementId: null,
      quantity: 2,
      confidence: 0.9,
      source: "p. 2",
    };
    const input = {
      orgId: "o1",
      riderId: "rd1",
      proposals: [proposal, { ...proposal, quantity: null }],
    };
    expect(await confirmRiderLineProposals(db, input)).toEqual({
      ok: true,
      data: { ids: ["l1", "l2"] },
    });
    expect((calls[0]?.steps[0]?.[1] as unknown[][])[0]).toHaveLength(2);
    expect((await confirmRiderLineProposals(db, input)).ok).toBe(false);
    expect(await confirmRiderLineProposals(db, { ...input, proposals: [] })).toEqual({
      ok: true,
      data: { ids: [] },
    });
    expect(
      await confirmRiderLineProposals(db, {
        ...input,
        proposals: [{ ...proposal, description: "" }],
      }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "line" } });
  });
});

describe("reconciliation", () => {
  const statementRow = (over: Record<string, unknown>) => ({
    id: "q1",
    direction: "Require",
    urid: "5000.01.01",
    description: "Stage power",
    quantity: 400,
    unit_basis: null,
    is_critical: true,
    assertion_word: "UNKNOWN",
    venue_id: null,
    counterparty_id: null,
    ...over,
  });

  it("lists statements and surfaces failures", async () => {
    const { db } = fakeClient({
      "from:capability_statements": [okResponse([statementRow({})]), down()],
    });
    const result = await listCapabilityStatements(db, "pr1");
    expect(result.ok && result.data[0]?.isCritical).toBe(true);
    expect((await listCapabilityStatements(db, "pr1")).ok).toBe(false);
  });

  it("runs a reconciliation through app.reconcile_project", async () => {
    const { db, calls } = fakeClient({
      "from:capability_statements": [
        okResponse([statementRow({})]),
        okResponse([statementRow({})]),
      ],
      "rpc:reconcile_project": [okResponse("rc1"), down()],
    });
    expect(await runReconciliation(db, { projectId: "pr1", note: " Venue spec v2 " })).toEqual({
      ok: true,
      data: { id: "rc1" },
    });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_project_id: "pr1", p_note: "Venue spec v2" }],
    ]);
    expect((await runReconciliation(db, { projectId: "pr1", note: null })).ok).toBe(false);
    expect(calls[3]?.steps[0]).toEqual(["args", [{ p_project_id: "pr1" }]]);
  });

  it("refuses a run without requirements and surfaces statement failures", async () => {
    const none = fakeClient({
      "from:capability_statements": [
        okResponse([statementRow({ direction: "Provide", venue_id: "v" })]),
        down(),
      ],
    });
    const refused = await runReconciliation(none.db, { projectId: "p", note: null });
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "reconciliation_no_requirements",
    );
    expect((await runReconciliation(none.db, { projectId: "p", note: null })).ok).toBe(false);
  });

  it("lists runs with counts and gate 3 gaps", async () => {
    const { db } = fakeClient({
      "from:reconciliations": [
        okResponse([{ id: "rc1", project_id: "pr1", reconciled_at: "2026-10-10", note: null }]),
      ],
      "from:reconciliation_lines": [
        okResponse([
          { reconciliation_id: "rc1", result: "Met" },
          { reconciliation_id: "rc1", result: "Gap" },
          { reconciliation_id: "rc1", result: "Unknown" },
        ]),
      ],
      "from:reconciliation_gaps": [
        okResponse([
          { reconciliation_id: "rc1", result: "Gap", is_critical: false },
          { reconciliation_id: "rc1", result: "Unknown", is_critical: true },
        ]),
      ],
    });
    const result = await listReconciliations(db, { orgId: "o1", projectId: "pr1" });
    expect(result.ok && result.data[0]).toMatchObject({ met: 1, gap: 1, unknown: 1, gate3Gaps: 2 });
  });

  it("returns no runs and surfaces list failures", async () => {
    expect(
      await listReconciliations(fakeClient({ "from:reconciliations": [okResponse([])] }).db, {
        orgId: "o",
      }),
    ).toEqual({ ok: true, data: [] });
    expect(
      (
        await listReconciliations(fakeClient({ "from:reconciliations": [down()] }).db, {
          orgId: "o",
        })
      ).ok,
    ).toBe(false);
    const run = [{ id: "rc1", project_id: "pr1", reconciled_at: "2026-10-10", note: null }];
    const lines = fakeClient({
      "from:reconciliations": [okResponse(run)],
      "from:reconciliation_lines": [down()],
      "from:reconciliation_gaps": [okResponse([])],
    });
    expect((await listReconciliations(lines.db, { orgId: "o" })).ok).toBe(false);
    const gaps = fakeClient({
      "from:reconciliations": [okResponse(run)],
      "from:reconciliation_lines": [okResponse([])],
      "from:reconciliation_gaps": [down()],
    });
    expect((await listReconciliations(gaps.db, { orgId: "o" })).ok).toBe(false);
  });

  it("reads a run with lines in URID order and marks gate 3 gaps", async () => {
    const run = { id: "rc1", project_id: "pr1", reconciled_at: "2026-10-10", note: "v2" };
    const { db } = fakeClient({
      "from:reconciliations": [
        okResponse(run),
        okResponse(null),
        down(),
        okResponse(run),
        okResponse(run),
      ],
      "from:reconciliation_lines": [
        okResponse([
          { id: "l2", requirement_id: "q2", capability_id: null, result: "Unknown" },
          { id: "l1", requirement_id: "q1", capability_id: "c1", result: "Met" },
          { id: "l3", requirement_id: "gone", capability_id: null, result: "Gap" },
        ]),
        down(),
        okResponse([]),
      ],
      "from:capability_statements": [
        okResponse([
          statementRow({ id: "q1", urid: "5000.01.10" }),
          statementRow({ id: "q2", urid: "5000.01.9" }),
          statementRow({
            id: "c1",
            direction: "Provide",
            venue_id: "v",
            assertion_word: "CERTIFIED",
          }),
        ]),
        down(),
      ],
    });
    const result = await getReconciliation(db, "rc1");
    expect(result.ok && result.data.lines.map((l) => [l.id, l.gate3Gap])).toEqual([
      ["l2", true],
      ["l1", false],
    ]);
    expect(result.ok && result.data.lines[1]?.capability?.id).toBe("c1");
    expect(await getReconciliation(db, "rc1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getReconciliation(db, "rc1")).ok).toBe(false);
    expect((await getReconciliation(db, "rc1")).ok).toBe(false);
    expect((await getReconciliation(db, "rc1")).ok).toBe(false);
  });
});

describe("guest list", () => {
  const guestRow = (over: Record<string, unknown>) => ({
    id: "g1",
    project_id: "pr1",
    scope_node_id: null,
    person_id: null,
    counterparty_id: null,
    engagement_id: null,
    guest_name: "Jordan Pike",
    plus_ones: 1,
    note: null,
    entry_state: "Requested",
    decided_at: null,
    checked_in_at: null,
    created_at: "2026-10-10",
    created_by: "p1",
    ...over,
  });

  it("lists scopes and surfaces failures", async () => {
    const { db } = fakeClient({
      "from:scope_nodes": [
        okResponse([{ id: "s1", scope_code: "NWS-E01", name: "Opening Night" }]),
        down(),
      ],
    });
    expect(await listProjectScopes(db, "pr1")).toEqual({
      ok: true,
      data: [{ id: "s1", code: "NWS-E01", name: "Opening Night" }],
    });
    expect((await listProjectScopes(db, "pr1")).ok).toBe(false);
  });

  it("lists guests with the party whose list they are on", async () => {
    const { db, calls } = fakeClient({
      "from:guest_list_entries": [
        okResponse([
          guestRow({}),
          guestRow({ id: "g2", person_id: "p9", engagement_id: "e1" }),
          guestRow({ id: "g3", counterparty_id: "c1" }),
        ]),
      ],
      "from:people": [okResponse([{ id: "p9", full_name: "Arturo Bell" }])],
      "from:counterparties": [okResponse([])],
    });
    const result = await listGuests(db, { orgId: "o1", projectId: "pr1", state: "Requested" });
    expect(result.ok && result.data.map((g) => g.party?.name ?? null)).toEqual([
      null,
      "Arturo Bell",
      null,
    ]);
    expect(result.ok && result.data[2]?.party?.kind).toBe("counterparty");
    expect(calls[0]?.steps).toContainEqual(["eq", ["entry_state", "Requested"]]);
  });

  it("surfaces guest list failures", async () => {
    expect(
      (await listGuests(fakeClient({ "from:guest_list_entries": [down()] }).db, { orgId: "o" })).ok,
    ).toBe(false);
    const names = fakeClient({
      "from:guest_list_entries": [okResponse([guestRow({ person_id: "p9" })])],
      "from:people": [down()],
    });
    expect((await listGuests(names.db, { orgId: "o" })).ok).toBe(false);
  });

  it("adds a requested guest, or an approved comp for a reviewer", async () => {
    const { db, calls } = fakeClient({
      "from:guest_list_entries": [okResponse({ id: "g1" }), okResponse({ id: "g2" }), down()],
    });
    const input = {
      orgId: "o1",
      projectId: "pr1",
      guestName: " Jordan Pike ",
      plusOnes: 1,
      note: " ",
      scopeNodeId: null,
    };
    expect(await addGuest(db, input)).toEqual({ ok: true, data: { id: "g1" } });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        org_id: "o1",
        project_id: "pr1",
        scope_node_id: null,
        guest_name: "Jordan Pike",
        plus_ones: 1,
        note: null,
        entry_state: "Requested",
      },
    ]);
    expect((await addGuest(db, { ...input, approve: true })).ok).toBe(true);
    expect((calls[1]?.steps[0]?.[1] as Record<string, unknown>[])[0]?.["entry_state"]).toBe(
      "Approved",
    );
    expect((await addGuest(db, input)).ok).toBe(false);
    const invalid = { ok: false, error: { kind: "invalid", message: "guest" } };
    expect(await addGuest(db, { ...input, plusOnes: 21 })).toEqual(invalid);
    expect(await addGuest(db, { ...input, guestName: " " })).toEqual(invalid);
    expect(await addGuest(db, { ...input, note: "x".repeat(501) })).toEqual(invalid);
  });

  it("updates a requested guest", async () => {
    const { db } = fakeClient({
      "from:guest_list_entries": [okResponse([{ id: "g1" }]), okResponse([]), down()],
    });
    const input = { guestName: "Jordan Pike", plusOnes: 2, note: "Side stage.", scopeNodeId: "s1" };
    expect((await updateGuest(db, "g1", input)).ok).toBe(true);
    expect(await updateGuest(db, "g1", input)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateGuest(db, "g1", input)).ok).toBe(false);
    expect(await updateGuest(db, "g1", { ...input, plusOnes: 1.5 })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "guest" },
    });
  });

  it("decides and checks in with compare-and-set on the state", async () => {
    const { db, calls } = fakeClient({
      "from:guest_list_entries": [
        okResponse([{ id: "g1" }]),
        okResponse([]),
        okResponse([{ id: "g1" }]),
        errorResponse(
          "XR001",
          "sod_guest_requester: The person who requested a guest cannot approve or decline the request.",
          "sod_guest_requester",
        ),
      ],
    });
    expect(await decideGuest(db, "g1", "Approved")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps).toContainEqual(["eq", ["entry_state", "Requested"]]);
    const moved = await decideGuest(db, "g1", "Declined");
    expect(!moved.ok && moved.error.kind === "refusal" && moved.error.rule).toBe(
      "guest_entry_moved",
    );
    expect((await checkInGuest(db, "g1")).ok).toBe(true);
    expect(calls[2]?.steps[0]).toEqual(["update", [{ entry_state: "Checked In" }]]);
    const own = await decideGuest(db, "g1", "Approved");
    expect(!own.ok && own.error.kind === "refusal" && own.error.rule).toBe("sod_guest_requester");
  });

  it("removes a guest", async () => {
    const { db } = fakeClient({
      "from:guest_list_entries": [okResponse([{ id: "g1" }]), okResponse([]), down()],
    });
    expect((await removeGuest(db, "g1", NOW)).ok).toBe(true);
    expect((await removeGuest(db, "g1", NOW)).ok).toBe(false);
    expect((await removeGuest(db, "g1")).ok).toBe(false);
  });
});
