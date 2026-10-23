import type { ReactNode } from "react";
import { unshownPeekKey } from "@/lib/shell/peek-handoff";
import { PeekHandoff } from "./peek-handoff";

/**
 * A collection's peek slot for the URL's `?peek` key: the page's own panel, or, when the page renders
 * none for the key (a stale link, a record key from elsewhere), PeekHandoff, so the shell's peek
 * opens the record the key names or says it cannot. Server and client collections both call it.
 */
export function collectionPeek(key: string | null | undefined, panel: ReactNode): ReactNode {
  const handOff = unshownPeekKey(key ?? null, panel);
  return handOff === null ? panel : <PeekHandoff recordKey={handOff} />;
}
