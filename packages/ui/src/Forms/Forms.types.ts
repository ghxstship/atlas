import type {
  CheckboxProps as ReferenceCheckboxProps,
  CurrencyInputProps as ReferenceCurrencyInputProps,
  InputProps as ReferenceInputProps,
  MoneyProps as ReferenceMoneyProps,
  NumberInputProps as ReferenceNumberInputProps,
  RadioProps as ReferenceRadioProps,
  SelectProps as ReferenceSelectProps,
  SwitchProps as ReferenceSwitchProps,
  TextareaProps as ReferenceTextareaProps,
} from "../types/reference";

export type InputProps = ReferenceInputProps;

export type TextareaProps = ReferenceTextareaProps;

export type SelectProps = ReferenceSelectProps & { id?: string; name?: string };

export type CheckboxProps = ReferenceCheckboxProps;

export type SwitchProps = ReferenceSwitchProps;

export type RadioProps = ReferenceRadioProps;

export type NumberInputProps = ReferenceNumberInputProps & {
  id?: string;
  min?: number;
  max?: number;
};

export type CurrencyInputProps = ReferenceCurrencyInputProps;

export type MoneyProps = ReferenceMoneyProps;
