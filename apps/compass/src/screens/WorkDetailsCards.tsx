import { listMyEmergencyContacts, type EmergencyContact } from "@xos/data/work-details";
import type { XosClient } from "@xos/data";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../runtime/CompassProvider";
import { Button, Card, ListRow, Text } from "../ui";

/**
 * The emergency contacts on the Compass profile (Section 4.3 item 13, A65-003). They are the
 * person's own Work Details, read online with their session (owner-only rows); they are never
 * synced to the device. They stay read-only here: the button opens Settings, Work Details, where
 * Compass edits them (A111). Uniform sizes left the profile in R6a (2664); each project asks for
 * them in Project details.
 */
export function WorkDetailsCards(): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { client, network } = useCompass();
  const [contacts, setContacts] = useState<readonly EmergencyContact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const online = network.isConnected;
  useEffect(() => {
    if (!online) return;
    let live = true;
    void listMyEmergencyContacts(client as unknown as XosClient).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setContacts(result.data);
    });
    return () => {
      live = false;
    };
  }, [client, online]);
  const region = regionFromLocale(i18n.language);
  return (
    <Card title={t("workDetails.contacts.title")} testID="profile-emergency-contacts">
      {!contacts ? (
        <Text tone="tertiary">
          {failed ? t("workDetails.compass.failed") : t("workDetails.compass.offline")}
        </Text>
      ) : contacts.length === 0 ? (
        <Text tone="tertiary">{t("workDetails.contacts.none")}</Text>
      ) : (
        contacts.map((c) => (
          <ListRow
            key={c.id}
            icon="user"
            title={c.relationship ? `${c.fullName} · ${c.relationship}` : c.fullName}
            subtitle={formatPhone(c.phoneE164, region)}
            onPress={() => void Linking.openURL(`tel:${c.phoneE164}`)}
          />
        ))
      )}
      <Button
        testID="profile-work-details-edit"
        label={t("workDetails.compass.edit")}
        variant="secondary"
        onPress={() => router.push("/settings/work-details")}
      />
    </Card>
  );
}
