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
  PreferencesProvider,
  useLocale,
  useT,
  useFormat,
  usePreferences,
  useUnitSystem,
  useViewerTimeZone,
  useZonedTime,
  type XOSProviderProps,
  type Translate,
} from "./lib/context.tsx";
export * from "./lib/preferences.ts";
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
export {
  LiveProvider,
  useLive,
  type LiveChange,
  type LivePacing,
  type LiveSource,
  type LiveTopic,
} from "./lib/live.ts";

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
export {
  useControllable,
  useHotkey,
  rovingIndex,
  rememberOverlayOpener,
  type HotkeyOptions,
} from "./lib/hooks.ts";
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
  orgSwitcherTriggerClass,
  compactChevronClass,
  compactLabelClass,
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
  MoreFields,
  type MoreFieldsProps,
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

/* Layout and templates */
export {
  AppShell,
  PageHeader,
  ResizablePanel,
  ScrollRegion,
  Stepper,
  SplitView,
  type AppShellProps,
  type PageHeaderProps,
  type ResizablePanelProps,
  type ScrollRegionProps,
  type StepperProps,
  type SplitViewProps,
} from "./Layout/Layout.tsx";
export {
  TemplateCollection,
  TemplateRecord,
  TemplateSplitView,
  TemplateDashboard,
  TemplateSettings,
  TemplateWizard,
  TemplateGridEditor,
  TemplateDocument,
  TemplateAuth,
  TemplateGatewayShell,
  TemplateSystem,
  type TemplateCollectionProps,
  type TemplateRecordProps,
  type TemplateSplitViewProps,
  type TemplateDashboardProps,
  type TemplateSettingsProps,
  type TemplateWizardProps,
  type TemplateGridEditorProps,
  type TemplateDocumentProps,
  type TemplateAuthProps,
  type TemplateGatewayShellProps,
  type TemplateSystemProps,
} from "./Templates/Templates.tsx";

/* Data components */
export {
  DataTable,
  type DataTableProps,
  type DataTableColumn,
  type DataTableSelection,
} from "./DataTable/DataTable.tsx";
export { useItemSelection, type ItemSelection, type ItemSelect } from "./lib/selection.ts";
export {
  RecordRow,
  RecordList,
  Board,
  TreeView,
  BulkActionBar,
  ActivityFeedItem,
  StatTile,
  type RecordRowProps,
  type RecordListProps,
  type ItemContextMenu,
  type BoardProps,
  type TreeNode,
  type TreeViewProps,
  type BulkActionBarProps,
  type ActivityFeedItemProps,
  type StatTileProps,
} from "./Views/Views.tsx";

/* XOS components */
export {
  GateReadinessPanel,
  ProvenanceBadge,
  AssertionRankBadge,
  StalenessIndicator,
  ReconciliationTable,
  EmergencyCodeCard,
  RadioChannelTable,
  RunOfShowLive,
  CoordinateMatrix,
  AccessGridMatrix,
  resolveStep,
  type GateReadinessPanelProps,
  type ProvenanceBadgeProps,
  type AssertionRankBadgeProps,
  type StalenessIndicatorProps,
  type ReconciliationTableProps,
  type EmergencyCodeCardProps,
  type RadioChannelTableProps,
  type RunOfShowLiveProps,
  type CoordinateMatrixProps,
  type AccessGridMatrixProps,
} from "./XOS/XOS.tsx";
export type { EmergencyAuthority, GLAccount, GridColumn, BudgetLine } from "./types/reference";

/* Compass components on the web */
export {
  ClockButton,
  ScanSheet,
  OfflineBanner,
  QuickIncidentSheet,
  ChecklistRunner,
  ShiftCard,
  DaySheetView,
  SignaturePad,
  PhotoCapture,
  LiveActivity,
  ForceUpdateScreen,
  SyncConflictSheet,
  type ClockButtonProps,
  type ScanSheetProps,
  type OfflineBannerProps,
  type QuickIncidentSheetProps,
  type ChecklistRunnerProps,
  type ShiftCardProps,
  type DaySheetViewProps,
  type SignaturePadProps,
  type PhotoCaptureProps,
  type LiveActivityProps,
  type ForceUpdateScreenProps,
  type SyncConflictSheetProps,
} from "./Compass/Compass.tsx";

