import type { ReactElement } from "react";
import { View } from "react-native";
import { useTheme, type ColorToken } from "../theme/index.ts";
import type {
  CredentialBadgeProps,
  EmergencyAuthority,
  EmergencyCodeCardProps,
  RadioChannelTableProps,
  RunOfShowLiveProps,
} from "../types.ts";
import { Icon, Ink, Text } from "./foundations.tsx";
import { QRCode } from "./forms.tsx";

const SERVICES: EmergencyAuthority["service"][] = [
  "fire",
  "ems",
  "lawEnforcement",
  "bombSquad",
  "federal",
];

/** Resolves `{service}` tokens in a protocol step from the jurisdiction's agencies, or the service label. */
export function resolveStep(
  step: string,
  authorities: EmergencyAuthority[] | undefined,
  labels: Partial<Record<EmergencyAuthority["service"], string>> | undefined,
): string {
  return step.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(SERVICES as string[]).includes(key)) return match;
    const service = key as EmergencyAuthority["service"];
    return authorities?.find((a) => a.service === service)?.agency ?? labels?.[service] ?? match;
  });
}

function swatchToken(swatch: EmergencyCodeCardProps["swatch"]): ColorToken {
  const [, hue = "red"] = swatch.split("-");
  return `ecode${hue.charAt(0).toUpperCase()}${hue.slice(1)}` as ColorToken;
}

/**
 * One emergency code's protocol for one domain, readable offline. The code word is always written;
 * the swatch is for recognition only.
 */
