import type * as React from 'react';
export type RecordState = 'proposed' | 'ready' | 'scheduled' | 'active' | 'blocked' | 'in-review' | 'complete' | 'deferred' | 'canceled';
/** Any lucide-react icon name in PascalCase (Hammer) or kebab-case (chevron-right). */
export type IconName = string;
export type DepartmentCode = '0000' | '1000' | '2000' | '3000' | '4000' | '5000' | '6000' | '7000' | '8000' | '9000';
export type PhaseCode = 'SCP' | 'ENG' | 'ADV' | 'PRC' | 'BLD' | 'INS' | 'OPR' | 'AMP' | 'CLS';
export type RecordKind = 'Build' | 'Rehearsal' | 'Shift' | 'Strike' | 'Task' | 'Training' | 'Document' | 'Supply' | 'Booking' | 'Contract' | 'Payment' | 'Recruitment' | 'Approval' | 'Compliance' | 'Deadline' | 'Decision' | 'Inspection' | 'Permit' | 'Distribution' | 'Event' | 'Goal' | 'Meeting' | 'Milestone' | 'Report' | 'Risk' | 'Timeline';
export interface Option { value: string; label: string; code?: string; icon?: IconName; help?: string }
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: IconName; shortcut?: string }
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { icon: IconName; label: string; shortcut?: string; variant?: 'ghost' | 'secondary' }
export interface KbdProps { children: React.ReactNode }
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width'> { label?: string; help?: string; error?: string; /** Field width; 280 px by default, never wider than its container. */ width?: number | string }
export interface CurrencyInputProps { label?: string; value: number | null; currency?: string; help?: string; unpricedLabel?: string; id?: string; onChange?: React.ChangeEventHandler<HTMLInputElement> }
export interface MoneyProps { amount: number | null; currency?: string; unpricedLabel?: string }
export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> { label: React.ReactNode }
export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> { label: React.ReactNode }
export interface SegmentedControlProps { label: string; value?: string; options: { value: string; label: string; icon?: IconName }[]; onChange?: (value: string) => void }
export interface TabsProps { label: string; value?: string; tabs: { value: string; label: string; count?: number }[]; onChange?: (value: string) => void }
export interface BreadcrumbsProps { items: { label: string; href?: string }[] }
export interface IconProps { name: IconName; size?: number; label?: string; color?: string; className?: string; strokeWidth?: number }
export interface StateIconProps { state: RecordState; size?: number }
export interface StateChipProps { state: RecordState; label: string; compact?: boolean; onClick?: () => void }
export interface PhaseChipProps { gate: number; name: string; code: PhaseCode }
export interface DepartmentChipProps { name: string; code: DepartmentCode }
export interface URIDChipProps { name: string; urid: string }
export interface PropertyChipProps { label?: string; value: React.ReactNode; icon?: IconName; onClick?: () => void }
export interface TagProps { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; children: React.ReactNode }
export interface ProvenanceBadgeProps { source: string; rank: number }
export interface AssertionRankBadgeProps { label: string; rank: 0 | 1 | 2 | 3 | 4 }
export interface RefusalNoticeProps { outcome: 'NO_ANSWER' | 'UNRATIFIED' | 'REFUSE'; title: string; reason: string; actionLabel?: string; onAction?: () => void }
export interface InlineAlertProps { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: React.ReactNode }
export interface ToastProps { message: string; actionLabel?: string; actionIcon?: IconName; shortcut?: string; onAction?: () => void }
export interface EmptyStateProps { sentence: string; actionLabel: string; icon?: IconName; shortcut?: string; onAction?: () => void }
export interface ProgressBarProps { label: string; value: number }
export interface SkeletonProps { width?: number | string; height?: number | string }
export interface AvatarProps { name: string; size?: 'md' | 'lg' }
export interface AvatarStackProps { names: string[]; max?: number }
export interface TooltipProps { label: string; shortcut?: string }
export interface DataTableColumn { key: string; label: string; type?: 'text' | 'code' | 'number' | 'money' | 'state'; currency?: string; /** A long text column wraps instead of widening the table. */ wrap?: boolean }
export interface DataTableProps { columns: DataTableColumn[]; rows: Record<string, unknown>[]; caption?: string; density?: 'compact' | 'default' | 'comfortable'; totals?: Record<string, unknown>; totalsLabel?: string }
export interface CommandMenuProps { query?: string; placeholder?: string; groups: { label: string; items: { label: string; code?: string; icon?: IconName; state?: RecordState; shortcut?: string; selected?: boolean }[] }[] }
export interface DialogProps { title: string; children: React.ReactNode; actions: React.ReactNode }
export interface SidebarProps { label?: string; active?: string; groups: { label?: string; collapsed?: boolean; items: { label: string; icon?: IconName; badge?: number }[] }[] }
export interface ClockButtonProps { state?: 'out' | 'on' | 'break' | 'blocked'; label: string; detail?: string; timer?: string; geofence?: string; geofenceOk?: boolean; onClick?: () => void }
type C<P> = (props: P) => React.ReactElement;
export declare const Button: C<ButtonProps>; export declare const IconButton: C<IconButtonProps>; export declare const Kbd: C<KbdProps>;
export declare const Input: C<InputProps>; export declare const CurrencyInput: C<CurrencyInputProps>; export declare const Money: C<MoneyProps>;
export declare const Checkbox: C<CheckboxProps>; export declare const Switch: C<SwitchProps>; export declare const SegmentedControl: C<SegmentedControlProps>;
export declare const Tabs: C<TabsProps>; export declare const Breadcrumbs: C<BreadcrumbsProps>; export declare const Icon: C<IconProps>;
export declare const StateIcon: C<StateIconProps>; export declare const StateChip: C<StateChipProps>; export declare const PhaseChip: C<PhaseChipProps>;
export declare const DepartmentChip: C<DepartmentChipProps>; export declare const URIDChip: C<URIDChipProps>; export declare const PropertyChip: C<PropertyChipProps>;
export declare const Tag: C<TagProps>; export declare const ProvenanceBadge: C<ProvenanceBadgeProps>; export declare const AssertionRankBadge: C<AssertionRankBadgeProps>;
export declare const RefusalNotice: C<RefusalNoticeProps>; export declare const InlineAlert: C<InlineAlertProps>; export declare const Toast: C<ToastProps>;
export declare const EmptyState: C<EmptyStateProps>; export declare const ProgressBar: C<ProgressBarProps>; export declare const Skeleton: C<SkeletonProps>;
export declare const Avatar: C<AvatarProps>; export declare const AvatarStack: C<AvatarStackProps>; export declare const Tooltip: C<TooltipProps>;
export declare const DataTable: C<DataTableProps>; export declare const CommandMenu: C<CommandMenuProps>; export declare const Dialog: C<DialogProps>;
export declare const Sidebar: C<SidebarProps>; export declare const ClockButton: C<ClockButtonProps>;

