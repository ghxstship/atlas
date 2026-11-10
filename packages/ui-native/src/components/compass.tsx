import type { ReactElement, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useHaptic, useTheme } from "../theme/index.ts";
import type {
  ChecklistRunnerProps,
  ClockButtonProps,
  OfflineBannerProps,
  QuickIncidentSheetProps,
  ScanSheetProps,
  ShiftCardProps,
  SyncConflictSheetProps,
} from "../types.ts";
import { StateChip } from "./data.tsx";
import { Icon, IconInk, Ink, Text } from "./foundations.tsx";
import { Button, IconButton, SegmentedControl } from "./primitives.tsx";

const thumb = (touchMin: number) => touchMin * 2;

/**
 * The Today screen's one primary control. It changes with the person's state (Clock In, On Shift
 * with the timer, Break, or blocked) and shows the geofence before the tap (Section 11.13).
 */
export function ClockButton({
  state,
  label,
  detail,
  timer,
  geofence,
  geofenceOk = false,
  onPress,
  haptics = true,
  testID,
}: ClockButtonProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const blocked = state === "blocked";
  const look = {
    out: { bg: theme.color.accentDefault, fg: theme.color.accentTextOn, ring: "transparent" },
    on: { bg: theme.color.bgRaised, fg: theme.color.textPrimary, ring: theme.color.success },
    break: { bg: theme.color.bgRaised, fg: theme.color.textPrimary, ring: theme.color.warning },
    blocked: {
      bg: theme.color.bgSurface,
      fg: theme.color.textSecondary,
      ring: theme.color.borderStrong,
    },
  }[state];
  const name = [timer, label, detail].filter(Boolean).join(", ");
  return (
    <View style={{ gap: theme.space["8"], alignSelf: "stretch" }}>
      {geofence ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
          <IconInk
            name="MapPin"
            size={20}
            color={geofenceOk ? theme.color.success : theme.color.warning}
          />
          <Text variant="text14" tone="secondary">
            {geofence}
          </Text>
        </View>
      ) : null}
      <Pressable
        role="button"
        aria-label={name}
        aria-disabled={blocked || undefined}
        disabled={blocked}
        {...(testID === undefined ? {} : { testID })}
        onPress={() => {
          if (haptics) haptic(state === "out" ? "success" : "impact");
          onPress?.();
        }}
        style={({ pressed }) => ({
          minHeight: thumb(theme.density.touchMin),
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space["4"],
          padding: theme.space["16"],
          borderRadius: theme.radius.dialog,
          borderWidth: state === "out" ? 0 : theme.strokeWidth.focus,
          borderColor: look.ring,
          backgroundColor: look.bg,
          opacity: pressed ? 1 - theme.opacity.pressed : 1,
        })}
      >
        {timer ? (
          <Ink variant="heading32" color={look.fg}>
            {timer}
          </Ink>
        ) : null}
        <Ink variant="heading20" color={look.fg}>
          {label}
        </Ink>
        {detail ? (
          <Ink variant="text14" color={look.fg}>
            {detail}
          </Ink>
        ) : null}
      </Pressable>
    </View>
  );
}

function Fact({ icon, children }: { icon: string; children: ReactNode }): ReactElement {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
      <Icon name={icon} size={20} tone="secondary" />
      <Text>{children}</Text>
    </View>
  );
}

/** A shift with state, countdown, role, date, time and place, and its actions. */
export function ShiftCard({
  state,
  stateLabel,
  countdown,
  role,
  date,
  time,
  place,
  actions,
  onPress,
  testID,
}: ShiftCardProps): ReactElement {
  const theme = useTheme();
  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <StateChip state={state} label={stateLabel} />
        {countdown ? (
          <Text variant="text14" tone="secondary">
            {countdown}
          </Text>
        ) : null}
      </View>
      <Text variant="heading16" heading>
        {role}
      </Text>
      <View style={{ gap: theme.space["6"] }}>
        <Fact icon="Calendar">{date}</Fact>
        <Fact icon="Clock">{time}</Fact>
        <Fact icon="MapPin">{place}</Fact>
      </View>
    </>
  );
  const frame = {
    gap: theme.space["12"],
    padding: theme.space["16"],
    borderRadius: theme.radius.dialog,
    borderWidth: theme.controlBorderWidth,
    borderColor: theme.color.borderSubtle,
    backgroundColor: theme.color.bgRaised,
  };
  return (
    <View {...(testID === undefined ? {} : { testID })} style={frame}>
      {onPress ? (
        <Pressable role="button" aria-label={`${role}, ${date}, ${time}`} onPress={onPress}>
          <View style={{ gap: theme.space["12"] }}>{body}</View>
        </Pressable>
      ) : (
        body
      )}
      {actions ? (
        <View style={{ flexDirection: "row", gap: theme.space["8"] }}>{actions}</View>
      ) : null}
    </View>
  );
}

