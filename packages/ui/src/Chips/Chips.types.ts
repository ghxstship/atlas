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

export type TagProps = ReferenceTagProps;

export type BadgeProps = ReferenceBadgeProps & { className?: string };
