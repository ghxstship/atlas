/**
 * Data hooks of the identity settings screens (ADR 0070): the person's own rows kept on the device, and the state
 * of a change after it queues.
 */
import { OUTBOX_TABLE, type MutationInput, type Row } from "@xos/sync";
import { useCallback, useEffect, useState } from "react";
import { useCompass, useRows } from "../../runtime/CompassProvider";
import { mirrorRows, writeStateOf, type WriteState } from "../../settings/writes";

export interface Mirror<T extends Row> {
  readonly rows: T[];
  /** The device has rows to show, or the server answered (possibly with none). */
  readonly ready: boolean;
  /** Offline with nothing read yet: the section has never been opened online on this device. */
  readonly notLoaded: boolean;
  /** The last server read failed; the device rows, if any, still show. */
  readonly failed: boolean;
  readonly reload: () => void;
}

/**
 * A device-local table of the person's own rows: read from the server whenever the phone is online (replacing what
 * the device held, keeping rows a queued write still owns) and shown from the device at all times. `read` returns
 * the server rows, or null when the read failed; pass a stable function (useCallback), or null to read nothing.
 */
export function useMirror<T extends Row>(
  table: string,
  read: (() => Promise<readonly Row[] | null>) | null,
  filter?: (row: T) => boolean,
): Mirror<T> {
  const { store, engine, network } = useCompass();
  // Every org's screens show the person's own rows, so the active-org filter does not apply.
  const { rows, loading } = useRows<T>(table, filter, { allOrgs: true });
  const [server, setServer] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [attempt, setAttempt] = useState(0);
  const online = network.isConnected;

  useEffect(() => {
    if (!read || !store || !engine || !online) return undefined;
    let live = true;
    setServer("loading");
    void (async () => {
      const fresh = await read().catch(() => null);
      if (!live) return;
      if (fresh === null) {
        setServer("failed");
        return;
      }
      const queued = await engine.outbox.all();
      await store.transaction((tx) => {
        const next = mirrorRows(table, fresh, tx.list(table), queued);
        const keep = new Set(next.map((row) => row.id));
        for (const old of tx.list(table)) if (!keep.has(old.id)) tx.remove(table, old.id);
        for (const row of next) tx.put(table, row);
      });
      if (live) setServer("loaded");
    })();
    return () => {
      live = false;
    };
  }, [table, read, store, engine, online, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const ready = !loading && (rows.length > 0 || server === "loaded");
  return {
    rows,
    ready,
    notLoaded: !loading && !online && rows.length === 0 && server !== "loaded",
    failed: server === "failed",
    reload,
  };
}

export interface QueuedWrite {
  readonly state: WriteState;
  /** Queues the write (its optimistic row shows at once) and follows it until the server answers. */
  readonly save: (input: MutationInput) => Promise<void>;
  /** A save with nothing to change: the values on screen are already the saved ones. */
  readonly unchanged: () => void;
  readonly reset: () => void;
}

/** A change that queues in the offline outbox, and where it stands: sending, queued offline, saved or refused. */
export function useQueuedWrite(): QueuedWrite {
  const { enqueue, engine, store, network } = useCompass();
  const [state, setState] = useState<WriteState>({ kind: "idle" });
  const [id, setId] = useState<string | null>(null);
  const online = network.isConnected;

  useEffect(() => {
    if (!id || !engine || !store) return undefined;
    let live = true;
    const check = () =>
      void engine.outbox.get(id).then((mutation) => {
        if (live) setState(writeStateOf(mutation, online));
      });
    check();
    const stop = store.subscribe((table) => {
      if (table === OUTBOX_TABLE) check();
    });
    return () => {
      live = false;
      stop();
    };
  }, [id, engine, store, online]);

  const save = useCallback(
    async (input: MutationInput) => {
      setState({ kind: "sending" });
      try {
        setId(await enqueue(input));
      } catch (error: unknown) {
        setId(null);
        setState({
          kind: "refused",
          rule: null,
          code: "",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [enqueue],
  );
  const unchanged = useCallback(() => {
    setId(null);
    setState({ kind: "saved" });
  }, []);
  const reset = useCallback(() => {
    setId(null);
    setState({ kind: "idle" });
  }, []);
  return { state, save, unchanged, reset };
}