export function EmergencyCodeCard({
  code,
  name,
  swatch,
  domain,
  steps,
  channel,
  recordKey,
  authorities,
  serviceLabels,
  testID,
}: EmergencyCodeCardProps): ReactElement {
  const theme = useTheme();
  const hue = theme.color[swatchToken(swatch)];
  const used = SERVICES.filter((s) => steps.some((step) => step.includes(`{${s}}`)));
  const listed = (authorities ?? []).filter((a) => used.includes(a.service));
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        gap: theme.space["8"],
        padding: theme.space["16"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderSubtle,
        borderTopWidth: theme.strokeWidth.swatch,
        borderTopColor: hue,
        backgroundColor: theme.color.bgRaised,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
        <View
          aria-hidden
          style={{
            width: theme.iconSize["24"],
            height: theme.iconSize["24"],
            borderRadius: theme.radius.chip,
            borderWidth: theme.strokeWidth.hairline,
            borderColor: theme.color.borderControl,
            backgroundColor: hue,
          }}
        />
        <View style={{ flex: 1 }}>
          <Text variant="heading16" heading>
            {code}
          </Text>
          <Text>{name}</Text>
        </View>
        {recordKey ? (
          <Text variant="mono13" tone="secondary">
            {recordKey}
          </Text>
        ) : null}
      </View>
      {domain ? (
        <Text variant="label13" tone="secondary">
          {domain}
        </Text>
      ) : null}
      <View role="list" style={{ gap: theme.space["4"] }}>
        {steps.map((step, i) => (
          <View key={i} role="listitem" style={{ flexDirection: "row", gap: theme.space["8"] }}>
            <Text tone="secondary">{`${i + 1}.`}</Text>
            <View style={{ flex: 1 }}>
              <Text>{resolveStep(step, authorities, serviceLabels)}</Text>
            </View>
          </View>
        ))}
      </View>
      {listed.length ? (
        <View
          style={{
            gap: theme.space["4"],
            paddingTop: theme.space["8"],
            borderTopWidth: theme.strokeWidth.hairline,
            borderTopColor: theme.color.borderSubtle,
          }}
        >
          {listed.map((a) => (
            <Text key={a.service} variant="text14">
              {`${serviceLabels?.[a.service] ?? a.service}: ${a.agency}${a.contact ? ` · ${a.contact}` : ""}`}
            </Text>
          ))}
        </View>
      ) : null}
      {channel ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
          <Icon name="Radio" size={20} tone="secondary" />
          <Text variant="text14" tone="secondary">
            {channel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The radio plan, sorted by zone then channel; each row reads as one sentence on a phone. */
export function RadioChannelTable({
  caption,
  channels,
  headers,
  testID,
}: RadioChannelTableProps): ReactElement {
  const theme = useTheme();
  const rows = [...channels].sort((a, b) => a.zone - b.zone || a.channel - b.channel);
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["8"] }}>
      {caption ? (
        <Text variant="heading16" heading>
          {caption}
        </Text>
      ) : null}
      <View role="list" aria-label={caption ?? headers.assignment}>
        {rows.map((r) => (
          <View
            key={`${r.zone}-${r.channel}`}
            role="listitem"
            aria-label={`${headers.zone} ${r.zone}, ${headers.channel} ${r.channel}, ${r.assignment}${r.notes ? `, ${r.notes}` : ""}`}
            style={{
              flexDirection: "row",
              gap: theme.space["12"],
              minHeight: theme.density.touchMin,
              paddingVertical: theme.space["8"],
              borderBottomWidth: theme.strokeWidth.hairline,
              borderBottomColor: theme.color.borderSubtle,
            }}
          >
            <Text variant="mono13" tone="secondary">{`${r.zone}·${r.channel}`}</Text>
            <View style={{ flex: 1, gap: theme.space["2"] }}>
              <Text>{r.assignment}</Text>
              {r.notes ? (
                <Text variant="text14" tone="secondary">
                  {r.notes}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The live cue list with the countdown to the next cue; show mode is large type for arm's length. */
export function RunOfShowLive({
  cues,
  current,
  nextInSeconds,
  showMode = false,
  nextLabel,
  countdownLabel,
  testID,
}: RunOfShowLiveProps): ReactElement {
  const theme = useTheme();
  const live = cues[current];
  const next = cues[current + 1];
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: theme.space["12"] }}>
      {live ? (
        <View
          role="summary"
          style={{
            gap: theme.space["4"],
            padding: theme.space["16"],
            borderRadius: theme.radius.dialog,
            borderWidth: theme.strokeWidth.focus,
            borderColor: theme.color.accentDefault,
            backgroundColor: theme.color.bgRaised,
          }}
        >
          <Text variant="mono13" tone="accent">{`${live.number} · ${live.time}`}</Text>
          <Text variant={showMode ? "heading32" : "heading20"} heading>
            {live.title}
          </Text>
        </View>
      ) : null}
      {next ? (
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}
        >
          {/* Only the next cue is live: the countdown changes every tick and would flood the
              screen reader, so it carries a spoken label instead (A23-009). */}
          <View aria-live="polite" style={{ flexShrink: 1 }}>
            <Text
              variant={showMode ? "heading20" : "text16"}
              tone="secondary"
            >{`${nextLabel}: ${next.title}`}</Text>
          </View>
          <View accessible aria-label={countdownLabel ?? clock(nextInSeconds)}>
            <Ink
              variant={showMode ? "heading32" : "heading24"}
              color={nextInSeconds <= 10 ? theme.color.warningText : theme.color.textPrimary}
            >
              {clock(nextInSeconds)}
            </Ink>
          </View>
        </View>
      ) : null}
      <View role="list">
        {cues.map((cue, i) => (
          <View
            key={cue.number}
            role="listitem"
            aria-current={i === current ? "step" : undefined}
            style={{
              flexDirection: "row",
              gap: theme.space["12"],
              minHeight: theme.density.touchMin,
              alignItems: "center",
              opacity: i < current ? theme.opacity.disabled : 1,
            }}
          >
            <Text variant="mono13" tone="secondary">
              {cue.number}
            </Text>
            <Text variant="mono13" tone="secondary">
              {cue.time}
            </Text>
            <View style={{ flex: 1 }}>
              <Text tone={i === current ? "accent" : "primary"}>{cue.title}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const CATEGORY: Record<CredentialBadgeProps["categoryColor"], ColorToken> = {
  1: "vizCat1",
  2: "vizCat2",
  3: "vizCat3",
  4: "vizCat4",
  5: "vizCat5",
  6: "vizCat6",
  7: "vizCat7",
};

/** The credential shown at access points: category band, holder, offline QR code, zones and validity. */
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
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        alignItems: "center",
        gap: theme.space["12"],
        padding: theme.space["20"],
        borderRadius: theme.radius.dialog,
        borderTopWidth: theme.strokeWidth.stripe,
        borderTopColor: theme.color[CATEGORY[categoryColor]],
        backgroundColor: theme.color.bgRaised,
      }}
    >
      <Text variant="label13" tone="secondary">
        {`${org} · ${category}`}
      </Text>
      <Text variant="heading24" heading>
        {name}
      </Text>
      <Text tone="secondary">{role}</Text>
      <QRCode value={payload} label={`${name}, ${credentialKey}`} size={theme.space["64"] * 3} />
      <Text variant="mono13" tone="secondary">
        {credentialKey}
      </Text>
      <Text variant="text14">{zones.join(" · ")}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["6"] }}>
        <Text variant="text14" tone="secondary">
          {validFrom}
        </Text>
        <Icon name="ArrowRight" size={20} tone="secondary" />
        <Text variant="text14" tone="secondary">
          {validTo}
        </Text>
      </View>
    </View>
  );
}
