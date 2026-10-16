/**
 * Compass components for the @xos/ui-native seam: ClockButton, ShiftCard, ScanSheet, QuickIncidentSheet,
 * ChecklistRunner, RunOfShowLive, SyncConflictSheet, QRCode and CredentialBadge.
 */
import type {
  ChecklistRunnerProps,
  ClockButtonProps,
  CredentialBadgeProps,
  QRCodeProps,
  QuickIncidentSheetProps,
  RunOfShowLiveProps,
  ScanSheetProps,
  ShiftCardProps,
  SyncConflictSheetProps,
} from "@xos/ui-native";
import { useTheme } from "@xos/ui-native/theme";
import * as Haptics from "expo-haptics";
import qrcode from "qrcode-generator";
import { useMemo, type ReactElement } from "react";
import { Pressable, Text as NativeText, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Card, ProgressBar, Tag } from "./layout";
import { Button, Icon, SegmentedControl, Text, tid, typography } from "./primitives";

/**
 * The Today screen's one button (Section 11.13 Clock): Clock In, On Shift with a timer, Break, Clock Out.
 * The geofence status shows before the tap.
 */
export function ClockButton({
  state,
  label,
  detail,
  timer,
  geofence,
  geofenceOk,
  onPress,
  haptics = true,
  testID,
}: ClockButtonProps): ReactElement {
  const theme = useTheme();
  const blocked = state === "blocked";
  const bg = blocked
    ? theme.color.bgRaised
    : state === "out"
      ? theme.color.accentDefault
      : state === "break"
        ? theme.color.warning
        : theme.color.success;
  const fg = blocked
    ? theme.color.textSecondary
    : state === "out"
      ? theme.color.accentTextOn
      : theme.color.dangerTextOn;
  return (
    <View style={{ gap: theme.space["8"] }}>
      {geofence ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
          <Icon
            name={geofenceOk ? "map-pin-check" : "map-pin-off"}
            size={20}
            tone={geofenceOk ? "success" : "warning"}
          />
          <Text
            variant="text14"
            tone={geofenceOk ? "success" : "warning"}
            {...tid(testID, "geofence")}
          >
            {geofence}
          </Text>
        </View>
      ) : null}
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={timer ? `${label}, ${timer}` : label}
        accessibilityHint={detail}
        accessibilityState={{ disabled: blocked }}
        disabled={blocked}
        onPress={() => {
          if (haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onPress?.();
        }}
        style={({ pressed }) => ({
          minHeight: theme.space["64"] + theme.space["32"],
          borderRadius: theme.radius.dialog,
          backgroundColor: bg,
          opacity: pressed ? 1 - theme.opacity.pressed : 1,
          alignItems: "center",
          justifyContent: "center",
          padding: theme.space["16"],
          gap: theme.space["4"],
        })}
      >
        <NativeText
          maxFontSizeMultiplier={2}
          style={[typography(theme, "heading24"), { color: fg, textAlign: "center" }]}
        >
          {label}
        </NativeText>
        {timer ? (
          <NativeText
            testID={testID ? `${testID}-timer` : undefined}
            maxFontSizeMultiplier={2}
            style={[typography(theme, "heading32"), { color: fg, fontVariant: ["tabular-nums"] }]}
          >
            {timer}
          </NativeText>
        ) : null}
        {detail ? (
          <NativeText
            maxFontSizeMultiplier={2}
            style={[typography(theme, "text14"), { color: fg, textAlign: "center" }]}
          >
            {detail}
          </NativeText>
        ) : null}
      </Pressable>
    </View>
  );
}

