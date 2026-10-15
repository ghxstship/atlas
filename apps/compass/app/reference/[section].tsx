import type { Row } from "@xos/sync";
import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { Card, EmptyState, ListRow, Screen, Text } from "../../src/ui";

function EmergencyCodes(): ReactElement {
  const { t } = useTranslation();
  const { rows } = useRows<Row & { name?: string; description?: string; sort_order?: number }>(
    "emergency_codes",
  );
  if (rows.length === 0)
    return (
      <EmptyState
        icon="flame"
        sentence={t("compass.reference.emergencyEmpty")}
        actionLabel={t("compass.common.refresh")}
      />
    );
  return (
    <>
      {[...rows]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((c) => (
          <Card key={c.id} testID={`code-${c.id}`} title={c.name ?? c.id}>
            <Text tone="secondary">{c.description ?? ""}</Text>
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