/** Offline state with the count of writes waiting to upload (Section 13). */
export function OfflineBanner({
  message,
  queued,
  queuedLabel,
  viewLabel,
  onView,
  testID,
}: OfflineBannerProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      role="alert"
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["8"],
        paddingHorizontal: theme.space["12"],
        paddingVertical: theme.space["8"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.warning,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <IconInk name="WifiOff" size={20} color={theme.color.warning} />
      <View style={{ flex: 1 }}>
        <Text variant="text14">{message}</Text>
      </View>
      <View
        role="img"
        aria-label={queuedLabel ?? String(queued)}
        style={{
          paddingHorizontal: theme.space["6"],
          borderRadius: theme.radius.chip,
          backgroundColor: theme.color.bgHover,
        }}
      >
        <Text variant="label13">{queued}</Text>
      </View>
      {onView && viewLabel ? <Button variant="ghost" label={viewLabel} onPress={onView} /> : null}
    </View>
  );
}

/** Continuous scanning: viewfinder, last result, running count, NFC, and Done for the batch review. */
export function ScanSheet({
  mode,
  modes,
  onModeChange,
  hint,
  count,
  countLabel,
  doneLabel,
  onDone,
  last,
  camera,
  nfc,
  testID,
}: ScanSheetProps): ReactElement {
  const theme = useTheme();
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ flex: 1 }}>
      {modes && onModeChange ? (
        <View style={{ padding: theme.space["12"] }}>
          <SegmentedControl
            label={modes.find((m) => m.value === mode)?.label ?? mode}
            value={mode}
            options={modes}
            onChange={(v) => onModeChange(v as ScanSheetProps["mode"])}
          />
        </View>
      ) : null}
      <View
        style={{
          flex: 1,
          minHeight: theme.density.touchMin * 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.color.cameraBg,
        }}
      >
        {camera ?? null}
        <View
          aria-hidden
          style={{
            position: "absolute",
            width: theme.space["20"] * 11,
            height: theme.space["20"] * 7,
            borderRadius: theme.radius.dialog,
            borderWidth: theme.strokeWidth.focus,
            borderColor: theme.color.cameraInk,
          }}
        />
        <View style={{ position: "absolute", bottom: theme.space["16"] }}>
          <Ink variant="text14" color={theme.color.cameraInk}>
            {hint}
          </Ink>
        </View>
      </View>
      <View style={{ gap: theme.space["12"], padding: theme.space["16"] }}>
        {last ? (
          <View
            role="alert"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space["12"],
              padding: theme.space["12"],
              borderRadius: theme.radius.card,
              borderWidth: theme.strokeWidth.focus,
              borderColor: last.ok ? theme.color.success : theme.color.danger,
              backgroundColor: theme.color.bgSurface,
            }}
          >
            <IconInk
              name={last.ok ? "CircleCheck" : "CircleX"}
              color={last.ok ? theme.color.success : theme.color.danger}
            />
            <View>
              <Text variant="heading16">{last.title}</Text>
              <Text variant="mono13" tone="secondary">
                {last.code}
              </Text>
            </View>
          </View>
        ) : null}
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <View
            accessible
            aria-label={`${count} ${countLabel}`}
            style={{ flexDirection: "row", alignItems: "baseline", gap: theme.space["6"] }}
          >
            <Text variant="heading24">{count}</Text>
            <Text tone="secondary">{countLabel}</Text>
          </View>
          {nfc ? <IconButton icon="Nfc" label={nfc.label} onPress={nfc.onPress} /> : null}
        </View>
        <Button variant="primary" size="lg" block label={doneLabel} onPress={onDone} />
      </View>
    </View>
  );
}

/** Resolves an offline write that collided with a newer server value. */
export function SyncConflictSheet({
  message,
  field,
  mine,
  mineMeta,
  theirs,
  theirsMeta,
  onKeepMine,
  onKeepTheirs,
  labels,
  testID,
}: SyncConflictSheetProps): ReactElement {
  const theme = useTheme();
  const side = (who: string, value: string, meta: string) => (
    <View
      style={{
        gap: theme.space["2"],
        padding: theme.space["12"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderControl,
      }}
    >
      <Text variant="text14" tone="secondary">
        {who}
        {" · "}
        {meta}
      </Text>
      <Text variant="heading16">{value}</Text>
    </View>
  );
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["12"] }}>
      <Text tone="secondary">{message}</Text>
      <Text variant="label13">{field}</Text>
      {side(labels.mine, mine, mineMeta)}
      {side(labels.theirs, theirs, theirsMeta)}
      <Button variant="primary" size="lg" block label={labels.keepMine} onPress={onKeepMine} />
      <Button size="lg" block label={labels.keepTheirs} onPress={onKeepTheirs} />
    </View>
  );
}

/**
 * The three-step incident report: type grid, confirmed location, then photos or a voice note and
 * submit. A critical type submits only after hold to confirm (Section 11.13).
 */
