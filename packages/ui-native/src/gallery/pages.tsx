import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import type { NativeComponentName } from "../components.ts";
import { Badge, Card, ListRow, StateChip, Tag } from "../components/data.tsx";
import {
  Banner,
  EmptyState,
  ErrorState,
  InlineAlert,
  RefusalNotice,
  Toast,
  UndoToast,
} from "../components/feedback.tsx";
import {
  Avatar,
  Checkbox,
  DepartmentChip,
  Money,
  ProgressBar,
  QRCode,
  Skeleton,
  Switch,
  TextField,
} from "../components/forms.tsx";
import { Icon, StateIcon, Text } from "../components/foundations.tsx";
import { Sheet, TabBar } from "../components/overlays.tsx";
import { Button, IconButton, SegmentedControl } from "../components/primitives.tsx";
import {
  DaySheetView,
  Dialog,
  ForceUpdateScreen,
  LiveActivity,
  PhotoCapture,
  Screen,
  SignaturePad,
  UpNextCard,
} from "../components/screens.tsx";
import {
  ChecklistRunner,
  ClockButton,
  OfflineBanner,
  QuickIncidentSheet,
  ScanSheet,
  ShiftCard,
  SyncConflictSheet,
} from "../components/compass.tsx";
import {
  CredentialBadge,
  EmergencyCodeCard,
  RadioChannelTable,
  RunOfShowLive,
} from "../components/xos.tsx";
import { ThemeProvider, themeNames, useTheme } from "../theme/index.ts";
import type { RecordState } from "../types.ts";

/**
 * The gallery's pages (A141, Section 11.4): every @xos/ui-native component in its main states, drawn
 * from fixtures alone, so a page looks the same on every run. Each page fits one iPhone screen without
 * scrolling, which is what the Maestro snapshot captures; a component that fills a screen (a camera
 * surface, a sheet, a dialog) has a page of its own. The copy is fixture data for the snapshots, never
 * shown to a person, so it is not translated. Callbacks do nothing.
 */
export interface GalleryEntry {
  readonly component: NativeComponentName;
  readonly render: () => ReactElement;
}

export interface GalleryPage {
  /** Stable slug; the snapshot of page n is named after its position, this names it for people. */
  readonly key: string;
  readonly entries: readonly GalleryEntry[];
}

/** Every callback; a gallery control does nothing when pressed. */
const noop = (): void => undefined;

const STATES: readonly RecordState[] = [
  "proposed",
  "ready",
  "scheduled",
  "active",
  "blocked",
  "in-review",
  "complete",
  "deferred",
  "canceled",
];

const STATE_LABELS: Readonly<Record<RecordState, string>> = {
  proposed: "Proposed",
  ready: "Ready",
  scheduled: "Scheduled",
  active: "Active",
  blocked: "Blocked",
  "in-review": "In review",
  complete: "Complete",
  deferred: "Deferred",
  canceled: "Canceled",
};

function Row({ children }: { children: ReactNode }): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: theme.space["8"],
      }}
    >
      {children}
    </View>
  );
}

function Column({ children }: { children: ReactNode }): ReactElement {
  const theme = useTheme();
  return <View style={{ gap: theme.space["8"] }}>{children}</View>;
}

/** A fixed-height box for components that fill their parent (Screen, the camera surfaces). */
function Frame({ rows, children }: { rows: number; children: ReactNode }): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        height: theme.density.touchMin * rows,
        overflow: "hidden",
        borderRadius: theme.radius.card,
        borderWidth: theme.strokeWidth.hairline,
        borderColor: theme.color.borderSubtle,
      }}
    >
      {children}
    </View>
  );
}

/** One theme's name on its own canvas and surface, inside a ThemeProvider of that theme. */
function ThemeSwatch(): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        gap: theme.space["4"],
        padding: theme.space["8"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderStrong,
        backgroundColor: theme.color.bgCanvas,
      }}
    >
      <Text variant="label13">{theme.name}</Text>
      <View
        style={{
          height: theme.space["8"],
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.accentDefault,
        }}
      />
    </View>
  );
}

