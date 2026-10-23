import type { Row } from "@xos/sync";
import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  emergencyCodesFor,
  swatchToken,
  type CanonEmergencyCodeRow,
  type OrgEmergencyCodeRow,
} from "../../src/domain/emergencyCodes";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { Card, EmptyState, ListRow, Screen, Text, useTheme } from "../../src/ui";

/** The code word with its swatch beside it; the color only helps recognition, so the word is always written. */
function CodeWord({ code, swatch }: { code: string; swatch: string }): ReactElement {
  const theme = useTheme();
  const colors = theme.color as Readonly<Record<string, string>>;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: theme.space["12"],
          height: theme.space["12"],
          borderRadius: theme.radius.pill,
          backgroundColor: colors[swatchToken(swatch)] ?? colors["ecodeGrey"],
          // White and silver swatches on a light card need an edge to be seen.
          borderWidth: theme.strokeWidth.hairline,
          borderColor: theme.color.borderStrong,
        }}
      />
      <Text variant="label13" tone="secondary">
        {code}
      </Text>
    </View>
  );
}

/**
 * The active org's emergency codes (WP18, 1612): its own labels, descriptions and order, each with its canon code
 * word and swatch, or the canon codes while the org holds none, as Atlas lists them.
 */
function EmergencyCodes(): ReactElement {
  const { t } = useTranslation();
  const { rows: own } = useRows<Row & OrgEmergencyCodeRow>("emergency_codes");
  const { rows: canon } = useRows<Row & CanonEmergencyCodeRow>("canon_emergency_codes");
  const codes = emergencyCodesFor(own, canon);
  if (codes.length === 0)
    return (
      <EmptyState
        icon="flame"
        sentence={t("compass.reference.emergencyEmpty")}
        actionLabel={t("compass.common.refresh")}
      />
    );
  return (
    <>
      {codes.map((c) => (
        <Card
          key={c.key}
          testID={`code-${c.code}`}
          title={c.label}
          meta={<CodeWord code={c.code} swatch={c.swatch} />}
        >
          <Text tone="secondary">{c.emergency}</Text>
        </Card>
      ))}
    </>
  );
}

function RadioChannels(): ReactElement {
  const { t } = useTranslation();
  const { projectId } = useCompass();
  const { rows } = useRows<Row & { project_id: string; channel_number: number; name: string }>(
    "radio_channels",
    (r) => r.project_id === projectId,
  );
  if (rows.length === 0)
    return (
      <EmptyState
        icon="radio"
        sentence={t("compass.reference.radioEmpty")}
        actionLabel={t("compass.common.refresh")}
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

function Sops(): ReactElement {
  const { t } = useTranslation();
  const { rows } = useRows<
    Row & { code: string; title: string; body: string; published_at: string | null }
  >("sops", (s) => s.published_at !== null);
  if (rows.length === 0)
    return (
      <EmptyState
        icon="book-open"
        sentence={t("compass.reference.sopsEmpty")}
        actionLabel={t("compass.common.refresh")}
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
    >
      {section === "emergency-codes" ? <EmergencyCodes /> : null}
      {section === "radio-channels" ? <RadioChannels /> : null}
      {section === "sops" ? <Sops /> : null}
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
