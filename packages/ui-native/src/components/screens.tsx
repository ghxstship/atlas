import { useMemo, useRef, useState, type ReactElement } from "react";
import { Modal, PanResponder, RefreshControl, ScrollView, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useHaptic, useTheme } from "../theme/index.ts";
import type {
  DaySheetViewProps,
  DialogProps,
  ForceUpdateScreenProps,
  LiveActivityProps,
  PhotoCaptureProps,
  ScreenProps,
  SignaturePadProps,
  UpNextCardProps,
} from "../types.ts";
import { Tag } from "./data.tsx";
import { Icon, IconInk, Text } from "./foundations.tsx";
import { Avatar } from "./forms.tsx";
import { Button, IconButton } from "./primitives.tsx";

/** A screen body: title announced as a heading, scrolling content, pull to refresh and a pinned footer. */
export function Screen({
  title,
  scroll = true,
  refreshing = false,
  onRefresh,
  footer,
  children,
  testID,
}: ScreenProps): ReactElement {
  const theme = useTheme();
  const body = (
    <View style={{ gap: theme.space["16"], padding: theme.space["16"] }}>
      {title ? (
        <Text variant="heading24" heading>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{ flex: 1, backgroundColor: theme.color.bgCanvas }}
    >
      {scroll ? (
        <ScrollView
          {...(onRefresh
            ? {
                refreshControl: (
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.color.textSecondary}
                  />
                ),
              }
            : {})}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {footer ? (
        <View
          style={{
            gap: theme.space["8"],
            padding: theme.space["16"],
            borderTopWidth: theme.strokeWidth.hairline,
            borderTopColor: theme.color.borderSubtle,
            backgroundColor: theme.color.bgSurface,
          }}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

/** A confirmation dialog; `danger` makes the confirm button destructive. */
export function Dialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  testID,
}: DialogProps): ReactElement {
  const theme = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: theme.space["24"],
        }}
      >
        <View
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: theme.color.scrim,
            opacity: theme.dark ? theme.opacity.scrimDark : theme.opacity.scrimLight,
          }}
        />
        <View
          role="alertdialog"
          aria-modal
          aria-label={title}
          {...(testID === undefined ? {} : { testID })}
          style={{
            alignSelf: "stretch",
            gap: theme.space["12"],
            padding: theme.space["20"],
            borderRadius: theme.radius.dialog,
            backgroundColor: theme.color.bgRaised,
            boxShadow: theme.shadow.dialog,
          }}
        >
          <Text variant="heading20" heading>
            {title}
          </Text>
          <Text tone="secondary">{message}</Text>
          <View style={{ gap: theme.space["8"] }}>
            <Button
              variant={danger ? "danger" : "primary"}
              block
              label={confirmLabel}
              onPress={onConfirm}
            />
            <Button variant="ghost" block label={cancelLabel} onPress={onCancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** The day sheet: schedule with the current entry marked, and contacts with one-tap call. */
export function DaySheetView({
  date,
  title,
  venue,
  entries,
  contacts,
  labels,
  testID,
}: DaySheetViewProps): ReactElement {
  const theme = useTheme();
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["16"] }}>
      <View style={{ gap: theme.space["2"] }}>
        <Text tone="secondary">{date}</Text>
        <Text variant="heading20" heading>
          {title}
        </Text>
        <Text tone="secondary">{venue}</Text>
      </View>
      <Text variant="label13" tone="secondary" heading>
        {labels.schedule}
      </Text>
      <View role="list">
        {entries.map((e, i) => (
          <View
            key={i}
            role="listitem"
            aria-current={e.now ? "time" : undefined}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space["12"],
              minHeight: theme.density.touchMin,
              borderBottomWidth: theme.strokeWidth.hairline,
              borderBottomColor: theme.color.borderSubtle,
            }}
          >
            <View style={{ minWidth: theme.space["64"] }}>
              <Text tone="secondary">{e.time}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant={e.now ? "heading16" : "text16"}>{e.label}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text variant="label13" tone="secondary" heading>
        {labels.contacts}
      </Text>
      {contacts.map((c) => (
        <View
          key={c.name}
          style={{ flexDirection: "row", alignItems: "center", gap: theme.space["12"] }}
        >
          <Avatar name={c.name} />
          <View style={{ flex: 1 }}>
            <Text>{c.name}</Text>
            <Text variant="text14" tone="secondary">
              {c.role}
            </Text>
          </View>
          {c.onCall ? (
            <IconButton
              icon="Phone"
              variant="secondary"
              label={`${labels.call} ${c.name}`}
              onPress={c.onCall}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** A drawn signature over the attestation; reports the strokes as SVG path data. */
export function SignaturePad({
  label,
  attestation,
  clearLabel,
  onChange,
  testID,
}: SignaturePadProps): ReactElement {
  const theme = useTheme();
  const [path, setPath] = useState("");
  const current = useRef("");
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          current.current += `M${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setPath(current.current);
        },
        onPanResponderMove: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          current.current += `L${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setPath(current.current);
        },
        onPanResponderRelease: () => onChange(current.current || null),
        // A scrolling form must not take the stroke: on the simulator a signature drawn inside a form
        // was taken by the scroll view, never released here, and the form still said "Sign in the box".
        // If the stroke is taken anyway, what was drawn still counts.
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => onChange(current.current || null),
      }),
    [onChange],
  );
  const clear = () => {
    current.current = "";
    setPath("");
    onChange(null);
  };
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["8"] }}>
      <Text variant="label13">{label}</Text>
      <View
        role="img"
        aria-label={label}
        {...responder.panHandlers}
        style={{
          height: theme.space["40"] * 4,
          borderRadius: theme.radius.card,
          borderWidth: theme.controlBorderWidth,
          borderStyle: "dashed",
          borderColor: theme.color.borderStrong,
          backgroundColor: theme.color.bgSurface,
        }}
      >
        <Svg width="100%" height="100%">
          <Path
            d={path}
            fill="none"
            stroke={theme.color.textPrimary}
            strokeWidth={theme.strokeWidth.focus}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
        <View style={{ flex: 1 }}>
          <Text variant="text14" tone="secondary">
            {attestation}
          </Text>
        </View>
        <Button variant="ghost" label={clearLabel} onPress={clear} />
      </View>
    </View>
  );
}

/** Photo proof: the app's camera surface, the count taken, annotate, shutter and Done. */
export function PhotoCapture({
  hint,
  count,
  camera,
  captureLabel,
  onCapture,
  doneLabel,
  onDone,
  annotateLabel,
  onAnnotate,
  testID,
}: PhotoCaptureProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{ flex: 1, backgroundColor: theme.color.cameraBg }}
    >
      <View
        style={{
          flex: 1,
          minHeight: theme.density.touchMin * 6,
          alignItems: "center",
          justifyContent: "flex-end",
          padding: theme.space["16"],
        }}
      >
        {camera ?? null}
        <Text variant="text14" tone="secondary">
          {hint}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: theme.space["16"],
          backgroundColor: theme.color.bgCanvas,
        }}
      >
        {annotateLabel && onAnnotate ? (
          <IconButton
            icon="PenLine"
            variant="secondary"
            label={annotateLabel}
            onPress={onAnnotate}
          />
        ) : (
          <View style={{ width: theme.density.touchMin }} />
        )}
        <IconButton
          icon="Camera"
          variant="secondary"
          label={captureLabel}
          onPress={() => {
            haptic("impact");
            onCapture();
          }}
        />
        <View style={{ alignItems: "center", gap: theme.space["2"] }}>
          <Tag tone="neutral" label={String(count)} />
          <Button variant="primary" label={doneLabel} onPress={onDone} />
        </View>
      </View>
    </View>
  );
}

