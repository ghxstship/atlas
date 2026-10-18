import type {
  ComboboxProps as ReferenceComboboxProps,
  DatePickerProps as ReferenceDatePickerProps,
  DateRangePickerProps as ReferenceDateRangePickerProps,
  FileDropProps as ReferenceFileDropProps,
  MultiSelectProps as ReferenceMultiSelectProps,
  Option,
  SliderProps as ReferenceSliderProps,
  TimePickerProps as ReferenceTimePickerProps,
} from "../types/reference";

export type ComboboxProps = ReferenceComboboxProps & { id?: string };

export type MultiSelectProps = ReferenceMultiSelectProps & { id?: string };

export type SliderProps = ReferenceSliderProps & { id?: string };

export type DatePickerProps = ReferenceDatePickerProps & { id?: string };

export type DateRangePickerProps = ReferenceDateRangePickerProps & { id?: string };

export type TimePickerProps = ReferenceTimePickerProps & { id?: string; name?: string };

export type FileDropProps = ReferenceFileDropProps & { id?: string };

export interface ListState {
  query: string;
  setQuery: (q: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  active: number;
  setActive: (n: number) => void;
  list: Option[];
}

export interface GridProps {
  year: number;
  month: number;
  focused: string;
  onFocusDate: (iso: string) => void;
  onPick: (iso: string) => void;
  mark: (iso: string) => "selected" | "edge" | "range" | "today" | null;
}
