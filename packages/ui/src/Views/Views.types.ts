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
import type { ItemSelection } from "../lib/selection.ts";

/**
 * Right-click, Shift+F10 or the Context Menu key on an item (Section 11.7): its id, the pointer's
 * point (null from the keyboard, when the menu opens at the item) and the element it opened on.
 */
export type ItemContextMenu = (
  id: string,
  at: { x: number; y: number } | null,
  element: HTMLElement,
) => void;

export type RecordRowProps = ReferenceRecordRowProps & {
  /**
   * The row's id: its list selects it and opens its menu by this id, and hover cards find it
   * (`data-item`). Rows of a selectable list need one.
   */
  id?: string;
  /** X toggles selection of the focused row, when its list has no selection of its own. */
  onSelect?: () => void;
  /** Enter opens the record. */
  onOpen?: () => void;
};

export type RecordListProps = ReferenceRecordListProps & {
  /** Rows can be selected by id; each row needs an `id`. See useItemSelection. */
  selection?: ItemSelection;
  onItemContextMenu?: ItemContextMenu;
};

type ReferenceColumn = ReferenceBoardProps["columns"][number];

export type BoardProps = Omit<ReferenceBoardProps, "columns"> & {
  columns: (Omit<ReferenceColumn, "cards"> & {
    /** A card's `id` is how the selection and menus name it; its key by default. */
    cards: (ReferenceColumn["cards"][number] & { id?: string })[];
  })[];
  /** Cards can be selected by id. See useItemSelection. */
  selection?: ItemSelection;
  onItemContextMenu?: ItemContextMenu;
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

export type Card = BoardProps["columns"][number]["cards"][number];

export interface FlatNode {
  node: TreeNode;
  id: string;
  depth: number;
  parent: string | null;
  hasChildren: boolean;
}
