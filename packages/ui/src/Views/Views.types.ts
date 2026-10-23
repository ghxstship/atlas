import type {
  ActivityFeedItemProps as ReferenceActivityFeedItemProps,
  BoardProps as ReferenceBoardProps,
  BulkActionBarProps as ReferenceBulkActionBarProps,
  RecordListProps as ReferenceRecordListProps,
  RecordRowProps as ReferenceRecordRowProps,
  RecordState,
  StatTileProps as ReferenceStatTileProps,
  TreeNode as ReferenceTreeNode,
  TreeViewProps as ReferenceTreeViewProps,
} from "../types/reference";

export type RecordRowProps = ReferenceRecordRowProps & {
  /** X toggles selection of the focused row. */
  onSelect?: () => void;
  /** Enter opens the record. */
  onOpen?: () => void;
};

export type RecordListProps = ReferenceRecordListProps;

export type BoardProps = ReferenceBoardProps & {
  /** Called after a card moves to another column by drag or keyboard. */
  onMove?: (cardKey: string, from: RecordState, to: RecordState) => void;
  onAdd?: (state: RecordState) => void;
  onOpen?: (cardKey: string) => void;
};

export interface TreeNode extends ReferenceTreeNode {
  children?: TreeNode[];
  /** Stable id; the label path by default. */
  id?: string;
}

export type TreeViewProps = Omit<ReferenceTreeViewProps, "nodes"> & {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
};

export type BulkActionBarProps = Omit<ReferenceBulkActionBarProps, "actions"> & {
  actions: { label: string; icon?: string; shortcut?: string; onSelect?: () => void }[];
  onClear?: () => void;
  /** Shows the overflow button, which calls it; without it the button is left out. */
  onMore?: () => void;
  /**
   * Announces the count as it changes; true by default. Pass false when the selection already
   * announces it (a selectable DataTable does), so screen readers hear it once.
   */
  announce?: boolean;
};

export type ActivityFeedItemProps = ReferenceActivityFeedItemProps & {
  onReact?: (label: string) => void;
};

export type StatTileProps = ReferenceStatTileProps & {
  onDrill?: () => void;
  /** Recent values drawn as a sparkline; blanks are gaps. */
  trend?: (number | null)[];
};

export type Card = ReferenceBoardProps["columns"][number]["cards"][number];

export interface FlatNode {
  node: TreeNode;
  id: string;
  depth: number;
  parent: string | null;
  hasChildren: boolean;
}
