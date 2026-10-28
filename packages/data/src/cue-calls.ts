import { Constants, type Database } from "./database.types.ts";

/**
 * Department calls of a cue (app.cue_calls, Section 4.2 Show; ADR 0131): the departments come from the generated
 * app.cue_call_kind enum, never written out again, with one catalog slug each for copy keys and the `dept=` URL
 * parameter. Atlas reads this through @xos/data/show; Compass imports it alone.
 */

/** The department a cue call is given to (app.cue_call_kind). */
export type CueCallKind = Database["app"]["Enums"]["cue_call_kind"];

/** The departments, in enum order: the order a cue's calls are listed in. */
export const CUE_CALL_KINDS: readonly CueCallKind[] = Constants.app.Enums.cue_call_kind;

/** Catalog slug of each department, for copy keys and the `dept=` URL parameter. */
export const CUE_CALL_SLUGS: Readonly<Record<CueCallKind, string>> = {
  Audio: "audio",
  Lighting: "lighting",
  Video: "video",
  "Special Effects": "sfx",
  Stage: "stage",
};

export function isCueCallKind(value: unknown): value is CueCallKind {
  return typeof value === "string" && (CUE_CALL_KINDS as readonly string[]).includes(value);
}

/** The department a slug names, or null. */
export function cueCallKindOf(slug: string | null | undefined): CueCallKind | null {
  return CUE_CALL_KINDS.find((k) => CUE_CALL_SLUGS[k] === slug) ?? null;
}

/** A call as a list shows it: its department and instruction. */
export interface CueCallLine {
  readonly kind: CueCallKind;
  readonly instruction: string;
}

/**
 * A cue's calls in enum order, or only the chosen department's when one is chosen (the department filter in
 * Atlas and the "Your department" picker in Compass).
 */
export function callLines(
  calls: readonly CueCallLine[],
  department: CueCallKind | null,
): CueCallLine[] {
  return CUE_CALL_KINDS.flatMap((kind) =>
    department !== null && kind !== department
      ? []
      : calls.filter((c) => c.kind === kind).slice(0, 1),
  );
}
