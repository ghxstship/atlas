"use client";

import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { PresenceMe, PresenceTable } from "./presence";

/** The channel and the avatars load after the page, never with it (ADR 0027). */
const roomModule = onDemand(() => import("./presence-room"));

/**
 * Who else is viewing this record, peek or document right now (Section 11.7, ADR 0083), as an
 * avatar stack. Pages render it with the row's table and id and the viewer; it shows nothing until
 * someone else who can read the row is there.
 */
export function RecordPresence({
  table,
  id,
  me,
}: {
  table: PresenceTable;
  id: string;
  me: PresenceMe;
}) {
  const loaded = useOnDemand(roomModule, true);
  return loaded ? <loaded.PresenceRoom table={table} id={id} me={me} /> : null;
}
