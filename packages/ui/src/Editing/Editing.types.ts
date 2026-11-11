import type {
  ColorPickerProps as ReferenceColorPickerProps,
  DiffViewerProps as ReferenceDiffViewerProps,
  FilterBuilderProps as ReferenceFilterBuilderProps,
  QuickAddProps as ReferenceQuickAddProps,
} from "../types/reference";
import type { QuickAddCopy } from "./QuickAddChips.tsx";
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
  /** Sentences for chip names, the announcement and candidate lists, from the app's catalog. */
  copy?: QuickAddCopy;
  id?: string;
  disabled?: boolean;
};

/** One contrast check: the value against a fixed color, as the foreground or the background. */
export type ColorCheck = ReferenceColorPickerProps["checks"][number] & {
  /** A state drawn over the background (hover, pressed): `color` at `opacity`, composited first. */
  overlay?: { color: string; opacity: number };
};

export type ColorPickerProps = Omit<ReferenceColorPickerProps, "checks"> & {
  checks: ColorCheck[];
  /** Called with the value and whether it is a valid hex that passes every check. */
  onChange?: (value: string, savable: boolean) => void;
  disabled?: boolean;
  help?: string;
  /** A refusal from the server, shown under the checks. */
  error?: string;
  id?: string;
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
