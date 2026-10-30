"use client";

import { useSearchParams } from "next/navigation";
import { onDemand, useOnDemand } from "./on-demand";

/** The shell's peek (shell-peek.tsx) and the route matching it needs load with the first `?peek`. */
const shellPeek = onDemand(() => import("./shell-peek"));

/**
 * What every org page carries of the shell's `?peek={recordKey}` hook: it waits for the parameter
 * and only then fetches the peek, so a page opened without one loads none of it (ADR 0027).
 */
export function ShellPeekGate({ org }: { org: string }) {
  const wanted = useSearchParams().get("peek") !== null;
  const loaded = useOnDemand(shellPeek, wanted);
  return wanted && loaded ? <loaded.ShellPeek org={org} /> : null;
}
