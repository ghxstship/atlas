import { describe, expect, it } from "vitest";
import {
  createProjectInbox,
  disableProjectInbox,
  discardInboundMessage,
  fileInboundMessage,
  getProjectInbox,
  inboxAddress,
  listFilingTargets,
  listProjectInbox,
  replaceProjectInbox,
} from "../src/project-inbox.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ROW = {
  id: "m1",
  from_address: "rigging@bayside-audio.test",
  subject_line: "Rigging plot v4",
  body_text: "Updated plot attached.",
  received_at: "2026-10-20T10:00:00Z",
  inbound_status: "Verified",
  rejection_reason: null,
  filed_document_id: null,
  filed_record_id: null,
  filed_at: null,
  discarded_at: null,
  discard_reason: null,
  filer: null,
  discarder: null,
  document: null,
  record: null,
};

describe("project inbox", () => {
  it("shows the full address only once the receiving domain is set", () => {
    expect(inboxAddress("nwl-0a1b2c3d4e", "inbound.example.test")).toBe(
      "nwl-0a1b2c3d4e@inbound.example.test",
    );
    expect(inboxAddress("nwl-0a1b2c3d4e", " Inbound.Example.Test ")).toBe(
      "nwl-0a1b2c3d4e@inbound.example.test",
    );
    expect(inboxAddress("nwl-0a1b2c3d4e", undefined)).toBeNull();
    expect(inboxAddress("nwl-0a1b2c3d4e", "not a domain")).toBeNull();
  });

  it("reads, creates, replaces and disables the live address", async () => {
    const { db, calls } = fakeClient({
      "from:inbound_addresses": [
        okResponse({ id: "a1", local_part: "nwl-0a1b2c3d4e", created_at: "2026-10-20T10:00:00Z" }),
        okResponse(null),
      ],
      "rpc:create_project_inbox": [okResponse("nwl-0a1b2c3d4e")],
      "rpc:replace_project_inbox": [okResponse("nwl-ffeeddccbb")],
      "rpc:disable_project_inbox": [okResponse(null), errorResponse("42501", "project not found")],
    });
    expect(await getProjectInbox(db, "p1")).toEqual({
      ok: true,
      data: { id: "a1", localPart: "nwl-0a1b2c3d4e", createdAt: "2026-10-20T10:00:00Z" },
    });
    expect(await getProjectInbox(db, "p1")).toEqual({ ok: true, data: null });
    expect(await createProjectInbox(db, "p1")).toEqual({ ok: true, data: "nwl-0a1b2c3d4e" });
    expect(await replaceProjectInbox(db, "p1")).toEqual({ ok: true, data: "nwl-ffeeddccbb" });
    expect(await disableProjectInbox(db, "p1")).toEqual({ ok: true, data: null });
    expect(await disableProjectInbox(db, "p1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["disabled_at", null]]);
  });

  it("lists mail of every address of the project with its state", async () => {
    const { db } = fakeClient({
      "from:inbound_addresses": [okResponse([{ id: "a1" }, { id: "a0" }]), okResponse([])],
      "from:inbound_messages": [
        okResponse([
          ROW,
          { ...ROW, id: "m2", inbound_status: "Rejected", rejection_reason: "DKIM failed." },
          {
            ...ROW,
            id: "m3",
            inbound_status: "Filed",
            filed_document_id: "d1",
            filed_record_id: "r1",
            filed_at: "2026-10-20T11:00:00Z",
            filer: { full_name: "Dave Ruiz" },
            document: { title: "Rigging plot v4" },
            record: { title: "Hang the rigging plot" },
          },
          {
            ...ROW,
            id: "m4",
            discarded_at: "2026-10-20T12:00:00Z",
            discard_reason: "Spam.",
            discarder: { full_name: "Dave Ruiz" },
          },
        ]),
      ],
    });
    const result = await listProjectInbox(db, "p1");
    expect(result.ok && result.data.map((i) => i.state)).toEqual([
      "open",
      "rejected",
      "filed",
      "discarded",
    ]);
    expect(result.ok && result.data[2]).toMatchObject({
      documentTitle: "Rigging plot v4",
      recordTitle: "Hang the rigging plot",
      filedByName: "Dave Ruiz",
    });
    expect(await listProjectInbox(db, "p2")).toEqual({ ok: true, data: [] });
  });

  it("files and discards mail, passing only what was given", async () => {
    const { db, calls } = fakeClient({
      "rpc:file_inbound_message": [
        okResponse("d1"),
        okResponse(null),
        errorResponse(
          "XR001",
          "inbound_message_triaged: This mail was already filed or discarded.",
          "inbound_message_triaged",
        ),
      ],
      "rpc:discard_inbound_message": [
        okResponse(null),
        errorResponse("42501", "inbound message not found"),
      ],
      "from:records": [
        okResponse([{ id: "r1", title: "Hang the rigging plot", record_number: 7 }]),
      ],
    });
    expect(await fileInboundMessage(db, { id: "m1", recordId: "r1" })).toEqual({
      ok: true,
      data: "d1",
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_inbound_message_id: "m1", p_record_id: "r1" }],
    ]);
    expect((await fileInboundMessage(db, { id: "m1", title: "Plot" })).ok).toBe(false);
    expect(await fileInboundMessage(db, { id: "m1" })).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "inbound_message_triaged" },
    });
    expect(await discardInboundMessage(db, { id: "m2", reason: "Spam." })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await discardInboundMessage(db, { id: "m2" })).ok).toBe(false);
    expect(await listFilingTargets(db, "p1", "NWL")).toEqual({
      ok: true,
      data: [{ id: "r1", label: "NWL-7 Hang the rigging plot" }],
    });
  });
});