export function ShiftCard({
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
  return (
    <Card
      {...tid(testID)}
      title={role}
      meta={<Tag label={stateLabel} tone="accent" />}
      {...(onPress ? { onPress } : {})}
      footer={actions}
    >
      <View style={{ gap: theme.space["4"] }}>
        <Text tone="secondary">{`${date} · ${time}`}</Text>
        <Text variant="text14" tone="tertiary">
          {place}
        </Text>
        {countdown ? (
          <Text variant="label13" tone="accent">
            {countdown}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

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
    <View testID={testID} style={{ flex: 1, backgroundColor: theme.color.cameraBg }}>
      <View style={{ flex: 1 }}>{camera}</View>
      <View
        style={{
          padding: theme.space["16"],
          gap: theme.space["12"],
          backgroundColor: theme.color.bgSurface,
        }}
      >
        {modes && onModeChange && modes.length > 1 ? (
          <SegmentedControl
            {...tid(testID, "mode")}
            label={hint}
            value={mode}
            options={modes.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(v) => onModeChange(v as ScanSheetProps["mode"])}
          />
        ) : null}
        <Text tone="secondary">{hint}</Text>
        {last ? (
          <View
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}
            testID={testID ? `${testID}-last` : undefined}
          >
            <Icon
              name={last.ok ? "circle-check" : "circle-x"}
              tone={last.ok ? "success" : "danger"}
              size={28}
            />
            <View style={{ flex: 1 }}>
              <Text variant="heading16">{last.title}</Text>
              <Text variant="mono13" tone="tertiary">
                {last.code}
              </Text>
            </View>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["12"] }}>
          <View style={{ flex: 1 }}>
            <Text variant="heading20" {...tid(testID, "count")}>{`${count} ${countLabel}`}</Text>
          </View>
          {nfc ? (
            <Button label={nfc.label} variant="secondary" icon="nfc" onPress={nfc.onPress} />
          ) : null}
          <Button label={doneLabel} onPress={onDone} {...tid(testID, "done")} />
        </View>
      </View>
    </View>
  );
}

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
  const chosen = types.find((t) => t.key === selected);
  return (
    <View testID={testID} style={{ gap: theme.space["16"] }}>
      <Text variant="label13" tone="secondary">
        {labels.step}
      </Text>
      {step === 1 ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={labels.typeGroup ?? labels.step}
          style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["12"] }}
        >
          {types.map((type) => {
            const isSelected = type.key === selected;
            return (
              <Pressable
                key={type.key}
                testID={`incident-type-${type.key}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={type.label}
                onPress={() => onSelectType(type.key)}
                style={{
                  width: "47%",
                  minHeight: theme.space["64"] + theme.space["16"],
                  borderRadius: theme.radius.card,
                  borderWidth: theme.controlBorderWidth + (isSelected ? 1 : 0),
                  borderColor: isSelected
                    ? theme.color.accentDefault
                    : type.critical
                      ? theme.color.danger
                      : theme.color.borderControl,
                  backgroundColor: theme.color.bgSurface,
                  padding: theme.space["12"],
                  justifyContent: "space-between",
                }}
              >
                <Icon name={type.icon} tone={type.critical ? "danger" : "primary"} />
                <Text variant="heading16">{type.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {step === 2 ? (
        <Card title={labels.location}>
          <Text testID="incident-location">{location}</Text>
          {onChangeLocation ? (
            <Button label={labels.change} variant="ghost" onPress={onChangeLocation} />
          ) : null}
        </Card>
      ) : null}
      {step === 3 ? (
        <View style={{ gap: theme.space["16"] }}>
          {attachments}
          <Button
            testID="incident-submit"
            label={submitLabel}
            size="lg"
            block
            variant={chosen?.critical ? "danger" : "primary"}
            onPress={onSubmit}
            {...(chosen?.critical ? { holdToConfirm: { seconds: 1.5, hint: holdHint } } : {})}
          />
        </View>
      ) : null}
    </View>
  );
}

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
  const item = items[index];
  const done = items.filter((i) => i.result !== null).length;
  return (
    <View testID={testID} style={{ gap: theme.space["16"] }}>
      <Text variant="heading20" heading>
        {title}
      </Text>
      <ProgressBar
        label={labels.progress}
        value={items.length === 0 ? 0 : (done / items.length) * 100}
      />
      {item ? (
        <Card>
          <Text variant="heading24" testID="checklist-prompt">
            {item.label}
          </Text>
          {item.help ? <Text tone="secondary">{item.help}</Text> : null}
        </Card>
      ) : null}
      {item ? (
        <View style={{ flexDirection: "row", gap: theme.space["12"] }}>
          <View style={{ flex: 1 }}>
            <Button
              testID="checklist-pass"
              label={labels.pass}
              size="lg"
              block
              icon="check"
              onPress={() => onResult(item.code, "pass")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              testID="checklist-fail"
              label={labels.fail}
              size="lg"
              block
              variant="danger"
              icon="x"
              onPress={() => onResult(item.code, "fail")}
            />
          </View>
        </View>
      ) : null}
      {failDetail}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Button
          label={labels.previous}
          variant="ghost"
          disabled={index <= 0}
          onPress={() => onIndexChange?.(index - 1)}
        />
        <Button
          label={labels.next}
          variant="ghost"
          disabled={index >= items.length - 1}
          onPress={() => onIndexChange?.(index + 1)}
        />
      </View>
    </View>
  );
}

export function RunOfShowLive({
  cues,
  current,
  nextInSeconds,
  showMode,
  nextLabel,
  countdownLabel,
  testID,
}: RunOfShowLiveProps): ReactElement {
  const theme = useTheme();
  const next = cues[current + 1];
  const now = cues[current];
  const big = showMode ? "heading32" : "heading24";
  const minutes = Math.floor(Math.abs(nextInSeconds) / 60);
  const seconds = Math.abs(nextInSeconds) % 60;
  const countdown = `${nextInSeconds < 0 ? "+" : ""}${minutes}:${seconds.toString().padStart(2, "0")}`;
  return (
    <View testID={testID} style={{ gap: theme.space["16"] }}>
      {now ? (
        <Card>
          <Text variant="label13" tone="secondary">
            {now.number}
          </Text>
          <Text variant={big}>{now.title}</Text>
        </Card>
      ) : null}
      {next ? (
        <View style={{ gap: theme.space["8"] }}>
          {/* Only the cue changes the live region. The countdown re-renders twice a second, so it
              stays out of it and is spoken at set points by the screen (A23-009). */}
          <View style={{ gap: theme.space["8"] }} accessibilityLiveRegion="polite">
            <Text variant="label13" tone="accent">
              {nextLabel}
            </Text>
            <Text variant={big} testID="next-cue-title">
              {next.title}
            </Text>
          </View>
          <View accessible accessibilityLabel={countdownLabel ?? countdown}>
            <Text
              variant="heading32"
              tone={nextInSeconds < 0 ? "danger" : "primary"}
              testID="next-cue-countdown"
            >
              {countdown}
            </Text>
          </View>
        </View>
      ) : null}
      {cues.slice(current + 2, current + 5).map((cue) => (
        <View key={cue.number} style={{ flexDirection: "row", gap: theme.space["12"] }}>
          <Text variant="mono13" tone="tertiary">
            {cue.time}
          </Text>
          <Text tone="secondary">{cue.title}</Text>
        </View>
      ))}
    </View>
  );
}

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
  return (
    <View testID={testID} style={{ gap: theme.space["16"] }}>
      <Text>{message}</Text>
      <Text variant="label13" tone="secondary">
        {field}
      </Text>
      <Card title={labels.mine}>
        <Text>{mine}</Text>
        <Text variant="text13" tone="tertiary">
          {mineMeta}
        </Text>
      </Card>
      <Card title={labels.theirs}>
        <Text>{theirs}</Text>
        <Text variant="text13" tone="tertiary">
          {theirsMeta}
        </Text>
      </Card>
      <Button testID="conflict-keep-mine" label={labels.keepMine} block onPress={onKeepMine} />
      <Button
        testID="conflict-keep-theirs"
        label={labels.keepTheirs}
        block
        variant="secondary"
        onPress={onKeepTheirs}
      />
    </View>
  );
}

export function QRCode({ value, label, size, testID }: QRCodeProps): ReactElement {
  const theme = useTheme();
  const side = size ?? theme.space["64"] * 3;
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r += 1)
      for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [value]);
  const quiet = 4;
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg
        width={side}
        height={side}
        viewBox={`${-quiet} ${-quiet} ${path.n + quiet * 2} ${path.n + quiet * 2}`}
      >
        <Rect
          x={-quiet}
          y={-quiet}
          width={path.n + quiet * 2}
          height={path.n + quiet * 2}
          fill={theme.color.paper}
        />
        <Path d={path.d} fill={theme.color.paperInk} />
      </Svg>
    </View>
  );
}

const CATEGORY_COLORS = [
  "vizCat1",
  "vizCat2",
  "vizCat3",
  "vizCat4",
  "vizCat5",
  "vizCat6",
  "vizCat7",
] as const;

/** The badge as an offline QR code (Section 11.13 Credentials). The screen raises brightness while shown. */
export function CredentialBadge({
  org,
  name,
  role,
  category,
  categoryColor,
  credentialKey,
  payload,
  zones,
  validFrom,
  validTo,
  testID,
}: CredentialBadgeProps): ReactElement {
  const theme = useTheme();
  const stripe = theme.color[CATEGORY_COLORS[categoryColor - 1] ?? "vizCat1"];
  return (
    <View
      testID={testID}
      style={{
        borderRadius: theme.radius.dialog,
        overflow: "hidden",
        backgroundColor: theme.color.paper,
      }}
    >
      <View style={{ height: theme.strokeWidth.stripe, backgroundColor: stripe }} />
      <View style={{ padding: theme.space["16"], gap: theme.space["8"], alignItems: "center" }}>
        <NativeText style={[typography(theme, "label13"), { color: theme.color.paperInk }]}>
          {org}
        </NativeText>
        <NativeText style={[typography(theme, "heading24"), { color: theme.color.paperInk }]}>
          {name}
        </NativeText>
        <NativeText
          style={[typography(theme, "text14"), { color: theme.color.paperInk }]}
        >{`${role} · ${category}`}</NativeText>
        <QRCode value={payload} label={credentialKey} />
        <NativeText style={[typography(theme, "mono13"), { color: theme.color.paperInk }]}>
          {credentialKey}
        </NativeText>
        <NativeText
          style={[
            typography(theme, "text13"),
            { color: theme.color.paperInk, textAlign: "center" },
          ]}
        >
          {zones.join(" · ")}
        </NativeText>
        <NativeText
          style={[typography(theme, "text12"), { color: theme.color.paperInk }]}
        >{`${validFrom} – ${validTo}`}</NativeText>
      </View>
    </View>
  );
}
