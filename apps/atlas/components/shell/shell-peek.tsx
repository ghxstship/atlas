"use client";

import { useSearchParams } from "next/navigation";
import { onDemand, useOnDemand } from "./on-demand";

/**
 * The shell's global `?peek={recordKey}` hook (shell-peek-body.tsx) loads with the first URL that
 * carries a key, so a page opened without one downloads none of it (ADR 0027). A key handed over
 * before then waits in the handoff store (lib/shell/peek-handoff.ts).
 */
const body = onDemand(() => import("./shell-peek-body"));

export function ShellPeek({ org }: { org: string }) {
  const key = useSearchParams().get("peek");
  const loaded = useOnDemand(body, key !== null && key !== "");
  return loaded ? <loaded.ShellPeekBody org={org} /> : null;
}
