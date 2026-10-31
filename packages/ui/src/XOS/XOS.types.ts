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
  RecordState,
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

export type RunOfShowLiveProps = ReferenceRunOfShowLiveProps & {
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

/** One row of a StatusHeatmap: a recipient, a person or a party. */
export interface StatusHeatmapRow {
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string;
}

/** One column of a StatusHeatmap: a section, a category or an offering. */
export interface StatusHeatmapCol {
  readonly id: string;
  readonly label: string;
}

/** A state the heatmap can show: the key cells name, the icon that carries it and its label. */
export interface StatusHeatmapLegendItem {
  readonly state: string;
  readonly icon: RecordState;
  readonly label: string;
}

/** One cell, keyed `<row id>:<col id>` in `cells`. A row and column with no cell is not asked. */
export interface StatusHeatmapCell {
  /** A `state` of the legend. */
  readonly state: string;
  /** Where Enter or a click goes. */
  readonly href?: string;
  /** More about the cell, read after its state (a count, a date). */
  readonly detail?: string;
}

export interface StatusHeatmapProps {
  readonly label: string;
  /** The header of the row column. */
  readonly corner: string;
  readonly rows: readonly StatusHeatmapRow[];
  readonly cols: readonly StatusHeatmapCol[];
  readonly cells: Readonly<Record<string, StatusHeatmapCell>>;
  readonly legend: readonly StatusHeatmapLegendItem[];
  /** Rows that can be selected, for a bulk action: the ids selected and a change handler. */
  readonly selection?: {
    readonly selected: readonly string[];
    readonly onChange: (selected: string[]) => void;
  };
  /** Called on Enter, Space or a click on a cell; without it, a cell with an href follows its link. */
  readonly onCellSelect?: (rowId: string, colId: string, cell: StatusHeatmapCell) => void;
}
