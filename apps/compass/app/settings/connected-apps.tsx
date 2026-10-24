import type { XosClient } from "@xos/data/client";
import { revokeConnectedApp } from "@xos/data/oauth";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import { facts, useConfirmed, useMediumDate } from "../../src/screens/settings/ConnectionParts";
import { useMirror } from "../../src/screens/settings/hooks";
import { ConfirmSheet, OfflineNotice } from "../../src/screens/settings/parts";
import {
  CONNECTED_APPS_MIRROR,
  grantItems,
  readMyGrants,
  revokeErrorKey,
  scopeList,
  type GrantRow,
} from "../../src/settings/connected-apps";
import { Button, Card, InlineAlert, ListRow, Screen, Skeleton, Text } from "../../src/ui";

const S = "settingsSurfaces";

/**
 * Settings, Connected Apps (sitemap settings.connected-apps; Section 4.5.6 item 13, A99, ADR 0055, ADR 0072): the
 * apps the person lets act for them, with the org that registered each, the areas it may use, when it was allowed
 * and when it last refreshed its access. Disconnecting ends the app's access at once, so it needs a connection;
 * the list shows offline.
 */
export default function ConnectedAppsScreen(): ReactElement {
  const { t } = useTranslation();
  const { client, network } = useCompass();
  const date = useMediumDate();
  const online = network.isConnected;
  const read = useCallback(() => readMyGrants(client), [client]);
  const grants = useMirror<GrantRow>(CONNECTED_APPS_MIRROR, read);
  const revoke = useConfirmed<GrantRow>();
  const [done, setDone] = useState<string | null>(null);

  const disconnect = async (grant: GrantRow): Promise<string | null> => {
    const result = await revokeConnectedApp(client as unknown as XosClient, grant.id);
    grants.reload();
    if (!result.ok) return t(revokeErrorKey(result.error));
    setDone(t("compassSettings.connections.disconnected", { app: grant.appName }));
    return null;
  };

  const items = grantItems(grants.rows);
  return (
    <Screen testID="settings-apps" title={t("nav.settings.personal.connectedApps")}>
      <Text tone="secondary">{t("gateway.settings.leads.connectedApps")}</Text>
      {!online ? <OfflineNotice kind="needs" testID="settings-apps-offline" /> : null}
      {done ? <InlineAlert testID="settings-apps-done" tone="success" message={done} /> : null}
      <Card testID="settings-apps-list" title={t(`${S}.connectedApps.title`)}>
        <Text variant="text13" tone="tertiary">
          {t(`${S}.connectedApps.description`)}
        </Text>
        {!grants.ready ? (
          grants.notLoaded ? (
            <OfflineNotice kind="first" testID="settings-apps-first" />
          ) : grants.failed ? (
            <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
          ) : (
            <Skeleton testID="settings-apps-loading" lines={2} />
          )
        ) : items.length === 0 ? (
          <Text testID="settings-apps-empty" tone="secondary">
            {t(`${S}.connectedApps.none`)}
          </Text>
        ) : (
          items.map((grant) => (
            <ListRow
              key={grant.id}
              testID="settings-app"
              title={grant.appName}
              subtitle={facts(
                t(`${S}.connectedApps.registeredBy`, { org: grant.orgName }),
                grant.scopes.length > 0
                  ? t(`${S}.scopesList`, { scopes: scopeList(grant.scopes) })
                  : null,
                t(`${S}.connectedApps.granted`, { date: date(grant.grantedAt) }),
                grant.lastUsedAt
                  ? t(`${S}.lastUsed`, { date: date(grant.lastUsedAt) })
                  : t(`${S}.neverUsed`),
              )}
              trailing={
                <Button
                  testID="settings-app-disconnect"
                  variant="ghost"
                  label={t(`${S}.gateway.disconnect`)}
                  disabled={!online}
                  onPress={() => {
                    setDone(null);
                    revoke.ask(grant);
                  }}
                />
              }
            />
          ))
        )}
      </Card>
      <ConfirmSheet
        testID="settings-app-confirm"
        open={revoke.target !== null}
        title={t(`${S}.connectedApps.revokeConfirm.title`, { app: revoke.target?.appName ?? "" })}
        sentence={t(`${S}.connectedApps.revokeConfirm.body`)}
        confirmLabel={t(`${S}.connectedApps.revokeConfirm.confirm`)}
        danger
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() => void revoke.confirm(disconnect)}
        onClose={revoke.close}
      />
    </Screen>
  );
}
