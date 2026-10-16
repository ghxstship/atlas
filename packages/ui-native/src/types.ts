import type { ReactNode } from "react";
import type { DepartmentCode, RecordState } from "@xos/icons";

/**
 * Published prop contracts for @xos/ui-native (Section 11.4, Compass). Names and shapes mirror the
 * web reference in design/xos-design-system/components/index.d.ts where a web component exists;
 * documentation-only props (`frame`) are dropped and production callbacks are added. Props carry no
 * React Native style types: every component draws itself from the theme tokens, so a screen never
 * passes colors, sizes or fonts. Changes after publication are additive only.
 *
 * All user-facing strings arrive as props, already translated by the app's i18next catalogs.
 */

export type { DepartmentCode, RecordState };

/** A lucide-react-native icon name in PascalCase (Hammer) or kebab-case (chevron-right). */
export type IconName = string;

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
export type AlertTone = "info" | "success" | "warning" | "danger";

/** Every component accepts a test id for Maestro and component tests. */
export interface NativeBaseProps {
  testID?: string;
}

/* Foundations */

export interface TextProps extends NativeBaseProps {
  /** Typography token; text16 is the Compass body size. */
  variant?:
    | "text11"
    | "text12"
    | "text13"
    | "text14"
    | "text16"
    | "label13"
    | "heading16"
    | "heading20"
    | "heading24"
    | "heading32"
    | "mono13";
  tone?: "primary" | "secondary" | "tertiary" | "accent" | "success" | "warning" | "danger";
  /** Maximum lines before truncation; omitted means wrap freely. */
  numberOfLines?: number;
  /** Marks a heading for VoiceOver and TalkBack rotor navigation. */
  heading?: boolean;
  children: ReactNode;
}

export interface IconProps extends NativeBaseProps {
  name: IconName;
  /** Compass icon sizes: 20, 24 (default) and 28. */
  size?: 20 | 24 | 28;
  /** Set only when the icon carries meaning alone; otherwise it is hidden from assistive technology. */
  label?: string;
  tone?: TextProps["tone"];
}

export interface StateIconProps extends NativeBaseProps {
  state: RecordState;
  size?: 20 | 24 | 28;
}

export interface ScreenProps extends NativeBaseProps {
  /** Screen title, announced on focus. */
  title?: string;
  /** Scrolls the content; true by default. */
  scroll?: boolean;
  /** Pull to refresh; shown only when onRefresh is set. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Pinned below the content, above the tab bar (primary actions). */
  footer?: ReactNode;
  children: ReactNode;
}

/* Primitives */

export interface ButtonProps extends NativeBaseProps {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** lg is the 56 pt thumb button; md (default) meets the 48 pt target. */
  size?: "md" | "lg";
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** Fills the row width. */
  block?: boolean;
  /** Requires press and hold before onPress fires (critical incidents, destructive steps). */
  holdToConfirm?: { seconds: number; hint: string };
}

export interface IconButtonProps extends NativeBaseProps {
  icon: IconName;
  label: string;
  onPress?: () => void;
  variant?: "ghost" | "secondary";
  disabled?: boolean;
}

export interface TextFieldProps extends NativeBaseProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  help?: string;
  error?: string;
  keyboard?: "default" | "numeric" | "email" | "phone" | "url";
  secure?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  /** Mobile autofill hint. */
  autoComplete?: "off" | "email" | "name" | "tel" | "one-time-code" | "password";
}

export interface CheckboxProps extends NativeBaseProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export interface SwitchProps extends NativeBaseProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  help?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps extends NativeBaseProps {
  label: string;
  value: string;
  options: { value: string; label: string; icon?: IconName }[];
  onChange: (value: string) => void;
}

export interface MoneyProps extends NativeBaseProps {
  /** Integer minor units; null means unpriced, never zero. */
  amount: number | null;
  currency?: string;
  unpricedLabel: string;
}

/* Data display */

export interface CardProps extends NativeBaseProps {
  title?: string;
  meta?: ReactNode;
  footer?: ReactNode;
  onPress?: () => void;
  children: ReactNode;
}

export interface ListRowProps extends NativeBaseProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** Trailing value or control. */
  trailing?: ReactNode;
  onPress?: () => void;
  /** Swipe actions: right to complete, left to snooze or reassign (Section 11.13 Tasks). */
  swipeStart?: { label: string; icon: IconName; tone?: Tone; onAction: () => void };
  swipeEnd?: { label: string; icon: IconName; tone?: Tone; onAction: () => void };
}

export interface StateChipProps extends NativeBaseProps {
  state: RecordState;
  label: string;
  compact?: boolean;
}

export interface DepartmentChipProps extends NativeBaseProps {
  code: DepartmentCode;
  name: string;
}

export interface TagProps extends NativeBaseProps {
  tone?: Tone;
  label: string;
}

export interface BadgeProps extends NativeBaseProps {
  count: number;
  tone?: "neutral" | "accent" | "danger";
  label?: string;
}

