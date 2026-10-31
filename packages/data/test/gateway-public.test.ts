import { describe, expect, it } from "vitest";
import {
  beginAdvanceUpload,
  finishAdvanceUpload,
  inviteAdvanceRosterMember,
  listAdvanceRoster,
  previewAdvance,
  requestAdvanceGuest,
  storeAdvanceUpload,
  submitAdvanceRoster,
  submitAdvanceTyped,
} from "../src/gateway-public.ts";
import type { XosClient } from "../src/client.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * R10 (migrations 2730 and 2731): the advance link's typed sections, uploads, guests and crew
 * roster. The preview maps the columns it appends after return_reason; every token call keeps a
 * refusal's rule, answers token_invalid when nothing comes back, and passes a database error on.
 */

const link = { token: "xadv_t", accessCode: "424242", sectionId: "s1" };
const refused = (reason: string) => ({ refusal: "REFUSE", reason });

const typedRow = {
  refusal: null,
  reason: null,
  org_name: "Northwind Live",
  packet_title: "Vendor Advance",
  due_at: null,
  recipient_email: "crew@example.com",
  expires_at: null,
  section_id: "s1",
  section_position: 1,
  section_title: "Radios",
  section_prompt: null,
  answer_body: "ITEM_REQUEST 8000.01 x2",
  answered_at: "2027-05-01T10:00:00Z",
  review_outcome: null,
  return_reason: null,
  section_kind: "Item Request",
  window_kind: null,
  max_lines: 3,
  per_person: true,
  choices: [
    {
      id: "c1",
      asset_class_id: "radios",
      class_name: "Radios",
      credential_category_id: null,
      category_name: null,
    },
  ],
  answer_id: "a1",
  answer_note: "Two for the stage crew.",
  answer_lines: [
    {
      line_number: 1,
      asset_class_id: "radios",
      roster_entry_id: "e1",
      quantity: 2,
      needed_window_start: "2027-06-01T12:00:00+00:00",
      needed_window_end: "2027-06-02T12:00:00+00:00",
      window_zone: "America/New_York",
    },
  ],
  answer_files: [{ file_id: "d1", title: "rider.pdf", scan_status: "Clean" }],
  can_answer: false,
  guest_cap: null,
  guests_used: null,
  roster_summary: null,
  project_time_zone: "America/New_York",
  roster_people: [{ roster_entry_id: "e1", display_name: "n***@example.com" }],
};

describe("previewAdvance (R10 columns)", () => {
  it("maps the kind, choices, latest answer, roster people and the project's zone", async () => {
    const { db } = fakeClient({
      "rpc:api_public.preview_advance": [
        okResponse([
          typedRow,
          {
            ...typedRow,
            section_id: "s2",
            section_position: 2,
            section_title: "Guests",
            section_kind: "Guest List",
            max_lines: null,
            per_person: false,
            choices: null,
            answer_id: null,
            answer_body: null,
            answer_note: null,
            answer_lines: null,
            answer_files: null,
            can_answer: true,
            guest_cap: 4,
            guests_used: 2,
            roster_people: null,
          },
        ]),
      ],
    });
    const packet = await previewAdvance(db, link);
    if (!packet.ok || packet.data.refused) throw new Error("expected a packet");
    expect(packet.data.timeZone).toBe("America/New_York");
    const [radios, guests] = packet.data.sections;
    expect(radios).toMatchObject({
      kind: "Item Request",
      maxLines: 3,
      perPerson: true,
      choices: [{ id: "c1", assetClassId: "radios", className: "Radios" }],
      answerId: "a1",
      answerNote: "Two for the stage crew.",
      canAnswer: false,
      rosterPeople: [{ rosterEntryId: "e1", displayName: "n***@example.com" }],
    });
    expect(radios?.answerLines[0]).toEqual({
      lineNumber: 1,
      assetClassId: "radios",
      credentialCategoryId: null,
      rosterEntryId: "e1",
      quantity: 2,
      neededFrom: "2027-06-01T12:00:00+00:00",
      neededTo: "2027-06-02T12:00:00+00:00",
      windowZone: "America/New_York",
      note: null,
    });
    expect(radios?.answerFiles).toEqual([
      { fileId: "d1", title: "rider.pdf", scanStatus: "Clean" },
    ]);
    expect(guests).toMatchObject({
      kind: "Guest List",
      choices: [],
      answerLines: [],
      answerFiles: [],
      canAnswer: true,
      guestCap: 4,
      guestsUsed: 2,
      rosterPeople: [],
    });
  });

  it("reads a row from before R10 as a Text section the 2604 rule opens", async () => {
    const legacy = Object.fromEntries(
      Object.entries(typedRow).filter(([key]) => Object.keys(typedRow).indexOf(key) < 15),
    );
    const { db } = fakeClient({
      "rpc:api_public.preview_advance": [
        okResponse([{ ...legacy, review_outcome: "Returned", return_reason: "Which airport?" }]),
      ],
    });
    const packet = await previewAdvance(db, link);
    if (!packet.ok || packet.data.refused) throw new Error("expected a packet");
    expect(packet.data.timeZone).toBe("UTC");
    expect(packet.data.sections[0]).toMatchObject({
      kind: "Text",
      perPerson: false,
      canAnswer: true,
      rosterSummary: null,
    });
  });
});

