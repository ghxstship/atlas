import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Card, ListRow, Screen } from "../../src/ui";

const SECTIONS = [
  { id: "emergency-codes", label: "nav.compass.reference.emergencyCodes", icon: "flame" },
  { id: "radio-channels", label: "nav.compass.reference.radioChannels", icon: "radio" },
  { id: "venue-maps", label: "nav.compass.reference.venueMaps", icon: "map" },
  { id: "sops", label: "nav.compass.reference.sops", icon: "book-open" },
] as const;

/** Reference material, all available offline (Section 4.3 item 10, Section 13). */
export default function ReferenceIndex(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Screen testID="reference" title={t("compass.reference.title")}>
      <Card>
        {SECTIONS.map((s) => (
          <ListRow
            key={s.id}
            testID={`reference-${s.id}`}
            icon={s.icon}
            title={t(s.label)}
            onPress={() => router.push(`/reference/${s.id}` as Href)}
          />
        ))}
      </Card>
    </Screen>
  );
}
