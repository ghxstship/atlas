import type { ReactElement } from "react";
import {
  departmentCodes,
  departmentIcon,
  phaseCodes,
  phaseIcon,
  recordKindIcon,
  recordKinds,
} from "@xos/icons";
import type {
  DepartmentCode,
  DepartmentGlyphProps as ReferenceDepartmentGlyphProps,
  PhaseCode,
  PhaseGlyphProps as ReferencePhaseGlyphProps,
  RecordKind,
  RecordKindGlyphProps as ReferenceRecordKindGlyphProps,
} from "../types/reference";
import { Icon } from "../Icon/Icon.tsx";

export type DepartmentGlyphProps = ReferenceDepartmentGlyphProps;
export type PhaseGlyphProps = ReferencePhaseGlyphProps;
export type RecordKindGlyphProps = ReferenceRecordKindGlyphProps;

/** The XOS glyph map (canon code to Lucide name), from @xos/icons so the assignment lives in one place. */
export const glyphs: {
  departments: Record<DepartmentCode, string>;
  phases: Record<PhaseCode, string>;
  recordKinds: Record<RecordKind, string>;
} = {
  departments: Object.fromEntries(departmentCodes.map((c) => [c, departmentIcon(c)])) as Record<
    DepartmentCode,
    string
  >,
  phases: Object.fromEntries(phaseCodes.map((c) => [c, phaseIcon(c)])) as Record<PhaseCode, string>,
  recordKinds: Object.fromEntries(recordKinds.map((k) => [k, recordKindIcon(k)])) as Record<
    RecordKind,
    string
  >,
};

function glyphProps(
  size: number | undefined,
  label: string | undefined,
  color: string | undefined,
) {
  return {
    ...(size === undefined ? {} : { size }),
    ...(label === undefined ? {} : { label }),
    ...(color === undefined ? {} : { color }),
  };
}

/** Department glyph (`4000` Environment is Tent). Sits beside the plain name; never alone. */
export function DepartmentGlyph({ code, size, label, color }: DepartmentGlyphProps): ReactElement {
  return <Icon name={glyphs.departments[code] ?? "Circle"} {...glyphProps(size, label, color)} />;
}

/** Phase glyph (`BLD` Build is Hammer). */
export function PhaseGlyph({ code, size, label, color }: PhaseGlyphProps): ReactElement {
  return <Icon name={glyphs.phases[code] ?? "Circle"} {...glyphProps(size, label, color)} />;
}

/** Record kind glyph (`Task` is SquareCheck). */
export function RecordKindGlyph({ kind, size, label, color }: RecordKindGlyphProps): ReactElement {
  return <Icon name={glyphs.recordKinds[kind] ?? "Circle"} {...glyphProps(size, label, color)} />;
}