export interface AvatarProps extends NativeBaseProps {
  name: string;
  size?: "md" | "lg";
}

export interface ProgressBarProps extends NativeBaseProps {
  label: string;
  /** 0 to 100. */
  value: number;
}

export interface SkeletonProps extends NativeBaseProps {
  width?: number | `${number}%`;
  height?: number;
  /** Lines of text to stand in for; draws a stacked block. */
  lines?: number;
}

export interface QRCodeProps extends NativeBaseProps {
  value: string;
  label: string;
  size?: number;
}

/* Feedback */

/** A dismissible banner names its dismiss button (A23-010): `dismissLabel` comes with `onDismiss`. */
export type BannerProps = NativeBaseProps & {
  tone?: AlertTone;
  icon?: IconName;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
} & (
    | { onDismiss?: undefined; dismissLabel?: undefined }
    | { onDismiss: () => void; dismissLabel: string }
  );

export interface InlineAlertProps extends NativeBaseProps {
  tone?: AlertTone;
  title?: string;
  message: string;
}

export interface ToastProps extends NativeBaseProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface UndoToastProps extends NativeBaseProps {
  message: string;
  undoLabel: string;
  seconds?: number;
  onUndo: () => void;
}

export interface EmptyStateProps extends NativeBaseProps {
  /** One specific sentence that names the next action. */
  sentence: string;
  actionLabel: string;
  icon?: IconName;
  onAction?: () => void;
}

export interface ErrorStateProps extends NativeBaseProps {
  title: string;
  sentence: string;
  actionLabel?: string;
  /** Support reference shown for the person to quote. */
  reference?: string;
  onRetry?: () => void;
}

export interface RefusalNoticeProps extends NativeBaseProps {
  outcome: "NO_ANSWER" | "UNRATIFIED" | "REFUSE";
  title: string;
  reason: string;
  actionLabel?: string;
  onAction?: () => void;
}

/* Overlays and navigation */

export interface SheetProps extends NativeBaseProps {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel: string;
  /** Snap heights as fractions of the screen; [0.5, 0.92] by default. */
  snapPoints?: number[];
  footer?: ReactNode;
  children: ReactNode;
}

export interface DialogProps extends NativeBaseProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export interface TabBarItem {
  key: string;
  label: string;
  icon: IconName;
  badge?: number;
}

export interface TabBarProps extends NativeBaseProps {
  label: string;
  items: TabBarItem[];
  active: string;
  onSelect: (key: string) => void;
  /** The raised center action (Scan). */
  center?: { label: string; icon: IconName; onPress: () => void };
}

/* XOS shared */

export interface EmergencyAuthority {
  service: "fire" | "ems" | "lawEnforcement" | "bombSquad" | "federal";
  agency: string;
  contact?: string;
}

export type EmergencySwatch =
  | "ecode-red"
  | "ecode-orange"
  | "ecode-yellow"
  | "ecode-green"
  | "ecode-blue"
  | "ecode-purple"
  | "ecode-white"
  | "ecode-black"
  | "ecode-pink"
  | "ecode-indigo"
  | "ecode-silver"
  | "ecode-grey"
  | "ecode-amber"
  | "ecode-adam";

export interface EmergencyCodeCardProps extends NativeBaseProps {
  code: string;
  name: string;
  swatch: EmergencySwatch;
  domain?: string;
  steps: string[];
  channel?: string;
  recordKey?: string;
  authorities?: EmergencyAuthority[];
  /** Labels for the authority services, already translated. */
  serviceLabels?: Partial<Record<EmergencyAuthority["service"], string>>;
}

export interface RadioChannelTableProps extends NativeBaseProps {
  caption?: string;
  channels: { zone: number; channel: number; assignment: string; notes: string }[];
  /** Column headers, already translated. */
  headers: { zone: string; channel: string; assignment: string; notes: string };
}

export interface RunOfShowCue {
  number: string;
  time: string;
  title: string;
  dept?: DepartmentCode;
  durationSeconds?: number;
}

export interface RunOfShowLiveProps extends NativeBaseProps {
  cues: RunOfShowCue[];
  current: number;
  nextInSeconds: number;
  /** Show mode: large type, dark, screen kept awake, haptic before each cue. */
  showMode?: boolean;
  nextLabel: string;
  /** What a screen reader says for the countdown, such as "2 min 10 s to Doors" (A23-009). */
  countdownLabel?: string;
}

export interface CredentialBadgeProps extends NativeBaseProps {
  org: string;
  name: string;
  role: string;
  category: string;
  categoryColor: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  credentialKey: string;
  /** Signed QR payload, shown offline with brightness raised. */
  payload: string;
  zones: string[];
  validFrom: string;
  validTo: string;
}

/* Compass */

export interface ClockButtonProps extends NativeBaseProps {
  /** out: Clock In; on: On Shift with timer; break: Break; blocked: cannot clock (outside geofence or not rostered). */
  state: "out" | "on" | "break" | "blocked";
  label: string;
  detail?: string;
  timer?: string;
  /** Geofence status shown before the tap ("You're at the venue"). */
  geofence?: string;
  geofenceOk?: boolean;
  onPress?: () => void;
  /** Haptic on press; true by default, off when the person disables haptics. */
  haptics?: boolean;
}

