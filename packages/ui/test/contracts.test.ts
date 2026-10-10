import { describe, expect, it } from "vitest";
import type * as Ref from "../src/types/reference";
import * as Ui from "../src/index.ts";

/**
 * Type test against the frozen prop contracts (design handoff gate 9). `tsc --noEmit` checks it:
 * each production prop type must accept every reference usage (the reference props are assignable
 * to it) and keep the reference shape (it is assignable to the reference props), and each component
 * must be usable where the reference component is declared.
 */
type Same<Prod, Reference> = [Reference] extends [Prod]
  ? [Prod] extends [Reference]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
type Component<P> = (props: P) => unknown;
type Fits<C, Reference> = C extends Component<Reference> ? true : false;

export type PropContracts = [
  Assert<Same<Ui.ButtonProps, Ref.ButtonProps>>,
  Assert<Same<Ui.IconButtonProps, Ref.IconButtonProps>>,
  Assert<Same<Ui.KbdProps, Ref.KbdProps>>,
  Assert<Same<Ui.LinkProps, Ref.LinkProps>>,
  Assert<Same<Ui.IconProps, Ref.IconProps>>,
  Assert<Same<Ui.StateIconProps, Ref.StateIconProps>>,
  Assert<Same<Ui.DepartmentGlyphProps, Ref.DepartmentGlyphProps>>,
  Assert<Same<Ui.PhaseGlyphProps, Ref.PhaseGlyphProps>>,
  Assert<Same<Ui.RecordKindGlyphProps, Ref.RecordKindGlyphProps>>,
  Assert<Same<Ui.StateChipProps, Ref.StateChipProps>>,
  Assert<Same<Ui.PhaseChipProps, Ref.PhaseChipProps>>,
  Assert<Same<Ui.DepartmentChipProps, Ref.DepartmentChipProps>>,
  Assert<Same<Ui.URIDChipProps, Ref.URIDChipProps>>,
  Assert<Same<Ui.RecordKindChipProps, Ref.RecordKindChipProps>>,
  Assert<Same<Ui.PropertyChipProps, Ref.PropertyChipProps>>,
  Assert<Same<Ui.TagProps, Ref.TagProps>>,
  Assert<Same<Ui.BadgeProps, Ref.BadgeProps>>,
  Assert<Same<Ui.AvatarProps, Ref.AvatarProps>>,
  Assert<Same<Ui.AvatarStackProps, Ref.AvatarStackProps>>,
  Assert<Same<Ui.MoneyProps, Ref.MoneyProps>>,
  Assert<Same<Ui.InputProps, Ref.InputProps>>,
  Assert<Same<Ui.TextareaProps, Ref.TextareaProps>>,
  Assert<Same<Ui.CheckboxProps, Ref.CheckboxProps>>,
  Assert<Same<Ui.RadioProps, Ref.RadioProps>>,
  Assert<Same<Ui.SwitchProps, Ref.SwitchProps>>,
  Assert<Same<Ui.SelectProps, Ref.SelectProps>>,
  Assert<Same<Ui.NumberInputProps, Ref.NumberInputProps>>,
  Assert<Same<Ui.CurrencyInputProps, Ref.CurrencyInputProps>>,
  Assert<Same<Ui.DividerProps, Ref.DividerProps>>,
  Assert<Same<Ui.CardProps, Ref.CardProps>>,
  Assert<Same<Ui.SkeletonProps, Ref.SkeletonProps>>,
  Assert<Same<Ui.EmptyStateProps, Ref.EmptyStateProps>>,
  Assert<Same<Ui.ErrorStateProps, Ref.ErrorStateProps>>,
  Assert<Same<Ui.RefusalNoticeProps, Ref.RefusalNoticeProps>>,
  Assert<Same<Ui.InlineAlertProps, Ref.InlineAlertProps>>,
  Assert<Same<Ui.BannerProps, Ref.BannerProps>>,
  Assert<Same<Ui.ToastProps, Ref.ToastProps>>,
  Assert<Same<Ui.UndoToastProps, Ref.UndoToastProps>>,
];