/* Gateway components */
export {
  ProgressBar,
  OpportunityCard,
  OpportunityFilters,
  ApplicationForm,
  AgencySlate,
  ProfileEditor,
  EPKViewer,
  AvailabilityCalendar,
  OnboardingPacket,
  EngagementTimeline,
  RatingDialog,
  PayoutDetailsForm,
  PaymentTracker,
  UpNextCard,
  type ProgressBarProps,
  type OpportunityCardProps,
  type OpportunityFiltersProps,
  type ApplicationFormProps,
  type AgencySlateProps,
  type ProfileEditorProps,
  type EPKViewerProps,
  type AvailabilityCalendarProps,
  type OnboardingPacketProps,
  type EngagementTimelineProps,
  type RatingDialogProps,
  type PayoutDetailsFormProps,
  type PaymentTrackerProps,
  type UpNextCardProps,
} from "./Gateway/Gateway.tsx";

/* Pickers */
export {
  Combobox,
  MultiSelect,
  Slider,
  DatePicker,
  DateRangePicker,
  TimePicker,
  FileDrop,
  rankOptions,
  type ComboboxProps,
  type MultiSelectProps,
  type SliderProps,
  type DatePickerProps,
  type DateRangePickerProps,
  type TimePickerProps,
  type FileDropProps,
} from "./Pickers/Pickers.tsx";

/* Identity and white label */
export {
  PresenceIndicator,
  QRCode,
  CredentialBadge,
  BrandSlot,
  WhiteLabelPreview,
  qrPath,
  tokenVariable,
  type PresenceIndicatorProps,
  type QRCodeProps,
  type CredentialBadgeProps,
  type BrandSlotProps,
  type WhiteLabelPreviewProps,
} from "./Identity/Identity.tsx";

/* Feedback and help */
export {
  NotificationCenter,
  OnboardingChecklist,
  WhatsNew,
  FeedbackWidget,
  ShortcutEditor,
  HelpPanel,
  type NotificationCenterProps,
  type OnboardingChecklistProps,
  type WhatsNewProps,
  type FeedbackWidgetProps,
  type ShortcutEditorProps,
  type HelpPanelProps,
} from "./Help/Help.tsx";

/* Views and charts */
export {
  Gallery,
  Calendar,
  Timeline,
  ResourceSchedule,
  OrgChart,
  type GalleryProps,
  type CalendarProps,
  type TimelineProps,
  type TimelineChange,
  type TimelineLink,
  type TimelinePreview,
  type ResourceScheduleProps,
  type OrgChartProps,
} from "./Charts/Charts.tsx";
export { Chart, foldSeries, type ChartProps } from "./Charts/Chart.tsx";
export { Sparkline, type SparklineProps } from "./Charts/Sparkline.tsx";

/* Editing */
export {
  FilterBuilder,
  QuickAdd,
  ColorPicker,
  DiffViewer,
  parseQuickAdd,
  finalizeQuickAdd,
  quickAddKey,
  zonedInstant,
  useQuickAdd,
  QuickAddChips,
  contrastRatio,
  type FilterBuilderProps,
  type QuickAddProps,
  type ColorPickerProps,
  type DiffViewerProps,
  type QuickAddResult,
  type QuickAddToken,
  type QuickAddCandidate,
  type QuickAddChipsProps,
  type QuickAddCopy,
  type QuickAddController,
  type QuickAddOptions,
  type QuickAddParse,
  type QuickAddResolution,
  type QuickAddResolver,
  type QuickAddSpan,
  type QuickAddTokenType,
  type UseQuickAddOptions,
} from "./Editing/Editing.tsx";

/* Grids */
export {
  SpreadsheetGrid,
  BudgetGrid,
  BidSheet,
  glForCode,
  parseCell,
  columnTotal,
  type SpreadsheetGridProps,
  type BudgetGridProps,
  type BidSheetProps,
} from "./Grids/Grids.tsx";

/* Documents and maps */
export {
  RichTextEditor,
  FilePreviewer,
  MapView,
  toLngLat,
  type RichTextEditorProps,
  type SuggestionItem,
  type SuggestionSource,
  type FilePreviewerProps,
  type MapViewProps,
  type MapGeo,
} from "./Media/Media.tsx";
