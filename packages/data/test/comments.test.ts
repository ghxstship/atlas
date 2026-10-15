import { describe, expect, it } from "vitest";
import {
  addReaction,
  deleteComment,
  editComment,
  listCommentVersions,
  listThreads,
  postComment,
  removeReaction,
  setSubscription,
  setThreadResolved,
} from "../src/comments";
import { errorResponse, fakeClient, okResponse } from "./fake-client";

const subject = { table: "app.records", id: "rec-1" };
const now = new Date("2026-10-14T12:00:00Z");

const comment = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  author_person_id: "p-dave",
  body: `Body ${id}`,
  source: "App",
  created_at: createdAt,
  edited_at: null,
  deleted_at: null,
  comment_mentions: [
    { mentioned_person_id: "p-erin", deleted_at: null },
    { mentioned_person_id: "p-gone", deleted_at: "2026-10-01T00:00:00Z" },
  ],
  comment_reactions: [
    { reaction_code: "thumbs_up", person_id: "p-frank", deleted_at: null },
    { reaction_code: "heart", person_id: "p-frank", deleted_at: "2026-10-02T00:00:00Z" },
  ],
  ...extra,
});

describe("listThreads", () => {
  it("returns the main thread first with comments oldest first and live mentions and reactions only", async () => {
    const { db, calls } = fakeClient({
      "from:comment_threads": [
        okResponse([
          {
            id: "t-anchor",
            anchor: "budget",
            resolved_at: null,
            resolved_by: null,
            comments: null,
          },
          {
            id: "t-main",
            anchor: null,
            resolved_at: "2026-10-10T00:00:00Z",
            resolved_by: "p-erin",
            comments: [
              comment("c2", "2026-10-11T00:00:00Z"),
              comment("c1", "2026-10-10T00:00:00Z"),
              comment("c3", "2026-10-11T00:00:00Z", {
                comment_mentions: null,
                comment_reactions: null,
              }),
            ],
          },
        ]),
      ],
    });
    const result = await listThreads(db, subject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((t) => t.id)).toEqual(["t-main", "t-anchor"]);
    const main = result.data[0];
    expect(main?.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(main?.comments[0]?.mentionedPersonIds).toEqual(["p-erin"]);
    expect(main?.comments[0]?.reactions).toEqual([{ code: "thumbs_up", personId: "p-frank" }]);
    expect(main?.comments[2]?.reactions).toEqual([]);
    expect(main?.resolvedBy).toBe("p-erin");
    expect(result.data[1]?.comments).toEqual([]);
    expect(calls[0]?.steps.filter(([m]) => m === "eq")).toEqual([
      ["eq", ["subject_table", "app.records"]],
      ["eq", ["subject_id", "rec-1"]],
    ]);
  });

  it("maps a database error", async () => {
    const { db } = fakeClient({
      "from:comment_threads": [errorResponse("08006", "connection lost")],
    });
    expect(await listThreads(db, subject)).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "connection lost", code: "08006" },
    });
  });
});