/** The three themes side by side, each drawn by a ThemeProvider of its own. */
function ThemeSwatches(): ReactElement {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: theme.space["8"] }}>
      {themeNames.map((name) => (
        <ThemeProvider key={name} preference={name}>
          <ThemeSwatch />
        </ThemeProvider>
      ))}
    </View>
  );
}

const TYPE_SAMPLES = [
  "heading32",
  "heading24",
  "heading20",
  "heading16",
  "text16",
  "text14",
  "label13",
  "text13",
  "text12",
  "text11",
  "mono13",
] as const;

const TONES = [
  "primary",
  "secondary",
  "tertiary",
  "accent",
  "success",
  "warning",
  "danger",
] as const;

const TABS = [
  { key: "today", label: "Today", icon: "House" },
  { key: "schedule", label: "Schedule", icon: "Calendar", badge: 2 },
  { key: "inbox", label: "Inbox", icon: "Inbox", badge: 12 },
  { key: "more", label: "More", icon: "Menu" },
];

const INCIDENT_TYPES = [
  { key: "injury", label: "Injury", icon: "HardHat", critical: true },
  { key: "fire", label: "Fire", icon: "Siren", critical: true },
  { key: "hazard", label: "Hazard", icon: "TriangleAlert" },
  { key: "damage", label: "Damage", icon: "Wrench" },
  { key: "security", label: "Security", icon: "ShieldAlert" },
  { key: "other", label: "Other", icon: "Flag" },
];

