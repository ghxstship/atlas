import {
  getMyWorkDetails,
  listMyEmergencyContacts,
  type EmergencyContact,
  type WorkDetails,
} from "@xos/data/work-details";
import type { XosClient } from "@xos/data";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import * as Linking from "expo-linking";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../runtime/CompassProvider";
import { Button, Card, ListRow, Text } from "../ui";

/**
 * The emergency contacts and uniform sizes on the Compass profile (Section 4.3 item 13, A65-003).
 * They are the person's own Work Details, read online with their session (owner-only rows); they
 * are never synced to the device. Editing happens in Gateway Settings, Work Details, which the
 * button opens.
 */
interface Loaded {
  readonly contacts: readonly EmergencyContact[];
  readonly details: WorkDetails | null;
}

export function WorkDetailsCards(): ReactElement {
  const { t, i18n } = useTranslation();
  const { client, config, network } = useCompass();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const online = network.isConnected;
  useEffect(() => {
    if (!online) return;
    let live = true;
    const db = client as unknown as XosClient;
    void Promise.all([listMyEmergencyContacts(db), getMyWorkDetails(db)]).then(
      ([contacts, details]) => {
        if (!live) return;
        if (!contacts.ok || !details.ok) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setLoaded({ contacts: contacts.data, details: details.data });
      },
    );
    return () => {
      live = false;
    };
  }, [client, online]);
  const region = regionFromLocale(i18n.language);
  const d = loaded?.details ?? null;
  const sizes: [string, string | null | undefined][] = [
    [t("workDetails.uniform.shirt"), d?.shirtSize],
    [t("workDetails.uniform.jacket"), d?.jacketSize],
    [t("workDetails.uniform.pants"), d?.pantsSize],
    [t("workDetails.uniform.shoe"), d?.shoeSize],
    [t("workDetails.uniform.gloves"), d?.gloveSize],
    [t("workDetails.uniform.hat"), d?.hatSize],
  ];
  const known = sizes.filter(([, size]) => size);
  return (
    <>
      <Card title={t("workDetails.contacts.title")} testID="profile-emergency-contacts">
        {!loaded ? (
          <Text tone="tertiary">
            {failed ? t("workDetails.compass.failed") : t("workDetails.compass.offline")}
          </Text>
        ) : loaded.contacts.length === 0 ? (
          <Text tone="tertiary">{t("workDetails.contacts.none")}</Text>
        ) : (
          loaded.contacts.map((c) => (
            <ListRow
              key={c.id}
              icon="user"
              title={c.relationship ? `${c.fullName} · ${c.relationship}` : c.fullName}
              subtitle={formatPhone(c.phoneE164, region)}
              onPress={() => void Linking.openURL(`tel:${c.phoneE164}`)}
            />
          ))
        )}
      </Card>
      <Card title={t("workDetails.uniform.title")} testID="profile-uniform-sizes">
        {loaded && known.length === 0 ? (
          <Text tone="tertiary">{t("workDetails.compass.noSizes")}</Text>
        ) : (
          known.map(([garment, size]) => (
            <Text key={garment}>{t("workDetails.org.sizes", { garment, size: size ?? "" })}</Text>
          ))
        )}
        <Button
          label={t("workDetails.compass.edit")}
          variant="secondary"
          onPress={() => void Linking.openURL(`${config.gatewayUrl}/settings/work-details`)}
        />
      </Card>
    </>
  );
}