describe("postComment", () => {
  it("posts through app.post_comment with mentions and an anchor", async () => {
    const { db, calls } = fakeClient({
      "rpc:post_comment": [okResponse("c-9"), okResponse("c-10")],
    });
    expect(
      await postComment(db, {
        subject,
        body: "Load-in at 07:00.",
        mentions: ["p-erin"],
        anchor: "schedule",
      }),
    ).toEqual({ ok: true, data: "c-9" });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_subject_table: "app.records",
          p_subject_id: "rec-1",
          p_body: "Load-in at 07:00.",
          p_mentions: ["p-erin"],
          p_anchor: "schedule",
        },
      ],
    ]);
    await postComment(db, { subject, body: "No mentions." });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [
        {
          p_subject_table: "app.records",
          p_subject_id: "rec-1",
          p_body: "No mentions.",
          p_mentions: [],
        },
      ],
    ]);
  });

  it("returns refusals typed with their rule", async () => {
    const { db } = fakeClient({
      "rpc:post_comment": [
        errorResponse(
          "XR001",
          "comment_mention_no_access: Only people who can open the subject can be mentioned.",
          "comment_mention_no_access",
        ),
        errorResponse("42501", "subject not found"),
      ],
    });
    expect(await postComment(db, { subject, body: "Hi", mentions: ["p-gina"] })).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "comment_mention_no_access",
        message: "Only people who can open the subject can be mentioned.",
      },
    });
    expect(await postComment(db, { subject, body: "Hi" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("editing and deleting", () => {
  it("edits and deletes the caller's own comment, and reports others as not found", async () => {
    const { db, calls } = fakeClient({
      "from:comments": [
        okResponse([{ id: "c1" }]),
        okResponse([{ id: "c1" }]),
        okResponse([]),
        errorResponse(
          "XR001",
          "comment_deleted: A deleted comment stays deleted.",
          "comment_deleted",
        ),
      ],
    });
    expect(await editComment(db, "c1", "New text")).toEqual({ ok: true, data: undefined });
    expect(calls[0]?.steps[0]).toEqual(["update", [{ body: "New text" }]]);
    expect(await deleteComment(db, "c1", now)).toEqual({ ok: true, data: undefined });
    expect(calls[1]?.steps[0]).toEqual(["update", [{ deleted_at: "2026-10-14T12:00:00.000Z" }]]);
    expect(await editComment(db, "c-other", "x")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await editComment(db, "c1", "x")).ok).toBe(false);
  });

  it("reads the edit history in order", async () => {
    const { db } = fakeClient({
      "from:comment_versions": [
        okResponse([{ version_number: 1, body: "First", created_at: "2026-10-10T00:00:00Z" }]),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    expect(await listCommentVersions(db, "c1")).toEqual({
      ok: true,
      data: [{ versionNumber: 1, body: "First", createdAt: "2026-10-10T00:00:00Z" }],
    });
    expect(await listCommentVersions(db, "c1")).toEqual({ ok: true, data: [] });
    expect((await listCommentVersions(db, "c1")).ok).toBe(false);
  });
});

describe("reactions, subscriptions and resolution", () => {
  it("adds a reaction without sending a person id and removes it softly", async () => {
    const { db, calls } = fakeClient({
      "from:comment_reactions": [
        okResponse(null),
        errorResponse("23505", "duplicate"),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    expect(await addReaction(db, "c1", "thumbs_up")).toEqual({ ok: true, data: undefined });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ comment_id: "c1", reaction_code: "thumbs_up" }],
    ]);
    expect(await addReaction(db, "c1", "thumbs_up")).toEqual({
      ok: false,
      error: { kind: "conflict", message: "duplicate" },
    });
    expect(await removeReaction(db, "c1", "thumbs_up", now)).toEqual({ ok: true, data: undefined });
    expect(calls[2]?.steps[0]).toEqual(["update", [{ deleted_at: "2026-10-14T12:00:00.000Z" }]]);
    expect((await removeReaction(db, "c1", "thumbs_up")).ok).toBe(false);
  });

  it("follows, mutes and resolves", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_thread_subscription": [okResponse(null), errorResponse("42501", "denied")],
      "from:comment_threads": [
        okResponse([{ id: "t1" }]),
        okResponse([{ id: "t1" }]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
    });
    expect(await setSubscription(db, "t1", false)).toEqual({ ok: true, data: undefined });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_comment_thread_id: "t1", p_subscribed: false }],
    ]);
    expect(await setSubscription(db, "t1", true)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await setThreadResolved(db, "t1", true, now)).toEqual({ ok: true, data: undefined });
    expect(calls[2]?.steps[0]).toEqual(["update", [{ resolved_at: "2026-10-14T12:00:00.000Z" }]]);
    await setThreadResolved(db, "t1", false);
    expect(calls[3]?.steps[0]).toEqual(["update", [{ resolved_at: null }]]);
    expect(await setThreadResolved(db, "t-other", true)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await setThreadResolved(db, "t1", true)).ok).toBe(false);
  });
});