export const galleryPages: readonly GalleryPage[] = [
  {
    key: "foundations",
    entries: [
      {
        component: "ThemeProvider",
        render: () => <ThemeSwatches />,
      },
      {
        component: "Text",
        render: () => (
          <Column>
            {TYPE_SAMPLES.map((variant) => (
              <Text key={variant} variant={variant} numberOfLines={1}>
                {variant} Load-in at Pier 4
              </Text>
            ))}
            <Row>
              {TONES.map((tone) => (
                <Text key={tone} variant="text14" tone={tone}>
                  {tone}
                </Text>
              ))}
            </Row>
          </Column>
        ),
      },
      {
        component: "Icon",
        render: () => (
          <Row>
            <Icon name="Hammer" size={20} />
            <Icon name="Hammer" />
            <Icon name="Hammer" size={28} />
            {TONES.slice(1).map((tone) => (
              <Icon key={tone} name="Bell" tone={tone} />
            ))}
            <Icon name="Siren" label="Emergency" tone="danger" />
          </Row>
        ),
      },
      {
        component: "StateIcon",
        render: () => (
          <Row>
            {STATES.map((state) => (
              <StateIcon key={state} state={state} size={24} />
            ))}
          </Row>
        ),
      },
    ],
  },
  {
    key: "screen",
    entries: [
      {
        component: "Screen",
        render: () => (
          <Column>
            <Frame rows={6}>
              <Screen
                title="Day sheet"
                scroll={false}
                footer={<Button variant="primary" block label="Clock in" />}
              >
                <Text tone="secondary">Load-in starts at 7:00 AM at the north dock.</Text>
              </Screen>
            </Frame>
            <Frame rows={5}>
              <Screen>
                <Text variant="heading20">No title, scrolling</Text>
                <Text tone="secondary">The body scrolls when it is longer than the screen.</Text>
              </Screen>
            </Frame>
          </Column>
        ),
      },
    ],
  },
  {
    key: "buttons",
    entries: [
      {
        component: "Button",
        render: () => (
          <Column>
            <Row>
              <Button variant="primary" label="Primary" />
              <Button variant="secondary" label="Secondary" />
              <Button variant="ghost" label="Ghost" />
              <Button variant="danger" label="Danger" />
            </Row>
            <Row>
              <Button icon="Clock" label="With icon" />
              <Button label="Disabled" disabled />
              <Button variant="primary" label="Disabled" disabled />
            </Row>
            <Button variant="primary" size="lg" icon="ScanLine" block label="Large, full width" />
            <Button
              variant="danger"
              size="lg"
              block
              label="Hold to report"
              holdToConfirm={{ seconds: 1, hint: "Press and hold to send" }}
            />
          </Column>
        ),
      },
      {
        component: "IconButton",
        render: () => (
          <Row>
            <IconButton icon="Search" label="Search" />
            <IconButton icon="Settings" variant="secondary" label="Settings" />
            <IconButton icon="Trash2" label="Delete" disabled />
            <IconButton icon="Plus" variant="secondary" label="Add" disabled />
          </Row>
        ),
      },
    ],
  },
  {
    key: "fields",
    entries: [
      {
        component: "TextField",
        render: () => (
          <Column>
            <TextField
              label="Badge number"
              value="CR-000005"
              onChangeText={noop}
              help="Printed under the photo."
            />
            <TextField
              label="Amount"
              value="12.5"
              keyboard="decimal"
              onChangeText={noop}
              error="Enter an amount of at least 20.00."
            />
            <TextField label="Email" value="" onChangeText={noop} disabled />
          </Column>
        ),
      },
      {
        component: "Checkbox",
        render: () => (
          <Column>
            <Checkbox label="Hard hat checked" checked onChange={noop} />
            <Checkbox label="Hi-vis vest checked" checked={false} onChange={noop} />
            <Checkbox label="Signed by the supervisor" checked disabled onChange={noop} />
          </Column>
        ),
      },
    ],
  },
  {
    key: "choices",
    entries: [
      {
        component: "Switch",
        render: () => (
          <Column>
            <Switch label="Haptics" value onChange={noop} help="A tap you can feel." />
            <Switch label="Sounds" value={false} onChange={noop} />
            <Switch label="Show mode" value disabled onChange={noop} />
          </Column>
        ),
      },
      {
        component: "SegmentedControl",
        render: () => (
          <Column>
            <SegmentedControl
              label="Theme"
              value="dark"
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "sunlight", label: "Sunlight" },
              ]}
              onChange={noop}
            />
            <SegmentedControl
              label="Scan mode"
              value="credential"
              options={[
                { value: "asset", label: "Asset", icon: "Package" },
                { value: "credential", label: "Badge", icon: "IdCard" },
              ]}
              onChange={noop}
            />
          </Column>
        ),
      },
      {
        component: "Money",
        render: () => (
          <Column>
            <Money amount={128450} currency="USD" unpricedLabel="Not priced" />
            <Money amount={9900} currency="EUR" unpricedLabel="Not priced" />
            <Money amount={null} unpricedLabel="Not priced" />
          </Column>
        ),
      },
    ],
  },
  {
    key: "cards-and-rows",
    entries: [
      {
        component: "Card",
        render: () => (
          <Column>
            <Card
              title="North dock"
              meta={<Tag tone="accent" label="Load-in" />}
              footer={<Button label="Directions" icon="Navigation" />}
            >
              <Text tone="secondary">Trucks unload from 7:00 AM; bring a hard hat.</Text>
            </Card>
            <Card onPress={noop}>
              <Text>A card without a title opens its record when tapped.</Text>
            </Card>
          </Column>
        ),
      },
      {
        component: "ListRow",
        render: () => (
          <Column>
            <ListRow
              title="Stage Manager"
              subtitle="Fri, Nov 6 · 8:00 AM to 6:00 PM"
              icon="Calendar"
              trailing={<Badge count={3} tone="accent" />}
              onPress={noop}
            />
            <ListRow
              title="Check the rigging points"
              subtitle="Swipe to complete or snooze"
              icon="ListChecks"
              swipeStart={{ label: "Complete", icon: "Check", tone: "success", onAction: noop }}
              swipeEnd={{ label: "Snooze", icon: "Clock", tone: "warning", onAction: noop }}
            />
            <ListRow title="A row with a title only" />
          </Column>
        ),
      },
    ],
  },
  {
    key: "chips",
    entries: [
      {
        component: "StateChip",
        render: () => (
          <Column>
            <Row>
              {STATES.map((state) => (
                <StateChip key={state} state={state} label={STATE_LABELS[state]} />
              ))}
            </Row>
            <Row>
              {STATES.map((state) => (
                <StateChip key={state} state={state} label={STATE_LABELS[state]} compact />
              ))}
            </Row>
          </Column>
        ),
      },
      {
        component: "DepartmentChip",
        render: () => (
          <Row>
            <DepartmentChip code="1000" name="Executive" />
            <DepartmentChip code="4000" name="Production" />
            <DepartmentChip code="6000" name="Operations" />
            <DepartmentChip code="9000" name="Hospitality" />
          </Row>
        ),
      },
      {
        component: "Tag",
        render: () => (
          <Row>
            <Tag label="Neutral" />
            <Tag tone="accent" label="Accent" />
            <Tag tone="success" label="Success" />
            <Tag tone="warning" label="Warning" />
            <Tag tone="danger" label="Danger" />
          </Row>
        ),
      },
      {
        component: "Badge",
        render: () => (
          <Row>
            <Badge count={1} />
            <Badge count={12} tone="accent" />
            <Badge count={120} tone="danger" label="120 unread" />
          </Row>
        ),
      },
    ],
  },
  {
    key: "display",
    entries: [
      {
        component: "Avatar",
        render: () => (
          <Row>
            <Avatar name="Dana Ortiz" />
            <Avatar name="Sam Lee" size="lg" />
            <Avatar name="Ana" />
          </Row>
        ),
      },
      {
        component: "ProgressBar",
        render: () => (
          <Column>
            <ProgressBar label="Not started" value={0} />
            <ProgressBar label="Checklist" value={40} />
            <ProgressBar label="Done" value={100} />
          </Column>
        ),
      },
      {
        component: "Skeleton",
        render: () => (
          <Column>
            <Skeleton lines={3} />
            <Skeleton width="60%" height={24} />
          </Column>
        ),
      },
      {
        component: "QRCode",
        render: () => <QRCode value="NW-CRD-12" label="Badge code" size={144} />,
      },
    ],
  },
  {
    key: "alerts",
    entries: [
      {
        component: "Banner",
        render: () => (
          <Column>
            <Banner tone="info" message="A new version of the day sheet is out." />
            <Banner tone="success" icon="CircleCheck" message="Your timesheet was approved." />
            <Banner tone="warning" message="Weather hold until 2:00 PM." />
            <Banner
              tone="danger"
              icon="WifiOff"
              message="You are offline."
              actionLabel="Retry"
              onAction={noop}
              onDismiss={noop}
              dismissLabel="Dismiss"
            />
          </Column>
        ),
      },
      {
        component: "InlineAlert",
        render: () => (
          <Column>
            <InlineAlert tone="info" message="Changes save as you type." />
            <InlineAlert tone="success" message="Saved." />
            <InlineAlert tone="warning" title="Permit expires soon" message="Renew by Nov 4." />
            <InlineAlert tone="danger" title="Blocked" message="The rigging permit is missing." />
          </Column>
        ),
      },
    ],
  },
  {
    key: "messages",
    entries: [
      {
        component: "Toast",
        render: () => (
          <Column>
            <Toast message="Shift saved." actionLabel="View" onAction={noop} />
            <Toast message="Photo added." />
          </Column>
        ),
      },
      {
        component: "UndoToast",
        render: () => <UndoToast message="Task deleted." undoLabel="Undo" onUndo={noop} />,
      },
      {
        component: "EmptyState",
        render: () => (
          <EmptyState
            icon="Inbox"
            sentence="No messages yet. Messages from your crew lead show here."
            actionLabel="Message the crew lead"
            onAction={noop}
          />
        ),
      },
      {
        component: "ErrorState",
        render: () => (
          <ErrorState
            title="Could not load the day sheet"
            sentence="Check your connection, then try again."
            actionLabel="Try again"
            reference="REF-7Q2K"
            onRetry={noop}
          />
        ),
      },
    ],
  },
  {
    key: "refusals",
    entries: [
      {
        component: "RefusalNotice",
        render: () => (
          <Column>
            <RefusalNotice
              outcome="NO_ANSWER"
              title="No answer yet"
              reason="Your supervisor has not answered the swap request."
            />
            <RefusalNotice
              outcome="UNRATIFIED"
              title="Waiting for approval"
              reason="The overtime needs the production manager's approval."
              actionLabel="Ask again"
              onAction={noop}
            />
            <RefusalNotice
              outcome="REFUSE"
              title="Not allowed"
              reason="You are not rostered on this show."
            />
          </Column>
        ),
      },
    ],
  },
  {
    key: "tab-bar",
    entries: [
      {
        component: "TabBar",
        render: () => (
          <Column>
            <TabBar
              label="Main"
              items={TABS}
              active="today"
              onSelect={noop}
              center={{ label: "Scan", icon: "ScanLine", onPress: noop }}
            />
            <TabBar label="Main" items={TABS.slice(0, 3)} active="inbox" onSelect={noop} />
          </Column>
        ),
      },
    ],
  },
  {
    key: "sheet",
    entries: [
      {
        component: "Sheet",
        render: () => (
          <Sheet
            open
            title="Shift details"
            onClose={noop}
            closeLabel="Close"
            footer={<Button variant="primary" size="lg" block label="Accept shift" />}
          >
            <Text>Stage Manager at Northwind Pier, Fri, Nov 6, 8:00 AM to 6:00 PM.</Text>
            <Text tone="secondary">Call time 7:30 AM at the crew entrance.</Text>
          </Sheet>
        ),
      },
    ],
  },
  {
    key: "dialog",
    entries: [
      {
        component: "Dialog",
        render: () => (
          <Dialog
            open
            danger
            title="Delete this photo?"
            message="The photo is removed from the incident report."
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onConfirm={noop}
            onCancel={noop}
          />
        ),
      },
    ],
  },
  {
    key: "emergency-code",
    entries: [
      {
        component: "EmergencyCodeCard",
        render: () => (
          <EmergencyCodeCard
            code="Code Red"
            name="Fire"
            swatch="ecode-red"
            domain="Venue"
            recordKey="NW-ECD-1"
            channel="Channel 1"
            steps={[
              "Call {fire}.",
              "Evacuate by the nearest marked exit.",
              "Meet at the assembly point.",
            ]}
            authorities={[
              { service: "fire", agency: "Miami Fire Rescue", contact: "911" },
              { service: "ems", agency: "Miami-Dade EMS" },
            ]}
            serviceLabels={{ fire: "Fire", ems: "EMS" }}
          />
        ),
      },
    ],
  },
  {
    key: "radio-and-run-of-show",
    entries: [
      {
        component: "RadioChannelTable",
        render: () => (
          <RadioChannelTable
            caption="Radio plan"
            headers={{ zone: "Zone", channel: "Channel", assignment: "Assignment", notes: "Notes" }}
            channels={[
              { zone: 1, channel: 1, assignment: "Production", notes: "" },
              { zone: 1, channel: 3, assignment: "Stage", notes: "Quiet during show" },
              { zone: 2, channel: 1, assignment: "Security", notes: "" },
            ]}
          />
        ),
      },
      {
        component: "RunOfShowLive",
        render: () => (
          <RunOfShowLive
            cues={[
              { number: "Q1", time: "8:00", title: "House to half", dept: "4000" },
              { number: "Q2", time: "8:01", title: "Walk-in music out" },
              { number: "Q3", time: "8:02", title: "Lights up", durationSeconds: 90 },
            ]}
            current={1}
            nextInSeconds={130}
            nextLabel="Next"
            countdownLabel="2 min 10 s to Lights up"
          />
        ),
      },
    ],
  },
  {
    key: "run-of-show-show-mode",
    entries: [
      {
        component: "RunOfShowLive",
        render: () => (
          <RunOfShowLive
            cues={[
              { number: "Q7", time: "9:14", title: "Encore" },
              { number: "Q8", time: "9:20", title: "House lights up" },
            ]}
            current={0}
            nextInSeconds={8}
            nextLabel="Next"
            showMode
          />
        ),
      },
    ],
  },
  {
    key: "credential",
    entries: [
      {
        component: "CredentialBadge",
        render: () => (
          <CredentialBadge
            org="Northwind Live"
            name="Dana Ortiz"
            role="Stage Manager"
            category="All Access"
            categoryColor={3}
            credentialKey="NW-CRD-12"
            payload="xos1.NW-CRD-12.gallery"
            zones={["Stage", "FOH", "Backstage"]}
            validFrom="Nov 1"
            validTo="Nov 8"
          />
        ),
      },
    ],
  },
  {
    key: "clock",
    entries: [
      {
        component: "ClockButton",
        render: () => (
          <Column>
            <ClockButton
              state="out"
              label="Clock in"
              geofence="You're at the venue"
              geofenceOk
              onPress={noop}
            />
            <ClockButton state="on" label="On shift" timer="2:14:05" detail="Since 7:58 AM" />
            <ClockButton state="break" label="On break" timer="0:12:40" />
            <ClockButton
              state="blocked"
              label="Clock in"
              detail="You are outside the venue."
              geofence="1.2 mi from Northwind Pier"
            />
          </Column>
        ),
      },
    ],
  },
  {
    key: "shifts",
    entries: [
      {
        component: "ShiftCard",
        render: () => (
          <Column>
            <ShiftCard
              state="scheduled"
              stateLabel="Scheduled"
              countdown="Starts in 2 h"
              role="Stage Manager"
              date="Fri, Nov 6"
              time="8:00 AM to 6:00 PM"
              place="Northwind Pier"
              actions={<Button variant="primary" label="Clock in" />}
            />
            <ShiftCard
              state="proposed"
              stateLabel="Offered"
              role="Rigger"
              date="Sat, Nov 7"
              time="6:00 AM to 2:00 PM"
              place="Bayfront Park"
              onPress={noop}
            />
          </Column>
        ),
      },
      {
        component: "OfflineBanner",
        render: () => (
          <Column>
            <OfflineBanner
              message="Offline. Changes upload when you reconnect."
              queued={3}
              queuedLabel="3 queued"
              viewLabel="View"
              onView={noop}
            />
            <OfflineBanner message="Offline." queued={0} />
          </Column>
        ),
      },
    ],
  },
  {
    key: "scan",
    entries: [
      {
        component: "ScanSheet",
        render: () => (
          <Frame rows={14}>
            <ScanSheet
              mode="credential"
              modes={[
                { value: "asset", label: "Asset" },
                { value: "receiving", label: "Receive" },
                { value: "credential", label: "Badge" },
              ]}
              onModeChange={noop}
              hint="Point the camera at a badge."
              count={4}
              countLabel="scanned"
              doneLabel="Done"
              onDone={noop}
              last={{ ok: true, title: "Access granted", code: "CR-000005" }}
              nfc={{ label: "Read NFC", onPress: noop }}
            />
          </Frame>
        ),
      },
    ],
  },
  {
    key: "incident",
    entries: [
      {
        component: "QuickIncidentSheet",
        render: () => (
          <QuickIncidentSheet
            types={INCIDENT_TYPES}
            location="Level 4, north stair"
            onChangeLocation={noop}
            step={1}
            selected="hazard"
            onSelectType={noop}
            submitLabel="Send report"
            holdHint="Press and hold to send"
            onSubmit={noop}
            labels={{
              step: "Step 1 of 3",
              location: "Location",
              change: "Change",
              typeGroup: "Incident type",
            }}
          />
        ),
      },
    ],
  },
  {
    key: "checklist",
    entries: [
      {
        component: "ChecklistRunner",
        render: () => (
          <ChecklistRunner
            title="Rigging inspection"
            index={1}
            items={[
              { code: "R1", label: "Shackles are moused", result: "pass" },
              {
                code: "R2",
                label: "Slings are tagged and undamaged",
                help: "Check the tag and look for cuts or burns.",
                result: null,
              },
              { code: "R3", label: "Safety cables are fitted", result: null },
            ]}
            onResult={noop}
            onIndexChange={noop}
            labels={{
              pass: "Pass",
              fail: "Fail",
              progress: "2 of 3",
              previous: "Previous",
              next: "Next",
            }}
          />
        ),
      },
    ],
  },
  {
    key: "day-sheet",
    entries: [
      {
        component: "DaySheetView",
        render: () => (
          <DaySheetView
            date="Fri, Nov 6"
            title="Northwind Live, day 2"
            venue="Northwind Pier"
            entries={[
              { time: "7:00 AM", label: "Load-in" },
              { time: "12:00 PM", label: "Lunch" },
              { time: "4:00 PM", label: "Sound check", now: true },
              { time: "7:00 PM", label: "Doors" },
              { time: "8:00 PM", label: "Show" },
            ]}
            contacts={[
              { name: "Dana Ortiz", role: "Stage Manager", onCall: noop },
              { name: "Sam Lee", role: "Production Manager", onCall: noop },
            ]}
            labels={{ schedule: "Schedule", contacts: "Contacts", call: "Call" }}
          />
        ),
      },
    ],
  },
  {
    key: "capture",
    entries: [
      {
        component: "SignaturePad",
        render: () => (
          <SignaturePad
            label="Signature"
            attestation="I confirm the delivery arrived complete."
            clearLabel="Clear"
            onChange={noop}
          />
        ),
      },
      {
        component: "PhotoCapture",
        render: () => (
          <Frame rows={7}>
            <PhotoCapture
              hint="Photograph the damage."
              count={2}
              captureLabel="Take photo"
              onCapture={noop}
              doneLabel="Done"
              onDone={noop}
              annotateLabel="Annotate"
              onAnnotate={noop}
            />
          </Frame>
        ),
      },
    ],
  },
  {
    key: "live-activity",
    entries: [
      {
        component: "LiveActivity",
        render: () => (
          <Column>
            <LiveActivity
              label="On shift"
              elapsed="2:14"
              place="Northwind Pier"
              nextShift="Stage Manager"
              nextTime="8:00 AM to 6:00 PM"
              nextPlace="Northwind Pier"
              labels={{ break: "Break", endBreak: "End break", clockOut: "Clock out" }}
              onToggleBreak={noop}
              onClockOut={noop}
            />
            <LiveActivity
              label="On break"
              elapsed="0:12"
              place="Northwind Pier"
              nextShift=""
              nextTime=""
              onBreak
              labels={{ break: "Break", endBreak: "End break", clockOut: "Clock out" }}
              onToggleBreak={noop}
              onClockOut={noop}
            />
          </Column>
        ),
      },
    ],
  },
  {
    key: "force-update",
    entries: [
      {
        component: "ForceUpdateScreen",
        render: () => (
          <Frame rows={9}>
            <ForceUpdateScreen
              message="This version of Compass is no longer supported. Update to keep working."
              version="Version 4.0.0 · minimum 4.1.0"
              actionLabel="Update Compass"
              onUpdate={noop}
            />
          </Frame>
        ),
      },
    ],
  },
  {
    key: "sync-conflict",
    entries: [
      {
        component: "SyncConflictSheet",
        render: () => (
          <SyncConflictSheet
            message="This field changed on the server while you were offline."
            field="Call time"
            mine="7:30 AM"
            mineMeta="You, 9:02 AM, offline"
            theirs="8:00 AM"
            theirsMeta="Sam Lee, 9:05 AM"
            onKeepMine={noop}
            onKeepTheirs={noop}
            labels={{
              mine: "Yours",
              theirs: "On the server",
              keepMine: "Keep yours",
              keepTheirs: "Keep the server's",
            }}
          />
        ),
      },
    ],
  },
  {
    key: "up-next",
    entries: [
      {
        component: "UpNextCard",
        render: () => (
          <UpNextCard
            org="Northwind Live"
            countdown="In 2 days"
            title="Stage Manager, Northwind Live day 2"
            when="Fri, Nov 6 · 8:00 AM to 6:00 PM"
            callTime="Call time 7:30 AM"
            address="1 Pier Way, Miami, FL"
            parking="Lot B, show your badge"
            contact="Dana Ortiz, (305) 555-0142"
            bring={["Hard hat", "Steel-toe boots", "Badge"]}
            onDirections={noop}
            directionsLabel="Directions"
          />
        ),
      },
    ],
  },
];

/** The pages a component appears on, in order. */
export function pagesShowing(component: NativeComponentName): number[] {
  return galleryPages.flatMap((page, index) =>
    page.entries.some((entry) => entry.component === component) ? [index + 1] : [],
  );
}
