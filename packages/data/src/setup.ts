/**
 * Event bands and setup completeness (B14, migrations 3030 to 3032), without the generated database types, so the
 * browser components that show them (the intake wizard, the Gates tab, the Setup card) carry only these few lines.
 * The literals match app.event_scale, app.event_audience and app.document_requirement; test/b14 checks them against
 * the generated Constants.
 */

/** Scale bands in order: Intimate up to 500 people, then 2,500, 10,000, 50,000 and over (each includes its top). */
export const EVENT_SCALES = ["Intimate", "Small", "Medium", "Large", "Major"] as const;
/** Audience bands in order. */
export const EVENT_AUDIENCES = ["Public Ticketed", "Public Free", "Invite Only", "Trade", "Internal"] as const;

export type EventScale = (typeof EVENT_SCALES)[number];
export type EventAudience = (typeof EVENT_AUDIENCES)[number];
export type DocumentRequirement = "Required" | "Recommended";

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
