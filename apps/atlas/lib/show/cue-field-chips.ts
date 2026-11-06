import type { SegmentColor } from "@xos/data/show";
import {
  formatCustomFieldValue,
  type CustomFieldFormatContext,
} from "@/components/custom-fields/format";
import type { CustomField, CustomFieldValue } from "@/lib/custom-fields/types";

/** A cue's custom field chip in the running order: a Crew-audience field and its value (ADR 0142). */
export interface CueFieldChip {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly colorKey: SegmentColor | null;
}

/** The chips of each cue, in the order of `crew`: each field the cue has a value for, its choice's color kept. */
export function cueFieldChips(
  crew: readonly CustomField[],
  values: ReadonlyMap<string, Readonly<Record<string, CustomFieldValue>>>,
  context: CustomFieldFormatContext,
): Record<string, CueFieldChip[]> {
  const out: Record<string, CueFieldChip[]> = {};
  for (const [cueId, byKey] of values) {
    out[cueId] = crew.flatMap((field) => {
      const value = byKey[field.key];
      if (!value) return [];
      const choice =
        value.type === "Choice" ? field.choices.find((c) => c.id === value.choiceId) : undefined;
      return [
        {
          key: field.key,
          label: field.label,
          text: formatCustomFieldValue(field, value, context),
          colorKey: (choice?.colorKey ?? null) as SegmentColor | null,
        },
      ];
    });
  }
  return out;
}
