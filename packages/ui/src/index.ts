/* @xos/ui public API. Component names and prop shapes follow the frozen reference contracts in
   src/types/reference.d.ts (design/xos-design-system/components/index.d.ts). */

export { cx } from "./lib/cx.ts";
export {
  configure,
  t,
  translate,
  catalogFor,
  flattenMessages,
  directionOf,
  type XOSConfig,
  type MessageVars,
  type Messages,
} from "./lib/i18n.ts";
export {
  XOSProvider,
  useLocale,
  useT,
  useFormat,
  type XOSProviderProps,
  type Translate,
} from "./lib/context.tsx";
export {
  applyTheme,
  resolveTheme,
  isThemePreference,
  themes,
  themePreferences,
  type Theme,
  type ThemePreference,
} from "./lib/theme.ts";
export * from "./lib/format.ts";

export type {
  RecordState,
  IconName,
  DepartmentCode,
  PhaseCode,
  RecordKind,
  Option,
} from "./types/reference";

/* Foundations */
export { Icon, type IconProps } from "./Icon/Icon.tsx";
export {
  glyphs,
  DepartmentGlyph,
  PhaseGlyph,
  RecordKindGlyph,
  type DepartmentGlyphProps,
  type PhaseGlyphProps,
  type RecordKindGlyphProps,
} from "./Glyphs/Glyphs.tsx";
export { StateIcon, type StateIconProps } from "./StateIcon/StateIcon.tsx";
export { Kbd, Keys, type KbdProps } from "./Kbd/Kbd.tsx";
export {
  Button,
  IconButton,
  buttonClass,
  iconButtonClass,
  type ButtonProps,
  type IconButtonProps,
} from "./Button/Button.tsx";
export { Link, type LinkProps } from "./Link/Link.tsx";
export {
  StateChip,
  PhaseChip,
  DepartmentChip,
  URIDChip,
  RecordKindChip,
  PropertyChip,
  Tag,
  Badge,
  chipClass,
  type StateChipProps,
  type PhaseChipProps,
  type DepartmentChipProps,
  type URIDChipProps,
  type RecordKindChipProps,
  type PropertyChipProps,
  type TagProps,
  type BadgeProps,
} from "./Chips/Chips.tsx";
export {
  Avatar,
  AvatarStack,
  initials,
  type AvatarProps,
  type AvatarStackProps,
} from "./Avatar/Avatar.tsx";
export { Field, controlClass, fieldClass, labelClass, type FieldProps } from "./Field/Field.tsx";
export {
  Input,
  Textarea,
  Select,
  Checkbox,
  Switch,
  Radio,
  NumberInput,
  CurrencyInput,
  Money,
  type InputProps,
  type TextareaProps,
  type SelectProps,
  type CheckboxProps,
  type SwitchProps,
  type RadioProps,
  type NumberInputProps,
  type CurrencyInputProps,
  type MoneyProps,
} from "./Forms/Forms.tsx";
export {
  Card,
  Divider,
  Skeleton,
  type CardProps,
  type DividerProps,
  type SkeletonProps,
} from "./Surface/Surface.tsx";
export {
  EmptyState,
  ErrorState,
  RefusalNotice,
  InlineAlert,
  Banner,
  Toast,
  UndoToast,
  ToastRegion,
  type EmptyStateProps,
  type ErrorStateProps,
  type RefusalNoticeProps,
  type InlineAlertProps,
  type BannerProps,
  type ToastProps,
  type UndoToastProps,
} from "./Feedback/Feedback.tsx";

/* Overlays and navigation */
export { useControllable, useHotkey, rovingIndex, type HotkeyOptions } from "./lib/hooks.ts";
export { BrandMark, monogram, type BrandMarkProps } from "./BrandMark/BrandMark.tsx";
export {
  Dialog,
  Drawer,
  SidePeek,
  ShortcutSheet,
  Popover,
  HoverCard,
  Tooltip,
  PropertyList,
  type OverlayControl,
  type DialogProps,
  type DrawerProps,
  type SidePeekProps,
  type ShortcutSheetProps,
  type PopoverProps,
  type HoverCardProps,
  type TooltipProps,
} from "./Overlays/Overlays.tsx";
export {
  DropdownMenu,
  ContextMenu,
  OrgSwitcher,
  type MenuItem,
  type DropdownMenuProps,
  type ContextMenuProps,
  type OrgSwitcherProps,
} from "./Menus/Menus.tsx";
export {
  CommandMenu,
  type CommandMenuProps,
  type CommandItem,
} from "./CommandMenu/CommandMenu.tsx";
export {
  Tabs,
  SegmentedControl,
  Accordion,
  Breadcrumbs,
  Pagination,
  Sidebar,
  TopNav,
  TabBar,
  type NavItem,
  type TabsProps,
  type SegmentedControlProps,
  type AccordionProps,
  type BreadcrumbsProps,
  type PaginationProps,
  type SidebarProps,
  type TopNavProps,
  type TabBarProps,
} from "./Navigation/Navigation.tsx";
