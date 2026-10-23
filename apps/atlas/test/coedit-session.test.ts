import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoeditSession,
  FIELD,
  docText,
  fromBase64,
  seedUpdate,
  toBase64,
  type OpenedDoc,
  type RoomHandlers,
  type SessionDeps,
  type SessionState,
} from "../components/coedit/session";

/** An in-memory app.open_doc, append_doc_update and compact_doc, with a broadcast room. */
function fakeServer(seedText: string) {
  const doc = {
    id: "d1",
    generation: 1,
    state: null as string | null,
    through: 0,
    last: 0,
    text: seedText,
    updates: [] as { seq: number; update: string; generation: number }[],
  };
  const rooms = new Map<string, RoomHandlers>();
  const presence = new Map<string, Record<string, unknown>>();
  let roomUp = true;
  const server = {
    doc,
    rooms,
    presence,
    setRoomUp(up: boolean) {
      roomUp = up;
    },
    open(since: number, canEdit = true): OpenedDoc {
      return {
        docId: doc.id,
        generation: doc.generation,
        state: doc.state,
        throughSeq: doc.through,
        lastSeq: doc.last,
        seedText: doc.text,
        canEdit,
        updates: doc.updates
          .filter((u) => u.generation === doc.generation && u.seq > Math.max(since, doc.through))
          .map(({ seq, update }) => ({ seq, update })),
      };
    },
    append(generation: number, update: string) {
      if (generation !== doc.generation)
        return { ok: false as const, rule: "coedit_generation_changed" };
      doc.last += 1;
      doc.updates.push({ seq: doc.last, update, generation });
      return { ok: true as const, data: doc.last };
    },
    compact(generation: number, state: string, through: number, text: string) {
      if (generation !== doc.generation)
        return { ok: false as const, rule: "coedit_generation_changed" };
      if (through <= doc.through)
        return { ok: true as const, data: { compacted: false, throughSeq: doc.through } };
      doc.state = state;
      doc.through = through;
      doc.text = text;
      doc.updates = doc.updates.filter((u) => u.seq > through);
      return { ok: true as const, data: { compacted: true, throughSeq: through } };
    },
    reseed(text: string) {
      doc.generation += 1;
      doc.state = null;
      doc.through = doc.last;
      doc.updates = [];
      doc.text = text;
    },
    broadcast(from: string, event: string, payload: Record<string, unknown>) {
      if (!roomUp) return false;
      for (const [key, handlers] of rooms) if (key !== from) handlers.onBroadcast(event, payload);
      return true;
    },
  };
  return server;
}

function editor(server: ReturnType<typeof fakeServer>, key: string, canEdit = true, resyncMs = 20) {
  const states: SessionState[] = [];
  const deps: SessionDeps = {
    me: { key, name: key.toUpperCase() },
    open: async (since) => ({ ok: true, data: server.open(since, canEdit) }),
    append: async (_doc, generation, update) => server.append(generation, update),
    compact: async (_doc, generation, state, through, text) =>
      server.compact(generation, state, through, text),
    room: async (_doc, handlers) => {
      server.rooms.set(key, handlers);
      handlers.onStatus("joined");
      return {
        send: async (event, payload) => server.broadcast(key, event, payload),
        track: async (state) => {
          server.presence.set(key, state);
          const members = [...server.presence.values()];
          for (const h of server.rooms.values()) h.onPresence(members);
        },
        leave: () => server.rooms.delete(key),
      };
    },
    onChange: (state) => states.push(state),
    timing: { flushMs: 5, compactMs: 30, resyncMs },
  };
  const session = new CoeditSession(deps);
  const doc = () => states.at(-1)?.doc ?? null;
  return { session, states, doc };
}

/** Types at the end of the first paragraph, as the editor would. */
function type(doc: Y.Doc, text: string) {
  const first = doc.getXmlFragment(FIELD).get(0) as Y.XmlElement;
  const node = first.get(0) as Y.XmlText;
  node.insert(node.length, text);
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.useRealTimers());

describe("co-editing session", () => {
  it("seeds every editor from the row with one copy of the text", async () => {
    const a = seedUpdate("Wear a harness.\n\nClip in above you.");
    const b = seedUpdate("Wear a harness.\n\nClip in above you.");
    expect(toBase64(a)).toBe(toBase64(b));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, a);
    Y.applyUpdate(doc, b);
    expect(docText(doc)).toBe("Wear a harness.\n\nClip in above you.");
    expect(Array.from(fromBase64(toBase64(a)))).toEqual(Array.from(a));
  });

  it("converges two editors through broadcasts and keeps the text in the row", async () => {
    const server = fakeServer("Wear a harness.");
    const one = editor(server, "carol");
    const two = editor(server, "erin");
    await one.session.start();
    await two.session.start();
    type(one.doc() as Y.Doc, " Check it.");
    type(two.doc() as Y.Doc, " Clip in.");
    await settle();
    const texts = [docText(one.doc() as Y.Doc), docText(two.doc() as Y.Doc)];
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain("Check it.");
    expect(texts[0]).toContain("Clip in.");
    await settle(60);
    expect(server.doc.text).toBe(texts[0]);
    expect(server.doc.through).toBeGreaterThan(0);
    expect(two.states.at(-1)?.editors).toEqual(["CAROL"]);
    one.session.stop();
    two.session.stop();
  });

  it("recovers missed broadcasts from the database after a rejoin", async () => {
    const server = fakeServer("Line one");
    // No periodic pull here: only the rejoin brings the missed edit.
    const one = editor(server, "carol", true, 60_000);
    const two = editor(server, "erin", true, 60_000);
    await one.session.start();
    await two.session.start();
    server.setRoomUp(false);
    server.rooms.get("erin")?.onStatus("lost");
    type(one.doc() as Y.Doc, " and more");
    await settle(20);
    expect(docText(two.doc() as Y.Doc)).toBe("Line one");
    server.setRoomUp(true);
    server.rooms.get("erin")?.onStatus("joined");
    await settle(40);
    expect(docText(two.doc() as Y.Doc)).toBe("Line one and more");
    one.session.stop();
    two.session.stop();
  });

  it("reloads from the row when the text changed elsewhere, and a reader never writes", async () => {
    const server = fakeServer("Original");
    const one = editor(server, "carol");
    await one.session.start();
    server.reseed("Edited in a form.");
    type(one.doc() as Y.Doc, "!");
    await settle(120);
    expect(docText(one.doc() as Y.Doc)).toBe("Edited in a form.");
    expect(one.states.at(-1)?.generation).toBe(2);
    const reader = editor(server, "gina", false);
    await reader.session.start();
    const before = server.doc.last;
    type(reader.doc() as Y.Doc, " nope");
    await settle(40);
    expect(server.doc.last).toBe(before);
    expect(reader.states.at(-1)?.canEdit).toBe(false);
    one.session.stop();
    reader.session.stop();
  });

  it("reports a document it cannot open", async () => {
    const states: SessionState[] = [];
    const session = new CoeditSession({
      me: { key: "x", name: "X" },
      open: async () => ({ ok: false }),
      append: async () => ({ ok: false }),
      compact: async () => ({ ok: false }),
      room: async () => null,
      onChange: (s) => states.push(s),
    });
    await session.start();
    expect(states.at(-1)?.status).toBe("error");
    session.stop();
  });
});
