import type {
  BadgeProps as ReferenceBadgeProps,
  DepartmentChipProps as ReferenceDepartmentChipProps,
  PhaseChipProps as ReferencePhaseChipProps,
  PropertyChipProps as ReferencePropertyChipProps,
  RecordKindChipProps as ReferenceRecordKindChipProps,
  StateChipProps as ReferenceStateChipProps,
  TagProps as ReferenceTagProps,
  URIDChipProps as ReferenceURIDChipProps,
} from "../types/reference";

export type StateChipProps = ReferenceStateChipProps;

export type PhaseChipProps = ReferencePhaseChipProps;

export type DepartmentChipProps = ReferenceDepartmentChipProps;

export type URIDChipProps = ReferenceURIDChipProps;

export type RecordKindChipProps = ReferenceRecordKindChipProps;

export type PropertyChipProps = ReferencePropertyChipProps;

/** One of the seven themed categorical colours (color.viz.cat-1..7), as a Tag's dot (ADR 0142). */
export type TagSwatch = "cat-1" | "cat-2" | "cat-3" | "cat-4" | "cat-5" | "cat-6" | "cat-7";

export type TagProps = ReferenceTagProps & {
  /**
   * A categorical colour for the dot instead of the tone's, for user-defined choices and segments. The label
   * always shows beside it, so colour is never the only signal.
   */
  swatch?: TagSwatch;
};

export type BadgeProps = ReferenceBadgeProps & { className?: string };