export type ComponentContracts = [
  Assert<Fits<typeof Ui.Button, Ref.ButtonProps>>,
  Assert<Fits<typeof Ui.IconButton, Ref.IconButtonProps>>,
  Assert<Fits<typeof Ui.Kbd, Ref.KbdProps>>,
  Assert<Fits<typeof Ui.Link, Ref.LinkProps>>,
  Assert<Fits<typeof Ui.Icon, Ref.IconProps>>,
  Assert<Fits<typeof Ui.StateIcon, Ref.StateIconProps>>,
  Assert<Fits<typeof Ui.DepartmentGlyph, Ref.DepartmentGlyphProps>>,
  Assert<Fits<typeof Ui.PhaseGlyph, Ref.PhaseGlyphProps>>,
  Assert<Fits<typeof Ui.RecordKindGlyph, Ref.RecordKindGlyphProps>>,
  Assert<Fits<typeof Ui.StateChip, Ref.StateChipProps>>,
  Assert<Fits<typeof Ui.PhaseChip, Ref.PhaseChipProps>>,
  Assert<Fits<typeof Ui.DepartmentChip, Ref.DepartmentChipProps>>,
  Assert<Fits<typeof Ui.URIDChip, Ref.URIDChipProps>>,
  Assert<Fits<typeof Ui.RecordKindChip, Ref.RecordKindChipProps>>,
  Assert<Fits<typeof Ui.PropertyChip, Ref.PropertyChipProps>>,
  Assert<Fits<typeof Ui.Tag, Ref.TagProps>>,
  Assert<Fits<typeof Ui.Badge, Ref.BadgeProps>>,
  Assert<Fits<typeof Ui.Avatar, Ref.AvatarProps>>,
  Assert<Fits<typeof Ui.AvatarStack, Ref.AvatarStackProps>>,
  Assert<Fits<typeof Ui.Money, Ref.MoneyProps>>,
  Assert<Fits<typeof Ui.Input, Ref.InputProps>>,
  Assert<Fits<typeof Ui.Textarea, Ref.TextareaProps>>,
  Assert<Fits<typeof Ui.Checkbox, Ref.CheckboxProps>>,
  Assert<Fits<typeof Ui.Radio, Ref.RadioProps>>,
  Assert<Fits<typeof Ui.Switch, Ref.SwitchProps>>,
  Assert<Fits<typeof Ui.Select, Ref.SelectProps>>,
  Assert<Fits<typeof Ui.NumberInput, Ref.NumberInputProps>>,
  Assert<Fits<typeof Ui.CurrencyInput, Ref.CurrencyInputProps>>,
  Assert<Fits<typeof Ui.Divider, Ref.DividerProps>>,
  Assert<Fits<typeof Ui.Card, Ref.CardProps>>,
  Assert<Fits<typeof Ui.Skeleton, Ref.SkeletonProps>>,
  Assert<Fits<typeof Ui.EmptyState, Ref.EmptyStateProps>>,
  Assert<Fits<typeof Ui.ErrorState, Ref.ErrorStateProps>>,
  Assert<Fits<typeof Ui.RefusalNotice, Ref.RefusalNoticeProps>>,
  Assert<Fits<typeof Ui.InlineAlert, Ref.InlineAlertProps>>,
  Assert<Fits<typeof Ui.Banner, Ref.BannerProps>>,
  Assert<Fits<typeof Ui.Toast, Ref.ToastProps>>,
  Assert<Fits<typeof Ui.UndoToast, Ref.UndoToastProps>>,
];

describe("reference contracts", () => {
  it("exports every component the contract test covers", () => {
    const names = [
      "Button",
      "IconButton",
      "Kbd",
      "Link",
      "Icon",
      "StateIcon",
      "DepartmentGlyph",
      "PhaseGlyph",
      "RecordKindGlyph",
      "StateChip",
      "PhaseChip",
      "DepartmentChip",
      "URIDChip",
      "RecordKindChip",
      "PropertyChip",
      "Tag",
      "Badge",
      "Avatar",
      "AvatarStack",
      "Money",
      "Input",
      "Textarea",
      "Checkbox",
      "Radio",
      "Switch",
      "Select",
      "NumberInput",
      "CurrencyInput",
      "Divider",
      "Card",
      "Skeleton",
      "EmptyState",
      "ErrorState",
      "RefusalNotice",
      "InlineAlert",
      "Banner",
      "Toast",
      "UndoToast",
    ];
    const exported = Ui as unknown as Record<string, unknown>;
    expect(names.filter((n) => typeof exported[n] !== "function")).toEqual([]);
  });

  it("keeps the glyph map equal to the reference assignment", () => {
    expect(Ui.glyphs.departments["4000"]).toBe("Tent");
    expect(Ui.glyphs.phases.BLD).toBe("Hammer");
    expect(Ui.glyphs.recordKinds.Task).toBe("SquareCheck");
  });
});
