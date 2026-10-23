import * as Y from "yjs";

/**
 * One editor's live co-editing session (Section 5, ADR 0044), independent of React and the network
 * so it can be tested: a Yjs document loaded from the row's snapshot and updates, local edits
 * broadcast to the room for speed and appended to the database for recovery, remote edits applied
 * as they arrive, a resync after every rejoin, and a compaction once the person pauses, which folds
 * the updates into a snapshot and writes the text into the row.
 */

/** What the database hands an editor (app.open_doc). */
export interface OpenedDoc {
  readonly docId: string;
  readonly generation: number;
  readonly state: string | null;
  readonly throughSeq: number;
  readonly lastSeq: number;
  readonly seedText: string | null;
  readonly canEdit: boolean;
  readonly updates: readonly { readonly seq: number; readonly update: string }[];
}

export type Outcome<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly rule?: string };

export interface RoomLike {
  send(event: string, payload: Record<string, unknown>): Promise<boolean>;
  track(state: Record<string, unknown>): Promise<void>;
  leave(): void;
}

export interface RoomHandlers {
  onBroadcast(event: string, payload: Record<string, unknown>): void;
  onPresence(members: readonly Record<string, unknown>[]): void;
  onStatus(status: "joined" | "lost"): void;
}

export type SessionStatus = "loading" | "live" | "saving" | "offline" | "error";

export interface SessionState {
  readonly status: SessionStatus;
  readonly doc: Y.Doc | null;
  readonly generation: number;
  readonly canEdit: boolean;
  /** Names of the other people in the document right now (Realtime presence, never stored). */
  readonly editors: readonly string[];
}

export interface SessionDeps {
  open(since: number): Promise<Outcome<OpenedDoc>>;
  append(docId: string, generation: number, update: string): Promise<Outcome<number>>;
  compact(
    docId: string,
    generation: number,
    state: string,
    through: number,
    text: string,
  ): Promise<Outcome<{ compacted: boolean; throughSeq: number }>>;
  /** Joins the document's room, or null without a live connection (edits still save and resync). */
  room(docId: string, handlers: RoomHandlers): Promise<RoomLike | null>;
  readonly me: { readonly key: string; readonly name: string };
  onChange(state: SessionState): void;
  readonly timing?: {
    readonly flushMs?: number;
    readonly compactMs?: number;
    readonly resyncMs?: number;
  };
}

/** The XML fragment Tiptap's Collaboration extension edits. */
export const FIELD = "default";
const REMOTE = Symbol("remote");
const GENERATION_CHANGED = "coedit_generation_changed";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The update that seeds an empty document with a row's text, one paragraph per line. It is built
 * with a fixed client id, so every editor that seeds the same text produces the same update and
 * Yjs keeps one copy: two people opening an empty document at once never double its text.
 */
export function seedUpdate(text: string): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = 1;
  const fragment = seed.getXmlFragment(FIELD);
  seed.transact(() => {
    fragment.insert(
      0,
      text.split("\n").map((line) => {
        const paragraph = new Y.XmlElement("paragraph");
        if (line !== "") paragraph.insert(0, [new Y.XmlText(line)]);
        return paragraph;
      }),
    );
  });
  return Y.encodeStateAsUpdate(seed);
}

function textOf(node: Y.XmlText): string {
  return (node.toDelta() as { insert?: unknown }[])
    .map((op) => (typeof op.insert === "string" ? op.insert : ""))
    .join("");
}

function lines(node: Y.XmlElement | Y.XmlText): string[] {
  if (node instanceof Y.XmlText) return [textOf(node)];
  const children = node.toArray() as (Y.XmlElement | Y.XmlText)[];
  if (children.length === 0 || children.some((c) => c instanceof Y.XmlText)) {
    // A text block: its text, with a line break for each hard break inside it.
    return [
      children
        .map((c) => (c instanceof Y.XmlText ? textOf(c) : c.nodeName === "hardBreak" ? "\n" : ""))
        .join(""),
    ];
  }
  return children.flatMap(lines);
}

/** The document as plain text, one line per block, the form an SOP's procedure is stored in. */
export function docText(doc: Y.Doc): string {
  return (doc.getXmlFragment(FIELD).toArray() as (Y.XmlElement | Y.XmlText)[])
    .flatMap(lines)
    .join("\n");
}

function isEmpty(doc: Y.Doc): boolean {
  return doc.getXmlFragment(FIELD).length === 0;
}

export class CoeditSession {
  private doc: Y.Doc | null = null;
  private docId = "";
  private generation = 0;
  private canEdit = false;
  private seen = 0;
  private status: SessionStatus = "loading";
  private editors: readonly string[] = [];
  private room: RoomLike | null = null;
  private pending: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private wasJoined = false;
  private dirty = false;