/** The lock screen Live Activity layout: timer, place, Break or End Break, and Clock Out. */
export function LiveActivity({
  label,
  elapsed,
  place,
  nextShift,
  nextTime,
  nextPlace,
  onBreak = false,
  labels,
  onToggleBreak,
  onClockOut,
  testID,
}: LiveActivityProps): ReactElement {
  const theme = useTheme();
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["12"] }}>
      <View
        role="summary"
        aria-label={`${label}, ${elapsed}, ${place}`}
        style={{
          gap: theme.space["8"],
          padding: theme.space["16"],
          borderRadius: theme.radius.widget,
          backgroundColor: theme.color.bgRaised,
          boxShadow: theme.shadow.menu,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
          <IconInk
            name={onBreak ? "Coffee" : "Clock"}
            size={20}
            color={onBreak ? theme.color.warning : theme.color.success}
          />
          <View style={{ flex: 1 }}>
            <Text variant="heading16">{label}</Text>
          </View>
          <Text variant="heading24">{elapsed}</Text>
        </View>
        <Text tone="secondary">{place}</Text>
        <View style={{ flexDirection: "row", gap: theme.space["8"] }}>
          <View style={{ flex: 1 }}>
            <Button
              block
              label={onBreak ? labels.endBreak : labels.break}
              {...(onToggleBreak ? { onPress: onToggleBreak } : {})}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              block
              variant="primary"
              label={labels.clockOut}
              {...(onClockOut ? { onPress: onClockOut } : {})}
            />
          </View>
        </View>
      </View>
      {/* The shift being worked, full width under the clock; left out when there is none to name, so the
          card is never an empty square with a bare caption (finding A59-022). */}
      {nextShift ? (
        <View
          role="summary"
          aria-label={[nextShift, nextTime, nextPlace].filter(Boolean).join(", ")}
          style={{
            gap: theme.space["2"],
            padding: theme.space["16"],
            borderRadius: theme.radius.widget,
            backgroundColor: theme.color.bgRaised,
            boxShadow: theme.shadow.menu,
          }}
        >
          <Text variant="heading16">{nextShift}</Text>
          {nextTime ? <Text tone="secondary">{nextTime}</Text> : null}
          {nextPlace ? <Text tone="secondary">{nextPlace}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Blocks the app below the forced minimum version (Section 5.1) until the person updates. */
export function ForceUpdateScreen({
  message,
  version,
  actionLabel,
  onUpdate,
  testID,
}: ForceUpdateScreenProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      role="alert"
      {...(testID === undefined ? {} : { testID })}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space["12"],
        padding: theme.space["24"],
        backgroundColor: theme.color.bgCanvas,
      }}
    >
      <Icon name="Smartphone" size={28} tone="secondary" />
      <Text tone="secondary">{message}</Text>
      <Text variant="mono13" tone="secondary">
        {version}
      </Text>
      <Button variant="primary" size="lg" block label={actionLabel} onPress={onUpdate} />
    </View>
  );
}

/** The next engagement: countdown, what, when, call time, where, and what to bring. */
export function UpNextCard({
  org,
  countdown,
  title,
  when,
  callTime,
  address,
  parking,
  contact,
  bring,
  onDirections,
  directionsLabel,
  testID,
}: UpNextCardProps): ReactElement {
  const theme = useTheme();
  const facts = [when, callTime, address, parking, contact].filter((f): f is string => !!f);
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        gap: theme.space["12"],
        padding: theme.space["16"],
        borderRadius: theme.radius.dialog,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderSubtle,
        backgroundColor: theme.color.bgRaised,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text variant="label13" tone="secondary">
          {org}
        </Text>
        <Text variant="label13" tone="accent">
          {countdown}
        </Text>
      </View>
      <Text variant="heading20" heading>
        {title}
      </Text>
      <View style={{ gap: theme.space["4"] }}>
        {facts.map((f) => (
          <Text key={f}>{f}</Text>
        ))}
      </View>
      {bring?.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["6"] }}>
          {bring.map((b) => (
            <Tag key={b} label={b} />
          ))}
        </View>
      ) : null}
      {onDirections && directionsLabel ? (
        <Button block icon="Navigation" label={directionsLabel} onPress={onDirections} />
      ) : null}
    </View>
  );
}