describe("token calls (R10)", () => {
  it("submits a typed answer with snake_case lines and keeps a refusal's rule", async () => {
    const { db, calls } = fakeClient({
      "rpc:api_public.submit_advance_typed": [
        okResponse([
          { submission_id: "a1", submitted_at: "2027-05-01", refusal: null, reason: null },
        ]),
        okResponse([
          { submission_id: null, submitted_at: null, ...refused("advance_answer_pending") },
        ]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    const answer = {
      ...link,
      text: "  ",
      note: " Two radios. ",
      lines: [{ assetClassId: "radios", quantity: 2, rosterEntryId: null }],
      documentIds: ["d1"],
    };
    expect(await submitAdvanceTyped(db, answer)).toEqual({
      ok: true,
      data: { refused: false, submissionId: "a1", submittedAt: "2027-05-01" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_token: "xadv_t",
      p_access_code: "424242",
      p_section_id: "s1",
      p_text: null,
      p_note: "Two radios.",
      p_lines: [{ asset_class_id: "radios", quantity: 2 }],
      p_document_ids: ["d1"],
    });
    expect(await submitAdvanceTyped(db, link)).toEqual({
      ok: true,
      data: { refused: true, reason: "advance_answer_pending" },
    });
    expect(await submitAdvanceTyped(db, link)).toEqual({
      ok: true,
      data: { refused: true, reason: "token_invalid" },
    });
    expect((await submitAdvanceTyped(db, link)).ok).toBe(false);
  });

  it("begins, stores and finishes an upload", async () => {
    const { db, calls } = fakeClient({
      "rpc:api_public.begin_advance_upload": [
        okResponse([
          {
            ticket_id: "t1",
            object_name: "org/advance-token/t1/rider.pdf",
            expires_at: "2027-05-01T10:15:00Z",
            refusal: null,
            reason: null,
          },
        ]),
        okResponse([
          {
            ticket_id: null,
            object_name: null,
            expires_at: null,
            ...refused("advance_upload_type"),
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "rpc:api_public.finish_advance_upload": [
        okResponse([{ document_id: "d1", refusal: null, reason: null }]),
        okResponse([{ document_id: null, ...refused("party_upload_checksum") }]),
        errorResponse("08000", "down"),
      ],
    });
    const file = { fileName: "rider.pdf", contentType: "application/pdf", byteSize: 2048 };
    expect(await beginAdvanceUpload(db, { ...link, ...file })).toEqual({
      ok: true,
      data: {
        refused: false,
        ticketId: "t1",
        objectName: "org/advance-token/t1/rider.pdf",
        expiresAt: "2027-05-01T10:15:00Z",
      },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_file_name: "rider.pdf",
      p_content_type: "application/pdf",
      p_byte_size: 2048,
    });
    expect(await beginAdvanceUpload(db, { ...link, ...file })).toEqual({
      ok: true,
      data: { refused: true, reason: "advance_upload_type" },
    });
    expect((await beginAdvanceUpload(db, { ...link, ...file })).ok).toBe(false);

    const finish = {
      token: "xadv_t",
      accessCode: "424242",
      ticketId: "t1",
      title: "Rider",
      checksumSha256: "a".repeat(64),
    };
    expect(await finishAdvanceUpload(db, finish)).toEqual({
      ok: true,
      data: { refused: false, documentId: "d1" },
    });
    expect(await finishAdvanceUpload(db, finish)).toEqual({
      ok: true,
      data: { refused: true, reason: "party_upload_checksum" },
    });
    expect((await finishAdvanceUpload(db, finish)).ok).toBe(false);
  });

  it("stores the ticket's object without overwriting", async () => {
    const uploads: unknown[][] = [];
    const results = [
      { error: null },
      { error: { message: "new row violates row-level security policy" } },
    ];
    const db = {
      storage: {
        from: (bucket: string) => ({
          upload: (...args: unknown[]) => {
            uploads.push([bucket, ...args]);
            return Promise.resolve(results.shift());
          },
        }),
      },
    } as unknown as XosClient;
    const body = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    const input = {
      objectName: "org/advance-token/t1/rider.pdf",
      body,
      contentType: "application/pdf",
    };
    expect(await storeAdvanceUpload(db, input)).toEqual({ ok: true, data: null });
    expect(uploads[0]).toEqual([
      "party-uploads",
      "org/advance-token/t1/rider.pdf",
      body,
      { contentType: "application/pdf", upsert: false },
    ]);
    expect((await storeAdvanceUpload(db, input)).ok).toBe(false);
  });

  it("asks for a guest", async () => {
    const { db, calls } = fakeClient({
      "rpc:api_public.request_advance_guest": [
        okResponse([{ guest_entry_id: "g1", refusal: null, reason: null }]),
        okResponse([{ guest_entry_id: null, ...refused("guest_list_cap") }]),
        errorResponse("08000", "down"),
      ],
    });
    const guest = { ...link, guestName: "Sasha Bell", plusOnes: 1, note: " " };
    expect(await requestAdvanceGuest(db, guest)).toEqual({
      ok: true,
      data: { refused: false, guestEntryId: "g1" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_guest_name: "Sasha Bell",
      p_plus_ones: 1,
      p_note: null,
    });
    expect(await requestAdvanceGuest(db, guest)).toEqual({
      ok: true,
      data: { refused: true, reason: "guest_list_cap" },
    });
    expect((await requestAdvanceGuest(db, guest)).ok).toBe(false);
  });

  it("lists, invites and submits the roster, masked until a person accepts", async () => {
    const { db, calls } = fakeClient({
      "rpc:api_public.advance_roster": [
        okResponse([
          {
            refusal: null,
            reason: null,
            roster_entry_id: "e1",
            display_name: "n***@example.com",
            role_code: null,
            entry_state: "Draft",
            invitation_state: "Pending",
          },
        ]),
        okResponse([{ ...refused("roster_closed"), roster_entry_id: null }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
      "rpc:api_public.invite_advance_roster_member": [
        okResponse([{ roster_entry_id: "e2", refusal: null, reason: null }]),
        okResponse([{ roster_entry_id: null, ...refused("advance_roster_rate") }]),
        errorResponse("08000", "down"),
      ],
      "rpc:api_public.submit_advance_roster": [
        okResponse([{ submitted: 1, refusal: null, reason: null }]),
        okResponse([{ submitted: null, ...refused("roster_empty_submit") }]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await listAdvanceRoster(db, link)).toEqual({
      ok: true,
      data: {
        refused: false,
        entries: [
          {
            rosterEntryId: "e1",
            displayName: "n***@example.com",
            roleCode: null,
            entryState: "Draft",
            invitationState: "Pending",
          },
        ],
      },
    });
    expect(await listAdvanceRoster(db, link)).toEqual({
      ok: true,
      data: { refused: true, reason: "roster_closed" },
    });
    expect(await listAdvanceRoster(db, link)).toEqual({
      ok: true,
      data: { refused: false, entries: [] },
    });
    expect((await listAdvanceRoster(db, link)).ok).toBe(false);

    const invite = { ...link, email: "nova@example.com" };
    expect(await inviteAdvanceRosterMember(db, invite)).toEqual({
      ok: true,
      data: { refused: false, rosterEntryId: "e2" },
    });
    expect(
      calls.find((c) => c.target.endsWith("invite_advance_roster_member"))?.steps[0]?.[1][0],
    ).toMatchObject({
      p_email: "nova@example.com",
      p_role_code: null,
      p_arrival_starts_at: null,
      p_arrival_zone: null,
    });
    expect(
      await inviteAdvanceRosterMember(db, {
        ...invite,
        arrivalFrom: "2027-06-01T12:00:00Z",
        arrivalTo: "2027-06-01T14:00:00Z",
        arrivalZone: "America/New_York",
      }),
    ).toEqual({ ok: true, data: { refused: true, reason: "advance_roster_rate" } });
    expect((await inviteAdvanceRosterMember(db, invite)).ok).toBe(false);

    expect(await submitAdvanceRoster(db, link)).toEqual({
      ok: true,
      data: { refused: false, submitted: 1 },
    });
    expect(await submitAdvanceRoster(db, link)).toEqual({
      ok: true,
      data: { refused: true, reason: "roster_empty_submit" },
    });
    expect((await submitAdvanceRoster(db, link)).ok).toBe(false);
  });
});
