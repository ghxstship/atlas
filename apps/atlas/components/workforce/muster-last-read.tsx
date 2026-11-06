"use client";

import { InlineAlert } from "@xos/ui";
import { useState, type ReactNode } from "react";

/**
 * Keeps the last muster list on screen when a refresh cannot read it (B8, G-149): an evacuation list must never turn
 * into an error panel because one 30-second read failed. It says the list is the last one read and, standing in the
 * same place, keeps its refresh running, so the next read that succeeds replaces it. A first read that fails has
 * nothing to keep and shows the fallback.
 */
export function MusterLastRead({
  failed,
  note,
  fallback,
  children,
}: {
  failed: boolean;
  note: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [kept, setKept] = useState<ReactNode>(failed ? null : children);
  if (!failed && kept !== children) setKept(children);
  if (failed && kept === null) return fallback;
  return (
    <>
      {failed ? <InlineAlert tone="warning">{note}</InlineAlert> : null}
      {failed ? kept : children}
    </>
  );
}
