import type {
  ColorPickerProps as ReferenceColorPickerProps,
  DiffViewerProps as ReferenceDiffViewerProps,
  FilterBuilderProps as ReferenceFilterBuilderProps,
  QuickAddProps as ReferenceQuickAddProps,
} from "../types/reference";
import type { QuickAddResolver, QuickAddResult, QuickAddTokenType } from "./quickAddCore.ts";

export type Filter = ReferenceFilterBuilderProps["filters"][number];

export type FilterBuilderProps = ReferenceFilterBuilderProps & {
  onChange?: (filters: Filter[]) => void;
  onAdd?: () => void;
  onSave?: (filters: Filter[]) => void;
  /** Opens the editor for one filter chip. */
  onEdit?: (filter: Filter, index: number) => void;
};

export type QuickAddProps = ReferenceQuickAddProps & {
  /**
   * Called with the line to save on Enter. The field clears afterwards unless it returns (or resolves
   * to) false, for example when the save failed. Without it the field is a preview and chips cannot be
   * removed.
   */
  onSubmit?: (parsed: QuickAddResult) => unknown;
  /** Reference date for relative phrases such as tomorrow; now by default. */
  referenceDate?: Date;
  /** The language date phrases are read in (Spanish for `es-*`); the provider's locale by default. */
  locale?: string;
  /** The IANA zone date phrases are read in, such as the org's; the device's by default. */
  timeZone?: string;
  /** Resolves people, tags, kinds and scopes to what the person may see; unresolved tokens stay text. */
  resolve?: QuickAddResolver;
  /** What each kind of token sets, for chip names and the announcement, such as Owner or Due. */
  labels?: Partial<Record<QuickAddTokenType, string>>;
  id?: string;
  disabled?: boolean;
};

export type ColorPickerProps = ReferenceColorPickerProps & {
  /** Called with the value and whether it is a valid hex that passes every check. */
  onChange?: (value: string, savable: boolean) => void;
};

export type DiffViewerProps = ReferenceDiffViewerProps;

export type {
  QuickAddCandidate,
  QuickAddParse,
  QuickAddResolution,
  QuickAddResolver,
  QuickAddResult,
  QuickAddSpan,
  QuickAddToken,
  QuickAddTokenType,
} from "./quickAddCore.ts";
