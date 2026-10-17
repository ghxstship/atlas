import map from "./map.json" with { type: "json" };

/**
 * XOS glyph map (design handoff, section 2): the lucide-react icon for each department, phase and
 * record kind, keyed by canon code, and the shape each record state draws. src/map.json is the
 * single source; every Lucide name in it resolves in the pinned lucide-react.
 */

export type DepartmentCode = keyof typeof map.departments;
export type PhaseCode = keyof typeof map.phases;
export type RecordKind = keyof typeof map.recordKinds;
export type RecordState = keyof typeof map.stateIcons;

/** A Lucide component name used by an XOS glyph, in PascalCase (`Hammer`). */
export type GlyphIconName =
  | (typeof map.departments)[DepartmentCode]
  | (typeof map.phases)[PhaseCode]
  | (typeof map.recordKinds)[RecordKind];

/** The shape a record state icon draws. State icons are custom (StateIcon), not Lucide. */
export type StateGlyph = (typeof map.stateIcons)[RecordState];

/** Icon library facts the glyphs are drawn with: package, pinned version, license and stroke width. */
export const iconLibrary: Readonly<typeof map.library> = map.library;

export const departmentCodes = Object.keys(map.departments) as DepartmentCode[];
export const phaseCodes = Object.keys(map.phases) as PhaseCode[];
export const recordKinds = Object.keys(map.recordKinds) as RecordKind[];
export const recordStates = Object.keys(map.stateIcons) as RecordState[];

function has<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key);
}

export function isDepartmentCode(value: string): value is DepartmentCode {
  return has(map.departments, value);
}

export function isPhaseCode(value: string): value is PhaseCode {
  return has(map.phases, value);
}

export function isRecordKind(value: string): value is RecordKind {
  return has(map.recordKinds, value);
}

export function isRecordState(value: string): value is RecordState {
  return has(map.stateIcons, value);
}

/** Lucide icon for a department code (`"4000"` is Tent). */
export function departmentIcon(code: DepartmentCode): GlyphIconName {
  return map.departments[code];
}

/** Lucide icon for a phase code (`"BLD"` is Hammer). */
export function phaseIcon(code: PhaseCode): GlyphIconName {
  return map.phases[code];
}

/** Lucide icon for a record kind (`"Task"` is SquareCheck). */
export function recordKindIcon(kind: RecordKind): GlyphIconName {
  return map.recordKinds[kind];
}

/** Shape drawn by the record state icon (`"blocked"` is an octagon). */
export function stateGlyph(state: RecordState): StateGlyph {
  return map.stateIcons[state];
}

/** Every distinct Lucide name the glyph map uses, sorted. */
export const glyphIconNames: readonly GlyphIconName[] = [
  ...new Set<GlyphIconName>([
    ...Object.values(map.departments),
    ...Object.values(map.phases),
    ...Object.values(map.recordKinds),
  ]),
].sort();
