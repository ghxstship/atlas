import { describe, expect, it } from "vitest";
import {
  addGroupMember,
  archiveGroup,
  createGroup,
  deleteMessage,
  editMessage,
  listGroupMembers,
  listGroups,
  listMessages,
  listMyConversations,
  listReadReceipts,
  listWorkforceDirectory,
  markConversationRead,
  readBy,
  removeGroupMember,
  sendMessage,
  startDirectConversation,
  telHref,
  updateGroup,
} from "../src/workforce-chat.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const person = (name: string) => ({ id: "m", person_id: "p", person: { full_name: name } });

describe("groups", () => {
  it("lists groups with live member counts and members owners first", async () => {
    const { db, calls } = moduleClient({
      "from:groups": [
        okResponse([
          {
            id: "g1",
            name: "Riggers",
            group_kind: "Crew",
            project_id: null,
            description: null,
            archived_at: null,
            created_at: "2026-10-01T00:00:00Z",
            group_members: [{ deleted_at: null }, { deleted_at: "x" }],
          },
        ]),
      ],
      "from:group_members": [
        okResponse([
          { id: "a", membership_id: "m1", group_role: "Member", membership: person("Zed") },
          { id: "b", membership_id: "m2", group_role: "Owner", membership: person("Yan") },
          { id: "c", membership_id: "m3", group_role: "Member", membership: person("Amy") },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    const groups = await listGroups(db, "o1");
    expect(groups.ok && groups.data[0]?.memberCount).toBe(1);
    expect(stepsOf(calls[0], "eq")).toContainEqual(["org_id", "o1"]);
    const members = await listGroupMembers(db, "g1");
    expect(members.ok && members.data.map((m) => m.name)).toEqual(["Yan", "Amy", "Zed"]);
    const denied = await listGroupMembers(db, "g2");
    expect(!denied.ok && denied.error.kind).toBe("not-found");
  });

  it("creates, edits, archives and changes members", async () => {
    const { db, calls } = moduleClient({
      "from:groups": [
        okResponse({ id: "g1" }),
        okResponse({ id: "g1" }),
        okResponse({ id: "g1" }),
        errorResponse("XR001", "group_archived: final", "group_archived"),
      ],
      "from:group_members": [okResponse({ id: "gm1" }), okResponse({ id: "gm1" })],
    });
    expect(await createGroup(db, "o1", { name: "Riggers", kind: "Crew" })).toEqual({
      ok: true,
      data: { id: "g1" },
    });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      org_id: "o1",
      group_kind: "Crew",
      project_id: null,
    });
    expect((await updateGroup(db, "g1", { name: "Rigging", description: "Points" })).ok).toBe(true);
    expect((await archiveGroup(db, "g1")).ok).toBe(true);
    const refused = await archiveGroup(db, "g1");
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "group_archived",
    );
    expect((await addGroupMember(db, "g1", "m1", "Owner")).ok).toBe(true);
    expect(stepsOf(calls[4], "insert")[0]?.[0]).toMatchObject({ group_role: "Owner" });
    expect((await removeGroupMember(db, "gm1")).ok).toBe(true);
  });
});

describe("chat", () => {
  it("lists conversations and messages oldest first", async () => {
    const { db } = moduleClient({
      "rpc:my_conversations": [
        okResponse([
          {
            conversation_id: "c1",
            conversation_kind: "Direct",
            group_id: null,
            title: "Carol Nguyen",
            other_membership_id: "m2",
            last_message_at: "2026-10-02T00:00:00Z",
            last_message_body: "Hi",
            unread_count: 2,
            muted: false,
          },
        ]),
      ],
      "from:chat_messages": [
        okResponse([
          {
            id: "b",
            author_membership_id: "m1",
            message_kind: "Text",
            body: "Second",
            language: null,
            created_at: "2026-10-02T00:00:00Z",
            edited_at: null,
            author: person("A"),
          },
          {
            id: "a",
            author_membership_id: "m2",
            message_kind: "Voice",
            body: null,
            language: "es",
            created_at: "2026-10-01T00:00:00Z",
            edited_at: null,
            author: person("B"),
          },
        ]),
      ],
    });
    const convs = await listMyConversations(db, "o1");
    expect(convs.ok && convs.data[0]).toMatchObject({
      title: "Carol Nguyen",
      unread: 2,
      kind: "Direct",
    });
    const msgs = await listMessages(db, "c1");
    expect(msgs.ok && msgs.data.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sends, edits, deletes and reads", async () => {
    const { db, calls } = moduleClient({
      "rpc:start_direct_conversation": [okResponse("c1")],
      "rpc:send_chat_message": [okResponse("x1")],
      "rpc:edit_chat_message": [okResponse("x1")],
      "rpc:delete_chat_message": [okResponse("x1")],
      "rpc:mark_conversation_read": [okResponse("2026-10-02T00:00:00Z")],
      "rpc:conversation_read_receipts": [
        okResponse([
          { membership_id: "m2", full_name: "Carol", last_read_at: "2026-10-02T00:00:00Z" },
        ]),
      ],
    });
    expect(await startDirectConversation(db, "o1", "m2")).toEqual({ ok: true, data: { id: "c1" } });
    expect((await sendMessage(db, "c1", { body: "Hi" })).ok).toBe(true);
    expect(calls[1]?.steps[0]?.[1][0]).toEqual({ p_conversation_id: "c1", p_body: "Hi" });
    expect((await editMessage(db, "x1", "Hello")).ok).toBe(true);
    expect((await deleteMessage(db, "x1")).ok).toBe(true);
    expect(await markConversationRead(db, "c1")).toEqual({
      ok: true,
      data: "2026-10-02T00:00:00Z",
    });
    const receipts = await listReadReceipts(db, "c1");
    expect(receipts.ok && readBy({ createdAt: "2026-10-01T00:00:00Z" }, receipts.data)).toEqual([
      "Carol",
    ]);
    expect(receipts.ok && readBy({ createdAt: "2026-10-03T00:00:00Z" }, receipts.data)).toEqual([]);
  });
});

describe("directory", () => {
  it("maps the directory and builds call links", async () => {
    const { db, calls } = moduleClient({
      "rpc:workforce_directory": [
        okResponse([
          {
            membership_id: "m1",
            person_id: "p1",
            full_name: "Frank Adeyemi",
            preferred_name: null,
            headline: "Rigger",
            photo_path: null,
            role_names: ["Field"],
            on_site_now: true,
            on_site_project_id: "pr1",
            on_site_since: "2026-10-02T00:00:00Z",
            work_phone: "+1 305 555 0199",
            recognition_count: null,
          },
        ]),
      ],
    });
    const dir = await listWorkforceDirectory(db, "o1", { search: "frank", onSiteOnly: true });
    expect(dir.ok && dir.data[0]).toMatchObject({
      onSite: true,
      roles: ["Field"],
      recognitionCount: null,
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_org_id: "o1",
      p_search: "frank",
      p_on_site_only: true,
    });
    expect(telHref("+1 (305) 555-0199")).toBe("tel:+13055550199");
    expect(telHref("ab")).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});
