/**
 * The @xos/ui-native component list (Section 11.4 for Compass), grouped as the library ships them.
 * Each name is exported from the package root with a matching `<Name>Props` type in types.ts.
 * A component's entry in `nativeComponentStatus` turns "shipped" when its implementation, gallery
 * entry and accessibility test land; screens can rely on every name and props type from today.
 */
export const nativeComponentGroups = {
  foundations: ["ThemeProvider", "Text", "Icon", "StateIcon", "Screen"],
  primitives: [
    "Button",
    "IconButton",
    "TextField",
    "Checkbox",
    "Switch",
    "SegmentedControl",
    "Money",
  ],
  data: [
    "Card",
    "ListRow",
    "StateChip",
    "DepartmentChip",
    "Tag",
    "Badge",
    "Avatar",
    "ProgressBar",
    "Skeleton",
    "QRCode",
  ],
  feedback: [
    "Banner",
    "InlineAlert",
    "Toast",
    "UndoToast",
    "EmptyState",
    "ErrorState",
    "RefusalNotice",
  ],
  overlays: ["Sheet", "Dialog", "TabBar"],
  xos: ["EmergencyCodeCard", "RadioChannelTable", "RunOfShowLive", "CredentialBadge"],
  compass: [
    "ClockButton",
    "ScanSheet",
    "OfflineBanner",
    "QuickIncidentSheet",
    "ChecklistRunner",
    "ShiftCard",
    "DaySheetView",
    "SignaturePad",
    "PhotoCapture",
    "LiveActivity",
    "ForceUpdateScreen",
    "SyncConflictSheet",
    "UpNextCard",
  ],
} as const;

export type NativeComponentGroup = keyof typeof nativeComponentGroups;
export type NativeComponentName = (typeof nativeComponentGroups)[NativeComponentGroup][number];

/** Every component name, in group order. */
export const nativeComponentNames: readonly NativeComponentName[] =
  Object.values(nativeComponentGroups).flat();

export type NativeComponentStatus = "published" | "shipped";

/** Delivery status per component: "published" means the name and props are fixed; "shipped" means implemented. */
export const nativeComponentStatus: Readonly<Record<NativeComponentName, NativeComponentStatus>> =
  Object.fromEntries(
    nativeComponentNames.map((name) => [name, name === "ThemeProvider" ? "shipped" : "published"]),
  ) as Record<NativeComponentName, NativeComponentStatus>;
