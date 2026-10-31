/**
 * Today's local contacts (B5, G-56) under the day sheet on Today: the project's contacts for every day and today's,
 * with a number to call in one tap. Rows come from the device (app.project_local_contacts inside the org,
 * api_external.local_contacts outside it, which carries Shared rows only and no member phone), so it reads offline.
 */
import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { todaysContacts } from "../domain/drives";
import { useRows } from "../runtime/CompassProvider";
import { Card, ListRow } from "../ui";

export function TodayContacts({
  projectId,
  today,
  testID,
}: {
  readonly projectId: string | null;
  readonly today: string;
  readonly testID?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const { rows } = useRows<Row>("local_contacts", undefined, { allOrgs: true });
  const contacts = todaysContacts(rows, projectId, today);
  if (contacts.length === 0) return null;
  return (
    <Card testID={testID ?? "today-local-contacts"} title={t("compass.localContacts.title")}>
      {contacts.map((c) => (
        <ListRow
          key={c.id}
          testID={`today-contact-${c.id}`}
          icon="user"
          title={c.name}
          subtitle={c.title ?? t("compass.localContacts.call")}
          onPress={() => void Linking.openURL(`tel:${c.tel}`)}
        />
      ))}
    </Card>
  );
}