export function QuickIncidentSheet({
  types,
  location,
  onChangeLocation,
  step,
  selected,
  onSelectType,
  attachments,
  submitLabel,
  holdHint,
  onSubmit,
  labels,
  testID,
}: QuickIncidentSheetProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const critical = types.find((t) => t.key === selected)?.critical === true;
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["16"] }}>
      <Text variant="text14" tone="secondary">
        {labels.step}
      </Text>
      {step === 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["8"] }}>
          {types.map((type) => {
            const on = type.key === selected;
            const ink = type.critical ? theme.color.danger : theme.color.textPrimary;
            return (
              <Pressable
                key={type.key}
                role="radio"
                aria-checked={on}
                aria-label={type.label}
                onPress={() => {
                  haptic("selection");
                  onSelectType(type.key);
                }}
                style={{
                  flexBasis: "31%",
                  flexGrow: 1,
                  minHeight: thumb(theme.density.touchMin),
                  alignItems: "center",
                  justifyContent: "center",
                  gap: theme.space["8"],
                  padding: theme.space["8"],
                  borderRadius: theme.radius.card,
                  borderWidth: on ? theme.strokeWidth.focus : theme.controlBorderWidth,
                  borderColor: on
                    ? theme.color.accentDefault
                    : type.critical
                      ? theme.color.danger
                      : theme.color.borderControl,
                  backgroundColor: on ? theme.color.bgHover : theme.color.bgSurface,
                }}
              >
                <IconInk name={type.icon} size={28} color={ink} />
                <Text variant="label13">{type.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {step === 2 ? (
        <View style={{ gap: theme.space["8"] }}>
          <Text variant="label13">{labels.location}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
            <Icon name="MapPin" size={20} tone="secondary" />
            <View style={{ flex: 1 }}>
              <Text>{location}</Text>
            </View>
            {onChangeLocation ? (
              <Button variant="ghost" label={labels.change} onPress={onChangeLocation} />
            ) : null}
          </View>
        </View>
      ) : null}
      {step === 3 ? (
        <View style={{ gap: theme.space["12"] }}>
          {attachments ?? null}
          <Button
            variant={critical ? "danger" : "primary"}
            size="lg"
            block
            label={submitLabel}
            onPress={onSubmit}
            {...(critical ? { holdToConfirm: { seconds: 1, hint: holdHint } } : {})}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Inspection runner: one item per card, large Pass and Fail; a Fail shows the photo and note surface. */
export function ChecklistRunner({
  title,
  index,
  items,
  onResult,
  onIndexChange,
  failDetail,
  labels,
  testID,
}: ChecklistRunnerProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const item = items[index];
  const done = items.filter((i) => i.result !== null).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  const choice = (pass: boolean) => {
    const on = item?.result === (pass ? "pass" : "fail");
    const tone = pass ? theme.color.success : theme.color.danger;
    return (
      <Pressable
        role="button"
        aria-pressed={on}
        aria-label={pass ? labels.pass : labels.fail}
        disabled={!item}
        onPress={() => {
          if (!item) return;
          haptic(pass ? "success" : "warning");
          onResult(item.code, pass ? "pass" : "fail");
        }}
        style={{
          flex: 1,
          minHeight: thumb(theme.density.touchMin),
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space["4"],
          borderRadius: theme.radius.dialog,
          borderWidth: on ? theme.strokeWidth.focus : theme.controlBorderWidth,
          borderColor: on ? tone : theme.color.borderControl,
          backgroundColor: on ? theme.color.bgHover : theme.color.bgSurface,
        }}
      >
        <IconInk name={pass ? "Check" : "X"} size={28} color={tone} />
        <Text variant="heading20">{pass ? labels.pass : labels.fail}</Text>
      </Pressable>
    );
  };
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{ gap: theme.space["12"], padding: theme.space["16"] }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text variant="heading16" heading>
          {title}
        </Text>
        <Text variant="text14" tone="secondary">
          {labels.progress}
        </Text>
      </View>
      <View
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{
          height: theme.space["4"],
          borderRadius: theme.radius.pill,
          overflow: "hidden",
          backgroundColor: theme.color.bgHover,
        }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: "100%",
            backgroundColor: theme.color.accentDefault,
          }}
        />
      </View>
      {item ? (
        <View
          style={{
            gap: theme.space["8"],
            padding: theme.space["20"],
            minHeight: theme.density.touchMin * 3,
            borderRadius: theme.radius.dialog,
            borderWidth: theme.controlBorderWidth,
            borderColor: theme.color.borderSubtle,
            backgroundColor: theme.color.bgRaised,
          }}
        >
          <Text variant="mono13" tone="secondary">
            {item.code}
          </Text>
          <Text variant="heading20" heading>
            {item.label}
          </Text>
          {item.help ? <Text tone="secondary">{item.help}</Text> : null}
          {item.result === "fail" ? (failDetail ?? null) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: theme.space["12"] }}>
        {choice(false)}
        {choice(true)}
      </View>
      {onIndexChange ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Button
            variant="ghost"
            label={labels.previous}
            disabled={index <= 0}
            onPress={() => onIndexChange(index - 1)}
          />
          <Button
            variant="ghost"
            label={labels.next}
            disabled={index >= items.length - 1}
            onPress={() => onIndexChange(index + 1)}
          />
        </View>
      ) : null}
    </View>
  );
}
