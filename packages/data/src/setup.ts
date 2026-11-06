import type { Database } from "./database.types.ts";

/**
 * Event bands and setup completeness (B14, migrations 3030 to 3032), without the generated Constants, so the browser
 * components that show them (the intake wizard, the Gates tab, the Setup card) carry only these few lines. The types
 * are the database's; each list is written once as the keys of an object the type holds exhaustive, and test/b14 checks
 * it against the generated Constants, order included.
 */

export type EventScale = Database["app"]["Enums"]["event_scale"];
export type EventAudience = Database["app"]["Enums"]["event_audience"];
export type DocumentRequirement = Database["app"]["Enums"]["document_requirement"];

/** One enum's values in display order, as z.enum takes them. A value the database adds fails to compile at the call. */
export function enumValues<T extends string>(values: Record<T, true>): readonly [T, ...T[]] {
  return Object.keys(values) as [T, ...T[]];
}

/** Scale bands in order: Intimate up to 500 people, then 2,500, 10,000, 50,000 and over (each includes its top). */
export const EVENT_SCALES = enumValues<EventScale>({
  Intimate: true,
  Small: true,
  Medium: true,
  Large: true,
  Major: true,
});
/** Audience bands in order. */
export const EVENT_AUDIENCES = enumValues<EventAudience>({
  "Public Ticketed": true,
  "Public Free": true,
  "Invite Only": true,
  Trade: true,
  Internal: true,
});
export const DOCUMENT_REQUIREMENTS = enumValues<DocumentRequirement>({
  Required: true,
  Recommended: true,
});

export interface SetupItem {
  readonly kind: "Document" | "Field";
  /** The requirement row: a document requirement or an event type field. */
  readonly requirementId: string;
  readonly documentTypeId: string | null;
  readonly customFieldDefinitionId: string | null;
  readonly label: string;
  readonly requirement: DocumentRequirement;
  readonly requiredByGate: number;
  /** Documents only: live typed documents with a version the viewer sees. */
  readonly documentsCount: number | null;
  readonly satisfied: boolean;
}

/** How many Required and Recommended items are met, for the progress strips and the Setup card. */
export function summarizeSetup(items: readonly SetupItem[], kind?: SetupItem["kind"]) {
  const of = (requirement: DocumentRequirement) => {
    const rows = items.filter(
      (i) => i.requirement === requirement && (kind === undefined || i.kind === kind),
    );
    return { met: rows.filter((i) => i.satisfied).length, total: rows.length };
  };
  return { required: of("Required"), recommended: of("Recommended") };
}

/** The items a gate still needs: Required ones due at or before it that are not met (3032's rule). */
export function unmetForGate(items: readonly SetupItem[], gate: number): SetupItem[] {
  return items.filter(
    (i) => i.requirement === "Required" && i.requiredByGate <= gate && !i.satisfied,
  );
}
