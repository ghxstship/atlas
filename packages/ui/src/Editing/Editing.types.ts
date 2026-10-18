import type {
  ColorPickerProps as ReferenceColorPickerProps,
  DiffViewerProps as ReferenceDiffViewerProps,
  FilterBuilderProps as ReferenceFilterBuilderProps,
  QuickAddProps as ReferenceQuickAddProps,
} from "../types/reference";

export type Filter = ReferenceFilterBuilderProps["filters"][number];

export type FilterBuilderProps = ReferenceFilterBuilderProps & {
  onChange?: (filters: Filter[]) => void;
  onAdd?: () => void;
  onSave?: (filters: Filter[]) => void;
  /** Opens the editor for one filter chip. */
  onEdit?: (filter: Filter, index: number) => void;
};

export type QuickAddProps = ReferenceQuickAddProps & {
  onSubmit?: (parsed: QuickAddResult) => void;
  /** Reference date for relative phrases such as tomorrow; now by default. */
  referenceDate?: Date;
};

export type ColorPickerProps = ReferenceColorPickerProps & {
  /** Called with the value and whether it is a valid hex that passes every check. */
  onChange?: (value: string, savable: boolean) => void;
};

export type DiffViewerProps = ReferenceDiffViewerProps;

export interface QuickAddToken {
  type: "person" | "tag" | "kind" | "scope" | "date";
  value: string;
  icon: string;
  /** For dates: the parsed day as an ISO date. */
  iso?: string;
}

export interface QuickAddResult {
  title: string;
  tokens: QuickAddToken[];
}
