import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { appendDocUpdate, compactDoc, openDoc, toOpenedDoc } from "../src/coedit.ts";

function rpcClient(answer: { data: unknown; error: unknown }) {
  const calls: unknown[] = [];
  const db = {
    rpc(fn: string, args: unknown) {
      calls.push([fn, args]);
      return Promise.resolve(answer);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("co-editing data", () => {
  it("opens a row's document and reads its snapshot and updates", async () => {
    const { db, calls } = rpcClient({
      data: {
        doc_id: "d1",
        generation: 2,
        state: "AQI=",
        through_seq: 4,
        last_seq: 6,
        seed_text: "Wear a harness.",
        can_edit: true,
        updates: [{ seq: 5, update: "AwQ=" }, { seq: "6", update: "BQY=" }, { seq: 7 }],
      },
      error: null,
    });
    const doc = await openDoc(db, { table: "app.sops", id: "s1", docKey: "body", since: 4 });
    expect(calls[0]).toEqual([
      "open_doc",
      { p_subject_table: "app.sops", p_subject_id: "s1", p_doc_key: "body", p_since: 4 },
    ]);
    expect(doc).toEqual({
      ok: true,
      data: {
        docId: "d1",
        generation: 2,
        state: "AQI=",
        throughSeq: 4,
        lastSeq: 6,
        seedText: "Wear a harness.",
        canEdit: true,
        updates: [
          { seq: 5, update: "AwQ=" },
          { seq: 6, update: "BQY=" },
        ],
      },
    });
  });

  it("appends and compacts, and passes refusals on", async () => {
    const appended = await appendDocUpdate(rpcClient({ data: 3, error: null }).db, {
      docId: "d1",
      generation: 1,
      update: "AQI=",
    });
    expect(appended).toEqual({ ok: true, data: 3 });
    const stale = await appendDocUpdate(
      rpcClient({
        data: null,
        error: {
          code: "XR001",
          message:
            "coedit_generation_changed: The document was reloaded from its row; open it again.",
          hint: "coedit_generation_changed",
        },
      }).db,
      { docId: "d1", generation: 1, update: "AQI=" },
    );
    expect(stale.ok === false && stale.error.kind === "refusal" && stale.error.rule).toBe(
      "coedit_generation_changed",
    );
    const { db, calls } = rpcClient({ data: { compacted: true, through_seq: 9 }, error: null });
    expect(
      await compactDoc(db, { docId: "d1", generation: 1, state: "AQI=", through: 9, text: "Hi" }),
    ).toEqual({ ok: true, data: { compacted: true, throughSeq: 9 } });
    expect(calls[0]).toEqual([
      "compact_doc",
      { p_doc_id: "d1", p_generation: 1, p_state: "AQI=", p_through: 9, p_text: "Hi" },
    ]);
  });

  it("reads a malformed answer as no document", async () => {
    expect(toOpenedDoc(null)).toBeNull();
    expect(toOpenedDoc({ generation: 1 })).toBeNull();
    const empty = await openDoc(rpcClient({ data: {}, error: null }).db, {
      table: "app.sops",
      id: "s1",
      docKey: "body",
    });
    expect(empty.ok).toBe(false);
    const denied = await openDoc(
      rpcClient({ data: null, error: { code: "42501", message: "no" } }).db,
      {
        table: "app.sops",
        id: "s1",
        docKey: "body",
      },
    );
    expect(denied).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});