export interface ScanResult {
  ok: boolean;
  title: string;
  code: string;
}

export interface ScanSheetProps extends NativeBaseProps {
  mode: "asset" | "receiving" | "credential";
  /** Mode switch options, already translated; the switch shows when this and onModeChange are set. */
  modes?: { value: ScanSheetProps["mode"]; label: string }[];
  onModeChange?: (mode: ScanSheetProps["mode"]) => void;
  hint: string;
  /** Running count in continuous mode. */
  count: number;
  countLabel: string;
  doneLabel: string;
  onDone: () => void;
  last?: ScanResult;
  /** Camera surface supplied by the app (expo-camera), so the library stays free of native modules. */
  camera?: ReactNode;
  /** NFC NDEF read action, shown when the device supports NFC. */
  nfc?: { label: string; onPress: () => void };
}

export interface OfflineBannerProps extends NativeBaseProps {
  message: string;
  /** Writes waiting to upload. */
  queued: number;
  /** The count as words for assistive technology ("3 queued"); the number alone is shown. */
  queuedLabel?: string;
  viewLabel?: string;
  onView?: () => void;
}

export interface IncidentType {
  key: string;
  label: string;
  icon: IconName;
  critical?: boolean;
}

export interface QuickIncidentSheetProps extends NativeBaseProps {
  /** Step 1: the type grid. */
  types: IncidentType[];
  /** Step 2: the location, filled automatically. */
  location: string;
  onChangeLocation?: () => void;
  step: 1 | 2 | 3;
  selected?: string;
  onSelectType: (key: string) => void;
  /** Step 3: photos and voice note. */
  attachments?: ReactNode;
  submitLabel: string;
  /** Critical types use hold to confirm. */
  holdHint: string;
  onSubmit: () => void;
  /** `typeGroup` names the step 1 type grid for assistive technology (A23-006). */
  labels: { step: string; location: string; change: string; typeGroup?: string };
}

export interface ChecklistItem {
  code: string;
  label: string;
  help?: string;
  result: "pass" | "fail" | null;
}

export interface ChecklistRunnerProps extends NativeBaseProps {
  title: string;
  /** The item on screen; one item per card. */
  index: number;
  items: ChecklistItem[];
  onResult: (code: string, result: "pass" | "fail") => void;
  onIndexChange?: (index: number) => void;
  /** A Fail asks for a photo and a note; the app supplies the capture surface. */
  failDetail?: ReactNode;
  labels: { pass: string; fail: string; progress: string; previous: string; next: string };
}

export interface ShiftCardProps extends NativeBaseProps {
  state: RecordState;
  stateLabel: string;
  countdown?: string;
  role: string;
  date: string;
  time: string;
  place: string;
  actions?: ReactNode;
  onPress?: () => void;
}

export interface DaySheetViewProps extends NativeBaseProps {
  date: string;
  title: string;
  venue: string;
  entries: { time: string; label: string; now?: boolean }[];
  contacts: { name: string; role: string; onCall?: () => void }[];
  labels: { schedule: string; contacts: string; call: string };
}

export interface SignaturePadProps extends NativeBaseProps {
  label: string;
  attestation: string;
  clearLabel: string;
  /** SVG path data of the strokes, or null when cleared. */
  onChange: (svgPath: string | null) => void;
}

export interface PhotoCaptureProps extends NativeBaseProps {
  hint: string;
  count: number;
  /** Camera surface supplied by the app (expo-camera). */
  camera?: ReactNode;
  captureLabel: string;
  onCapture: () => void;
  doneLabel: string;
  onDone: () => void;
  /** Annotation of the last photo: arrows, circles and text. */
  annotateLabel?: string;
  onAnnotate?: () => void;
}

export interface LiveActivityProps extends NativeBaseProps {
  label: string;
  elapsed: string;
  place: string;
  nextShift: string;
  nextTime: string;
  /** On break: the first action becomes End Break. */
  onBreak?: boolean;
  labels: { break: string; endBreak: string; clockOut: string };
  /** Break, or End Break while on break. */
  onToggleBreak?: () => void;
  onClockOut?: () => void;
}

export interface ForceUpdateScreenProps extends NativeBaseProps {
  message: string;
  version: string;
  actionLabel: string;
  onUpdate: () => void;
}

export interface SyncConflictSheetProps extends NativeBaseProps {
  message: string;
  field: string;
  mine: string;
  mineMeta: string;
  theirs: string;
  theirsMeta: string;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  labels: { mine: string; theirs: string; keepMine: string; keepTheirs: string };
}

export interface UpNextCardProps extends NativeBaseProps {
  org: string;
  countdown: string;
  title: string;
  when: string;
  callTime: string;
  address: string;
  parking?: string;
  contact?: string;
  bring?: string[];
  onDirections?: () => void;
  directionsLabel?: string;
}