export interface DepartmentGlyphProps { code: DepartmentCode; size?: number; label?: string; color?: string }
export interface PhaseGlyphProps { code: PhaseCode; size?: number; label?: string; color?: string }
export interface RecordKindGlyphProps { kind: RecordKind; size?: number; label?: string; color?: string }
export interface RecordKindChipProps { kind: RecordKind; label?: string }
export interface BrandMarkProps { name: string; logoLight?: string; logoDark?: string; monogram?: string; size?: 'sm' | 'md' | 'lg'; iconOnly?: boolean }
/** width and height are the delivery size in pixels; the frame draws in proportion, at most 160 by 148. */
export interface BrandSlotProps { label: string; width: number; height: number; formats: string }
export interface WhiteLabelPreviewProps { sample: React.ReactNode; brands: { name: string; domain: string; theme: 'dark' | 'light' | 'sunlight'; tokens: Record<string, string> }[] }
export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> { external?: boolean }
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; help?: string; error?: string; width?: number | string }
export interface SelectProps { label?: string; help?: string; error?: string; value?: string; placeholder?: string; options: Option[]; disabled?: boolean; onChange?: React.ChangeEventHandler<HTMLSelectElement> }
export interface ComboboxProps { label?: string; help?: string; value?: string; placeholder?: string; noMatch?: string; options: Option[]; defaultOpen?: boolean; onChange?: (value: string) => void }
export interface MultiSelectProps { label?: string; help?: string; value?: string[]; placeholder?: string; options: Option[]; defaultOpen?: boolean; onChange?: (value: string[]) => void }
export interface RadioProps { label: string; name?: string; value?: string; options: Option[]; onChange?: React.ChangeEventHandler<HTMLInputElement> }
export interface SliderProps { label: string; min: number; max: number; step?: number; value: number; unit?: string; onChange?: (value: number) => void }
export interface NumberInputProps { label?: string; help?: string; value?: number | null; unit?: string; step?: number; placeholder?: string; onChange?: (value: number | null) => void }
export interface DatePickerProps { label?: string; help?: string; value?: string; month?: string; today?: string; placeholder?: string; defaultOpen?: boolean; onChange?: (isoDate: string) => void }
export interface DateRangePickerProps { label?: string; help?: string; start?: string; end?: string; defaultOpen?: boolean; onChange?: (range: [string, string]) => void }
export interface TimePickerProps { label?: string; help?: string; value?: string; step?: number; timeZone: string; zoneLabel: string; onChange?: React.ChangeEventHandler<HTMLSelectElement> }
export interface FileDropProps { label?: string; hint?: string; accept?: string; width?: number; files?: { name: string; size: number }[]; onFiles?: (files: FileList) => void }
export interface BannerProps { tone?: 'info' | 'success' | 'warning' | 'danger'; icon?: IconName; children: React.ReactNode; actionLabel?: string; onAction?: () => void; onDismiss?: () => void }
export interface ErrorStateProps { title: string; sentence: string; actionLabel?: string; reference?: string; onRetry?: () => void }
export interface MenuItem { label?: string; icon?: IconName; shortcut?: string; danger?: boolean; active?: boolean; submenu?: boolean; separator?: boolean; heading?: string }
export interface DropdownMenuProps { label: string; icon?: IconName; items: MenuItem[]; defaultOpen?: boolean }
export interface ContextMenuProps { label?: string; items: MenuItem[] }
export interface PopoverProps { title?: string; children: React.ReactNode; learnMore?: string }
export interface HoverCardProps { recordKey: string; kind: RecordKind; title: string; state: RecordState; stateLabel: string; owner: string; next: string }
export interface DrawerProps { title: string; side?: 'right' | 'left'; children: React.ReactNode; footer?: React.ReactNode; onClose?: () => void }
export interface SidePeekProps { recordKey: string; kind: RecordKind; title: string; state: RecordState; stateLabel: string; chips?: React.ReactNode; properties?: { label: string; value: React.ReactNode }[]; children?: React.ReactNode }
export interface ShortcutSheetProps { title?: string; groups: { label: string; items: { label: string; keys: string }[] }[] }
export interface PaginationProps { summary: string; hasPrev: boolean; hasNext: boolean; onPrev?: () => void; onNext?: () => void }
export interface PageHeaderProps { title: string; glyph?: IconName; count?: number; views?: React.ReactNode; actions?: React.ReactNode }
export interface CardProps { title?: string; meta?: React.ReactNode; footer?: React.ReactNode; interactive?: boolean; children: React.ReactNode }
export interface DividerProps { label?: string }
export interface AccordionProps { items: { title: string; meta?: string; open?: boolean; content: React.ReactNode }[] }
export interface StepperProps { steps: string[]; current: number }
export interface ResizablePanelProps { initial: number; min: number; max: number; side?: 'left' | 'right'; label?: string; children: React.ReactNode }
export interface SplitViewProps { label: string; selected: number; items: { title: string; meta: string; state?: RecordState }[]; detail: React.ReactNode }
export interface AppShellProps { brand?: React.ReactNode; sidebar: React.ReactNode; header?: React.ReactNode; children: React.ReactNode }
export interface BadgeProps { count: number; tone?: 'neutral' | 'accent' | 'danger'; label?: string }
export interface PresenceIndicatorProps { names: string[]; verb?: 'viewing' | 'editing' }
export interface BoardProps { addLabel?: string; /** Hides the add buttons; cards open but do not move. Used where the viewer cannot create or change records, such as a Gateway applicant's own applications. */ readOnly?: boolean; columns: { state: RecordState; label: string; cards: { key: string; title: string; /** One secondary line under the title. */ meta?: string; kind?: RecordKind; owner?: string; due?: string }[] }[] }
export interface TimelineRow { key: string; title: string; state: RecordState; start: number; end: number; progress?: number; critical?: boolean; milestone?: boolean; dependsOn?: number; baselineStart?: number; baselineEnd?: number }
export interface TimelineProps { label: string; days: { dow: string; date: number; weekend?: boolean }[]; rows: TimelineRow[]; gates?: { day: number; label: string }[]; today?: number; dayWidth?: number }
export interface CalendarProps { /** First day of the month shown, as an ISO date such as 2026-11-01. */ month: string; today?: string; events: { date: string; label: string; state: RecordState }[] }
export interface TreeNode { label: string; icon?: IconName; meta?: string; selected?: boolean; expanded?: boolean; children?: TreeNode[] }
export interface TreeViewProps { label: string; nodes: TreeNode[] }
export interface RichTextEditorProps { label: string; html: string; presence?: React.ReactNode }
/** `multiplier` stores a number (1.5) and displays it as 1.5x. `derive` makes a read-only column computed from the row, for values whose source of truth is another table (job title, GL account). */
export interface GridColumn { key: string; label: string; type?: 'text' | 'code' | 'number' | 'money' | 'multiplier'; editable?: boolean; total?: boolean; currency?: string; width?: number; derive?: (row: Record<string, string | number | null>) => string | number | null | undefined }
export interface SpreadsheetGridProps { label: string; columns: GridColumn[]; rows: Record<string, string | number | null>[]; totalsLabel?: string }
export interface FilterBuilderProps { filters: { field: string; op: string; value: string }[]; addLabel?: string; saveLabel?: string }
export interface QuickAddProps { label?: string; placeholder?: string; value?: string }
export interface ColorPickerProps { label: string; value: string; checks: { label: string; fg?: string; bg?: string; fgIsValue?: boolean; min?: number }[] }
export interface BulkActionBarProps { count: number; actions: { label: string; icon?: IconName; shortcut?: string }[] }
export interface DiffViewerProps { caption?: string; rows: { field: string; before: string; after: string }[] }
export interface ActivityFeedItemProps { actor: string; action: string; target?: string; time: string; comment?: string; reactions?: { icon: IconName; label: string; count: number }[] }
export interface FilePreviewerProps { name: string; meta: string; pages: number; page?: number; zoom?: string; icon?: IconName; children: React.ReactNode }
export interface MapViewProps { label: string; width: number; height: number; zones: { label: string; x: number; y: number; w: number; h: number }[]; pins: { x: number; y: number; label: string; tone?: 'accent' | 'danger' | 'warning' }[]; geofence?: { x: number; y: number; r: number } }
export interface GateReadinessPanelProps { gate: number; code: PhaseCode; name: string; nextLabel: string; criteria: { code?: string; label: string; result: 'met' | 'gap' | 'unknown'; blocking: boolean; evidence?: string; action?: string }[] }
export interface CoordinateMatrixProps { label: string; corner: string; rows: { code: DepartmentCode; name: string }[]; cols: { gate: number; code: PhaseCode; name: string }[]; cells: Record<string, number> }
/** One budget line. Rates are per grade; amount is derived as qty times the selected grade's rate and is never stored. Line types per Bible tab 34. */
export interface BudgetLine { cc: string; urid: string; name: string; type?: 'Scope' | 'Overhead' | 'Contingency' | 'Fee' | 'Retainer'; qty?: number | null; unit?: string; base: number | null; elevated: number | null; premium: number | null }
/** One row of the GL Accounts table. Each department class has exactly one account per account type. */
export interface GLAccount { code: string; name: string; classCode: '0000' | '1000' | '2000' | '3000' | '4000' | '5000' | '6000' | '7000' | '8000' | '9000'; type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense' }
/** Lines carry no GL fields: each line posts to the account of its URID class and `accountType` (default Expense). Lines with no matching account group under Unmapped Account. */
export interface BudgetGridProps { accounts: GLAccount[]; accountType?: GLAccount['type']; lines: BudgetLine[]; grades: Option[]; grade?: 'base' | 'elevated' | 'premium'; scopeLabel?: string; /** Names the scroll region for assistive technology. */ label?: string }
export interface StalenessIndicatorProps { months: number; basis?: string }
export interface ReconciliationTableProps { /** Names the scroll region for assistive technology. */ label?: string; rows: { requirement: string; capability: string | null; result: 'Met' | 'Gap' | 'Unknown' }[] }
export interface RunOfShowLiveProps { cues: { number: string; time: string; title: string; dept?: DepartmentCode; durationSeconds?: number }[]; current: number; nextInSeconds: number; showMode?: boolean }
export interface AccessGridMatrixProps { label: string; zones: string[]; categories: { name: string; color: number }[]; grants: string[] }
/** One global Standard Library emergency code for one operational domain. `swatch` names an ecode-* color token. Steps name services as {fire}, {ems}, {lawEnforcement}, {bombSquad} or {federal}; `authorities` supplies the agencies for the project's jurisdiction. */
/** A responding agency for one service, resolved from the project's jurisdiction. */
export interface EmergencyAuthority { service: 'fire' | 'ems' | 'lawEnforcement' | 'bombSquad' | 'federal'; agency: string; contact?: string }
export interface EmergencyCodeCardProps { authorities?: EmergencyAuthority[]; recordKey?: string; code: string; name: string; swatch: 'ecode-red' | 'ecode-orange' | 'ecode-yellow' | 'ecode-green' | 'ecode-blue' | 'ecode-purple' | 'ecode-white' | 'ecode-black' | 'ecode-pink' | 'ecode-indigo' | 'ecode-silver' | 'ecode-grey' | 'ecode-amber' | 'ecode-adam'; domain?: string; steps: string[]; channel?: string }
/** Radio plan rows; the component sorts by zone, then channel, in numeric order. */
export interface RadioChannelTableProps { caption?: string; channels: { zone: number; channel: number; assignment: string; notes: string }[] }
export interface UndoToastProps { message: string; seconds?: number; onUndo?: () => void }
export interface NotificationItem { title: string; meta: string; kind?: RecordKind; action?: string; actionKey?: string }
export interface NotificationCenterProps { needsYou: NotificationItem[]; fyi: NotificationItem[] }
export interface OnboardingChecklistProps { title: string; steps: { label: string; done: boolean; action?: string }[] }
export interface WhatsNewProps { changelogHref: string; entries: { label: string; tone?: 'accent' | 'neutral'; date: string; title: string; body: string }[] }
export interface FeedbackWidgetProps {}
export interface ShortcutEditorProps { /** Names the scroll region for assistive technology. */ label?: string; rows: { action: string; keys: string; conflict?: string; custom?: boolean; recording?: boolean }[] }
export interface ScanSheetProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; mode: 'asset' | 'receiving' | 'credential'; hint: string; count: number; countLabel: string; doneLabel: string; last?: { ok: boolean; title: string; code: string } }
export interface OfflineBannerProps { message: string; queued: number; onView?: () => void }
export interface QuickIncidentSheetProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; location: string; types: { label: string; icon: IconName; critical?: boolean }[] }
export interface ChecklistRunnerProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; title: string; index: number; items: { code: string; label: string; help?: string; result: 'pass' | 'fail' | null }[] }
export interface ShiftCardProps { state: RecordState; stateLabel: string; countdown?: string; role: string; date: string; time: string; place: string; actions?: React.ReactNode }
export interface DaySheetViewProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; date: string; title: string; venue: string; entries: { time: string; label: string; now?: boolean }[]; contacts: { name: string; role: string }[] }
export interface SignaturePadProps { label: string; attestation: string }
export interface PhotoCaptureProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; hint: string; count: number }
export interface LiveActivityProps { label: string; elapsed: string; place: string; nextShift: string; nextTime: string; /** On break: the first action becomes End Break. */ onBreak?: boolean }
export interface ForceUpdateScreenProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; message: string; version: string }
export interface SyncConflictSheetProps { /** Draws the documentation phone frame; for previews only, never in product UI. */ frame?: boolean; message: string; field: string; mine: string; mineMeta: string; theirs: string; theirsMeta: string }
export interface OpportunityCardProps { org: string; verified?: boolean; role: string; pay: string | null; date: string; place: string; requirements: { missing: string[] }; missingAction?: string; deadline: string; saved?: boolean }
export interface OpportunityFiltersProps { placeholder: string; chips: string[]; active?: string[] }
export interface ApplicationFormProps { role: string; org: string; shared: { label: string; on: boolean }[]; questions: string[] }
export interface BidSheetProps { deadline: string; lines: { line: string; item: string; unit: string; qty: number; price: number | null; ext: number | null }[] }
export interface AgencySlateProps { positions: number; roster: { name: string; role: string; selected: boolean; certs: { label: string; ok: boolean }[] }[] }
export interface ProfileEditorProps { strength: number; nextStep: string; fields: { label: string; value: string; visibility: 'private' | 'application' | 'public' }[] }
export interface EPKViewerProps { artist: string; headline: string; badges: string[]; bio: string; media: { type: 'video' | 'audio' | 'image'; label: string }[]; links: { label: string; href: string }[] }
export interface AvailabilityCalendarProps { month: string; available: string[]; booked: string[] }
export interface OnboardingPacketProps { items: { label: string; state: 'verified' | 'review' | 'todo' | 'expired'; blocking: boolean; minutes: number; note?: string; action?: string }[] }
export interface EngagementTimelineProps { current: number; stages: { label: string; date?: string; owner?: string }[] }
export interface RatingDialogProps { counterpart: string; value?: number }
export interface PayoutDetailsFormProps { rail: string; onFile?: { bank: string; last4: string } }
export interface OrgSwitcherProps { current: string; heading: string; orgs: { name: string; role: string; badge?: number }[] }
export declare const DepartmentGlyph: C<DepartmentGlyphProps>;
export declare const PhaseGlyph: C<PhaseGlyphProps>;
export declare const RecordKindGlyph: C<RecordKindGlyphProps>;
export declare const RecordKindChip: C<RecordKindChipProps>;
export declare const BrandMark: C<BrandMarkProps>;
export declare const BrandSlot: C<BrandSlotProps>;
export declare const WhiteLabelPreview: C<WhiteLabelPreviewProps>;
export declare const Link: C<LinkProps>;
export declare const Textarea: C<TextareaProps>;
export declare const Select: C<SelectProps>;
export declare const Combobox: C<ComboboxProps>;
export declare const MultiSelect: C<MultiSelectProps>;
export declare const Radio: C<RadioProps>;
export declare const Slider: C<SliderProps>;
export declare const NumberInput: C<NumberInputProps>;
export declare const DatePicker: C<DatePickerProps>;
export declare const DateRangePicker: C<DateRangePickerProps>;
export declare const TimePicker: C<TimePickerProps>;
export declare const FileDrop: C<FileDropProps>;
export declare const Banner: C<BannerProps>;
export declare const ErrorState: C<ErrorStateProps>;
export declare const DropdownMenu: C<DropdownMenuProps>;
export declare const ContextMenu: C<ContextMenuProps>;
export declare const Popover: C<PopoverProps>;
export declare const HoverCard: C<HoverCardProps>;
export declare const Drawer: C<DrawerProps>;
export declare const SidePeek: C<SidePeekProps>;
export declare const ShortcutSheet: C<ShortcutSheetProps>;
export declare const Pagination: C<PaginationProps>;
export declare const PageHeader: C<PageHeaderProps>;
export declare const Card: C<CardProps>;
export declare const Divider: C<DividerProps>;
export declare const Accordion: C<AccordionProps>;
export declare const Stepper: C<StepperProps>;
export declare const ResizablePanel: C<ResizablePanelProps>;
export declare const SplitView: C<SplitViewProps>;
export declare const AppShell: C<AppShellProps>;
export declare const Badge: C<BadgeProps>;
export declare const PresenceIndicator: C<PresenceIndicatorProps>;
export declare const Board: C<BoardProps>;
export declare const Timeline: C<TimelineProps>;
export declare const Calendar: C<CalendarProps>;
export declare const TreeView: C<TreeViewProps>;
export declare const RichTextEditor: C<RichTextEditorProps>;
export declare const SpreadsheetGrid: C<SpreadsheetGridProps>;
export declare const FilterBuilder: C<FilterBuilderProps>;
export declare const QuickAdd: C<QuickAddProps>;
export declare const ColorPicker: C<ColorPickerProps>;
export declare const BulkActionBar: C<BulkActionBarProps>;
export declare const DiffViewer: C<DiffViewerProps>;
export declare const ActivityFeedItem: C<ActivityFeedItemProps>;
export declare const FilePreviewer: C<FilePreviewerProps>;
export declare const MapView: C<MapViewProps>;
export declare const GateReadinessPanel: C<GateReadinessPanelProps>;
export declare const CoordinateMatrix: C<CoordinateMatrixProps>;
export declare const BudgetGrid: C<BudgetGridProps>;
export declare const StalenessIndicator: C<StalenessIndicatorProps>;
export declare const ReconciliationTable: C<ReconciliationTableProps>;
export declare const RunOfShowLive: C<RunOfShowLiveProps>;
export declare const AccessGridMatrix: C<AccessGridMatrixProps>;
export declare const EmergencyCodeCard: C<EmergencyCodeCardProps>;
export declare const RadioChannelTable: C<RadioChannelTableProps>;
export declare const UndoToast: C<UndoToastProps>;
export declare const NotificationCenter: C<NotificationCenterProps>;
export declare const OnboardingChecklist: C<OnboardingChecklistProps>;
export declare const WhatsNew: C<WhatsNewProps>;
export declare const FeedbackWidget: C<FeedbackWidgetProps>;
export declare const ShortcutEditor: C<ShortcutEditorProps>;
export declare const ScanSheet: C<ScanSheetProps>;
export declare const OfflineBanner: C<OfflineBannerProps>;
export declare const QuickIncidentSheet: C<QuickIncidentSheetProps>;
export declare const ChecklistRunner: C<ChecklistRunnerProps>;
export declare const ShiftCard: C<ShiftCardProps>;
export declare const DaySheetView: C<DaySheetViewProps>;
export declare const SignaturePad: C<SignaturePadProps>;
export declare const PhotoCapture: C<PhotoCaptureProps>;
export declare const LiveActivity: C<LiveActivityProps>;
export declare const ForceUpdateScreen: C<ForceUpdateScreenProps>;
export declare const SyncConflictSheet: C<SyncConflictSheetProps>;
export declare const OpportunityCard: C<OpportunityCardProps>;
export declare const OpportunityFilters: C<OpportunityFiltersProps>;
export declare const ApplicationForm: C<ApplicationFormProps>;
export declare const BidSheet: C<BidSheetProps>;
export declare const AgencySlate: C<AgencySlateProps>;
export declare const ProfileEditor: C<ProfileEditorProps>;
export declare const EPKViewer: C<EPKViewerProps>;
export declare const AvailabilityCalendar: C<AvailabilityCalendarProps>;
export declare const OnboardingPacket: C<OnboardingPacketProps>;
export declare const EngagementTimeline: C<EngagementTimelineProps>;
export declare const RatingDialog: C<RatingDialogProps>;
export declare const PayoutDetailsForm: C<PayoutDetailsFormProps>;
export declare const OrgSwitcher: C<OrgSwitcherProps>;
export declare const glyphs: { departments: Record<DepartmentCode, string>; phases: Record<PhaseCode, string>; recordKinds: Record<RecordKind, string> };
export declare function parseQuickAdd(text: string): { title: string; tokens: { type: 'person' | 'tag' | 'kind' | 'scope' | 'date'; value: string; icon: string }[] };
export declare function contrastRatio(a: string, b: string): number;
/** Wraps wide content so it scrolls inside a labeled region instead of widening the page. Focusable only while it overflows. */
export interface ScrollRegionProps { label: string; children?: React.ReactNode }
export declare const ScrollRegion: C<ScrollRegionProps>;
/** Resolves the GL account for a role code or URID from its class (first segment). Returns null when the table has no account of that type for the class. */
export declare function glForCode(code: string, accounts: GLAccount[], type?: GLAccount['type']): GLAccount | null;
export interface XOSConfig { locale?: string; messages?: Record<string, string> }
/** Sets the locale for Intl formatting and merges a message catalog from packages/i18n. */
export declare function configure(config: XOSConfig): void;
/** Looks up a catalog message and fills its {arguments}. */
export declare function t(key: string, vars?: Record<string, string | number>): string;

