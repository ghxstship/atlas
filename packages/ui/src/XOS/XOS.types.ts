import type {
  AccessGridMatrixProps as ReferenceAccessGridMatrixProps,
  AssertionRankBadgeProps as ReferenceAssertionRankBadgeProps,
  CoordinateMatrixProps as ReferenceCoordinateMatrixProps,
  EmergencyCodeCardProps as ReferenceEmergencyCodeCardProps,
  GateReadinessPanelProps as ReferenceGateReadinessPanelProps,
  ProvenanceBadgeProps as ReferenceProvenanceBadgeProps,
  RadioChannelTableProps as ReferenceRadioChannelTableProps,
  ReconciliationTableProps as ReferenceReconciliationTableProps,
  RunOfShowLiveProps as ReferenceRunOfShowLiveProps,
  StalenessIndicatorProps as ReferenceStalenessIndicatorProps,
} from "../types/reference";

export type GateReadinessPanelProps = ReferenceGateReadinessPanelProps & {
  onAdvance?: () => void;
  onCriterionAction?: (code: string | undefined, label: string) => void;
};

export type ProvenanceBadgeProps = ReferenceProvenanceBadgeProps;

export type AssertionRankBadgeProps = ReferenceAssertionRankBadgeProps;

export type StalenessIndicatorProps = ReferenceStalenessIndicatorProps;

export type ReconciliationTableProps = ReferenceReconciliationTableProps;

export type EmergencyCodeCardProps = ReferenceEmergencyCodeCardProps;

export type RadioChannelTableProps = ReferenceRadioChannelTableProps;

export type RunOfShowLiveProps = Omit<ReferenceRunOfShowLiveProps, "cues"> & {
  /**
   * The reference cues, each with an optional status the index alone cannot show (ADR 0131): a cue the caller
   * jumped past is `skipped`, the cue they put on standby is `standby`.
   */
  cues: (ReferenceRunOfShowLiveProps["cues"][number] & { status?: "skipped" | "standby" })[];
  /** Called with the new live cue index when Go advances. */
  onGo?: (index: number) => void;
};

export type CoordinateMatrixProps = ReferenceCoordinateMatrixProps & {
  onCellSelect?: (department: string, phase: string) => void;
};

export type AccessGridMatrixProps = ReferenceAccessGridMatrixProps & {
  onChange?: (grants: string[]) => void;
};

export type Result = "met" | "gap" | "unknown";