  constructor(private readonly deps: SessionDeps) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.publish("loading");
    const opened = await this.deps.open(0);
    if (this.stopped) return;
    if (!opened.ok) {
      this.publish("error");
      return;
    }
    const d = opened.data;
    const doc = new Y.Doc();
    this.doc = doc;
    this.docId = d.docId;
    this.generation = d.generation;
    this.canEdit = d.canEdit;
    this.seen = 0;
    this.load(d);
    if (isEmpty(doc) && d.seedText) {
      const seed = seedUpdate(d.seedText);
      Y.applyUpdate(doc, seed, REMOTE);
      // The first editor stores the seed, so readers load it too; a second copy changes nothing.
      if (d.canEdit && d.updates.length === 0)
        void this.deps.append(d.docId, d.generation, toBase64(seed));
    }
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.canEdit) return;
      this.pending.push(update);
      this.dirty = true;
      this.schedule();
    });
    this.room = await this.deps.room(d.docId, {
      onBroadcast: (event, payload) => {
        if (event !== "update" || payload["g"] !== this.generation) return;
        if (typeof payload["u"] === "string" && this.doc) {
          Y.applyUpdate(this.doc, fromBase64(payload["u"]), REMOTE);
        }
      },
      onPresence: (members) => {
        this.editors = [
          ...new Set(
            members
              .filter((m) => m["key"] !== this.deps.me.key && typeof m["name"] === "string")
              .map((m) => String(m["name"])),
          ),
        ];
        this.publish(this.status);
      },
      onStatus: (status) => {
        if (status === "lost") {
          this.publish("offline");
          return;
        }
        if (this.wasJoined) void this.resync();
        this.wasJoined = true;
        this.publish("live");
      },
    });
    if (this.stopped) {
      this.room?.leave();
      return;
    }
    void this.room?.track({ key: this.deps.me.key, name: this.deps.me.name });
    // A slow pull covers a missed broadcast; without a room it is the only way edits arrive.
    this.resyncTimer = setInterval(
      () => void this.resync(),
      this.deps.timing?.resyncMs ?? (this.room ? 15_000 : 3_000),
    );
    this.publish("live");
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.compactTimer) clearTimeout(this.compactTimer);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.flushTimer = this.compactTimer = this.resyncTimer = null;
    if (this.pending.length > 0) void this.flush();
    this.room?.leave();
    this.room = null;
  }

  /** Folds what this editor knows into a snapshot now, for a page that is being left. */
  async settle(): Promise<void> {
    await this.flush();
    if (this.dirty) await this.compactNow();
  }

  private load(d: OpenedDoc): void {
    if (!this.doc) return;
    if (d.state) Y.applyUpdate(this.doc, fromBase64(d.state), REMOTE);
    for (const u of d.updates) Y.applyUpdate(this.doc, fromBase64(u.update), REMOTE);
    this.seen = Math.max(this.seen, d.throughSeq, ...d.updates.map((u) => u.seq));
  }

  private schedule(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.deps.timing?.flushMs ?? 100);
    }
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      void this.compactNow();
    }, this.deps.timing?.compactMs ?? 3_000);
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];
    const update = toBase64(merged);
    const generation = this.generation;
    this.publish("saving");
    void this.room?.send("update", { g: generation, u: update });
    const saved = await this.deps.append(this.docId, generation, update);
    if (this.stopped) return;
    if (saved.ok) {
      this.publish("live");
      return;
    }
    if (saved.rule === GENERATION_CHANGED) {
      await this.reload();
      return;
    }
    // Kept here and sent again with the next edit or the next resync.
    this.pending.unshift(merged);
    this.publish("offline");
  }

  /** Reads what this editor missed: the latest snapshot and the updates after what it has seen. */
  private async resync(): Promise<boolean> {
    if (!this.doc || this.stopped) return false;
    if (this.pending.length > 0) await this.flush();
    const opened = await this.deps.open(this.seen);
    if (!opened.ok || this.stopped) return false;
    if (opened.data.generation !== this.generation) {
      await this.reload();
      return false;
    }
    this.load(opened.data);
    return true;
  }

  private async compactNow(): Promise<void> {
    if (!this.canEdit || !this.doc) return;
    await this.flush();
    if (!(await this.resync()) || !this.doc) return;
    const done = await this.deps.compact(
      this.docId,
      this.generation,
      toBase64(Y.encodeStateAsUpdate(this.doc)),
      this.seen,
      docText(this.doc),
    );
    if (done.ok) this.dirty = false;
    else if (done.rule === GENERATION_CHANGED) await this.reload();
  }

  private async reload(): Promise<void> {
    // Edits made against the old generation cannot be merged into the new one.
    this.pending = [];
    this.stop();
    this.doc?.destroy();
    this.doc = null;
    await this.start();
  }

  private publish(status: SessionStatus): void {
    this.status = status;
    this.deps.onChange({
      status,
      doc: this.doc,
      generation: this.generation,
      canEdit: this.canEdit,
      editors: this.editors,
    });
  }
}