export interface RecordRowProps { state: RecordState; stateLabel: string; recordKey: string; kind?: RecordKind; title: string; chips?: React.ReactNode; next?: string; owner?: string; actionLabel?: string; actionKey?: string; selected?: boolean; onAction?: () => void }
export interface RecordListProps { label: string; children: React.ReactNode }
export interface GalleryProps { label: string; min?: number; children: React.ReactNode }
export interface ResourceScheduleProps { label: string; days: { key: string; dow: string; date: number; weekend?: boolean }[]; people: { name: string; role: string; shifts?: { day: string; time: string; state: RecordState }[] }[] }
export interface OrgChartNode { name: string | null; role: string; code?: string; reports?: OrgChartNode[] }
export interface OrgChartProps { label: string; root: OrgChartNode }
/** One y-axis only. Series take viz-cat-1..7 in order; an eighth series folds into Other. Blank values are gaps, never zero. */
export interface ChartProps { type: 'bar' | 'line'; title: string; subtitle?: string; categoryLabel: string; categories: string[]; series: { name: string; values: (number | null)[] }[]; format?: 'number' | 'money'; currency?: string; width?: number; height?: number }
export interface StatTileProps { label: string; value: number | null; format?: 'number' | 'money'; delta?: number | null; deltaUnit?: string; deltaLabel?: string; goodWhen?: 'up' | 'down'; caption?: string }
export interface HelpPanelProps { articles: string[]; shortcuts: { label: string; keys: string }[]; assistant?: boolean }
export interface QRCodeProps { value: string; label: string; size?: number }
export interface CredentialBadgeProps { org: string; name: string; role: string; category: string; categoryColor: 1 | 2 | 3 | 4 | 5 | 6 | 7; credentialKey: string; payload: string; zones: string[]; validFrom: string; validTo: string }
export interface UpNextCardProps { org: string; countdown: string; title: string; when: string; callTime: string; address: string; parking?: string; contact?: string; bring?: string[] }
export interface PaymentTrackerProps { invoiceKey: string; title: string; amount: number | null; current: 0 | 1 | 2 | 3; dates: string[]; expected?: string }
export interface TabBarProps { label: string; items: { label: string; icon: IconName; badge?: number }[]; active: string; compass?: boolean; centerLabel?: string }
export interface TopNavProps { brand: string; label: string; person: string; active: string; items: { label: string; icon: IconName; badge?: number }[] }
export declare const RecordRow: C<RecordRowProps>;
export declare const RecordList: C<RecordListProps>;
export declare const Gallery: C<GalleryProps>;
export declare const ResourceSchedule: C<ResourceScheduleProps>;
export declare const OrgChart: C<OrgChartProps>;
export declare const Chart: C<ChartProps>;
export declare const StatTile: C<StatTileProps>;
export declare const HelpPanel: C<HelpPanelProps>;
export declare const QRCode: C<QRCodeProps>;
export declare const CredentialBadge: C<CredentialBadgeProps>;
export declare const UpNextCard: C<UpNextCardProps>;
export declare const PaymentTracker: C<PaymentTrackerProps>;
export declare const TabBar: C<TabBarProps>;
export declare const TopNav: C<TopNavProps>;
