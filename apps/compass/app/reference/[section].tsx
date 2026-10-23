import type { Row } from "@xos/sync";
import { useLocalSearchParams } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  emergencyCodesFor,
  needsCodeWord,
  spokenCode,
  swatchToken,
  type CanonEmergencyCodeRow,
  type OrgEmergencyCodeRow,
} from "../../src/domain/emergencyCodes";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { Card, EmptyState, InlineAlert, ListRow, Screen, Text, useTheme } from "../../src/ui";

/**
 * The code word as it is said on the radio, with the code's swatch beside it. The color only helps recognition: the
 * word is written whenever the label does not already say it, and the swatch is left out until the canon codes, which
 * hold it, are on the device.
 */
function CodeWord({
  code,
  label,
  swatch,
}: {
  code: string;
  label: string;
  swatch: string | null;
}): ReactElement | null {
  const theme = useTheme();
  const colors = theme.color as Readonly<Record<string, string>>;
  const token = swatchToken(swatch);
  const color = token === null ? undefined : colors[token];
  const word = needsCodeWord(code, label);
  if (!word && color === undefined) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
      {color === undefined ? null : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: theme.space["12"],
            height: theme.space["12"],
            borderRadius: theme.radius.pill,
            backgroundColor: color,
            // The control border, as the design system's emergency code cards use, so white, black and indigo
            // swatches show on the card in every theme.
            borderWidth: theme.strokeWidth.hairline,
            borderColor: theme.color.borderControl,
          }}
        />
      )}
      {word ? (
        <Text variant="label13" tone="secondary">
          {spokenCode(code)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The active org's emergency codes (WP18, 1612): its own labels, descriptions and order, each with its canon code
 * word and swatch, or the canon codes, marked as such, while the device holds none of the org's own.
 */
function EmergencyCodes({ onRefresh }: { onRefresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const own = useRows<Row & OrgEmergencyCodeRow>("emergency_codes");
  const canon = useRows<Row & CanonEmergencyCodeRow>("canon_emergency_codes");
  // Both reads finish separately; drawing before both are in would flash the canon labels or bare cards.
  if (own.loading || canon.loading) return null;
  const { codes, standard } = emergencyCodesFor(own.rows, canon.rows);
  if (codes.length === 0)
    return (
      <EmptyState
        icon="flame"
        sentence={t("compass.reference.emergencyEmpty")}
        actionLabel={t("compass.common.refresh")}
        onAction={onRefresh}
      />
    );
  return (
    <>
      {standard ? (
        <InlineAlert
          testID="codes-standard"
          tone="info"
          message={t("compass.reference.emergencyStandard")}
        />
      ) : null}
      {codes.map((c) => (
        <Card key={c.key} testID={`code-${c.code}`} title={c.label}>
          <CodeWord code={c.code} label={c.label} swatch={c.swatch} />
          <Text tone="secondary">{c.emergency}</Text>
        </Card>
      ))}
    </>
  );
}

function RadioChannels({ onRefresh }: { onRefresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const { projectId } = useCompass();
  const { rows, loading } = useRows<
    Row & { project_id: string; channel_number: number; name: string }
  >("radio_channels", (r) => r.project_id === projectId);
  if (loading) return null;
  if (rows.length === 0)
    return (
      <EmptyState
        icon="radio"
        sentence={t("compass.reference.radioEmpty")}
        actionLabel={t("compass.common.refresh")}
        onAction={onRefresh}
      />
    );
  return (
    <Card>
      {[...rows]
        .sort((a, b) => a.channel_number - b.channel_number)
        .map((r) => (
          <ListRow
            key={r.id}
            icon="radio"
            title={r.name}
            subtitle={t("compass.reference.channel", { number: r.channel_number })}
          />
        ))}
    </Card>
  );
}

function Sops({ onRefresh }: { onRefresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const { rows, loading } = useRows<
    Row & { code: string; title: string; body: string; published_at: string | null }
  >("sops", (s) => s.published_at !== null);
  if (loading) return null;
  if (rows.length === 0)
    return (
      <EmptyState
        icon="book-open"
        sentence={t("compass.reference.sopsEmpty")}
        actionLabel={t("compass.common.refresh")}
        onAction={onRefresh}
      />
    );
  return (
    <>
      {[...rows]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((s) => (
          <Card key={s.id} title={`${s.code} · ${s.title}`}>
            <Text tone="secondary">{s.body}</Text>
          </Card>
        ))}
    </>
  );
}

export default function ReferenceSection(): ReactElement {
  const { t } = useTranslation();
  const { section } = useLocalSearchParams<{ section: string }>();
  const { refresh } = useCompass();
  const [refreshing, setRefreshing] = useState(false);
  // Pull down, or the empty state's Refresh, downloads again when there is a connection; the spinner stays until the
  // download ends, offline included.
  const onRefresh = () => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  };
  // Venue maps have no source yet, so that screen offers no refresh.
  const refreshable = section !== "venue-maps";
  const titles: Readonly<Record<string, string>> = {
    "emergency-codes": "nav.compass.reference.emergencyCodes",
    "radio-channels": "nav.compass.reference.radioChannels",
    "venue-maps": "nav.compass.reference.venueMaps",
    sops: "nav.compass.reference.sops",
  };
  return (
    <Screen
      testID={`reference-${section ?? ""}`}
      title={t(titles[section ?? ""] ?? "compass.reference.title")}
      {...(refreshable ? { onRefresh, refreshing } : {})}
    >
      {section === "emergency-codes" ? <EmergencyCodes onRefresh={onRefresh} /> : null}
      {section === "radio-channels" ? <RadioChannels onRefresh={onRefresh} /> : null}
      {section === "sops" ? <Sops onRefresh={onRefresh} /> : null}
      {section === "venue-maps" ? (
        <EmptyState
          icon="map"
          sentence={t("compass.reference.mapsEmpty")}
          actionLabel={t("compass.common.refresh")}
        />
      ) : null}
    </Screen>
  );
}
