import type { XosClient } from "@xos/data/client";
import { revokePersonalToken } from "@xos/data/developer";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../src/runtime/CompassProvider";
import {
  facts,
  GatewayStep,
  useConfirmed,
  useMediumDate,
} from "../../src/screens/settings/ConnectionParts";
import { useMirror } from "../../src/screens/settings/hooks";
import { ConfirmSheet, OfflineNotice } from "../../src/screens/settings/parts";
import {
  createTokenUrl,
  PERSONAL_TOKENS_MIRROR,
  readMyTokens,
  readTokensAllowed,
  revokeOutcome,
  STANDING_TONE,
  tokenItems,
  type TokenRow,
} from "../../src/settings/developer";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Skeleton,
  Tag,
  Text,
  useTheme,
} from "../../src/ui";

const S = "settingsSurfaces";

/**
 * Settings, Developer (sitemap settings.developer, shown where an org allows personal API tokens; Section 4.5.6 item
 * 15, ADR 0072): the person's personal API tokens in every org, with revoke, which needs a connection; the list shows
 * offline. A new token is created in Gateway, on the computer that will use it, and the screen says why.
 */
export default function DeveloperScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, network, resolved, config } = useCompass();
  const date = useMediumDate();
  const online = network.isConnected;
  const personId = resolved?.identity.personId ?? null;
  const read = useCallback(
    () => (personId ? readMyTokens(client, personId) : Promise.resolve(null)),
    [client, personId],
  );
  const tokens = useMirror<TokenRow>(PERSONAL_TOKENS_MIRROR, personId ? read : null);
  const revoke = useConfirmed<TokenRow>();
  const [done, setDone] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!online) return undefined;
    let live = true;
    void readTokensAllowed(client).then((answer) => {
      if (live) setAllowed(answer);
    });
    return () => {
      live = false;
    };
  }, [client, online]);

  const confirmRevoke = async (token: TokenRow): Promise<string | null> => {
    const result = await revokePersonalToken(client as unknown as XosClient, token.id);
    tokens.reload();
    const outcome = result.ok ? "done" : revokeOutcome(result.error);
    if (outcome === "gone") return t("compassSettings.connections.gone");
    if (outcome === "failed") return t("compassSettings.common.failed");
    setDone(t("compassSettings.developer.revoked", { name: token.name }));
    return null;
  };

  const items = tokenItems(tokens.rows, Date.now());
  return (
    <Screen testID="settings-developer" title={t("nav.settings.personal.developer")}>
      <Text tone="secondary">{t("gateway.settings.leads.developer")}</Text>
      {!online ? <OfflineNotice kind="needs" testID="settings-developer-offline" /> : null}
      {done ? <InlineAlert testID="settings-developer-done" tone="success" message={done} /> : null}
      <Card testID="settings-tokens" title={t(`${S}.tokens.title`)}>
        <Text variant="text13" tone="tertiary">
          {t("compassSettings.developer.description")}
        </Text>
        {!tokens.ready ? (
          tokens.notLoaded ? (
            <OfflineNotice kind="first" testID="settings-tokens-first" />
          ) : tokens.failed ? (
            <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
          ) : (
            <Skeleton testID="settings-tokens-loading" lines={2} />
          )
        ) : items.length === 0 ? (
          <Text testID="settings-tokens-empty" tone="secondary">
            {t(`${S}.gateway.noTokens`)}
          </Text>
        ) : (
          items.map(({ token, standing, revocable }) => (
            <ListRow
              key={token.id}
              testID="settings-token"
              icon="key-round"
              title={token.name}
              subtitle={facts(
                token.orgName,
                `${token.prefix}…`,
                token.scopes.length > 0
                  ? t(`${S}.scopesList`, { scopes: token.scopes.join(", ") })
                  : null,
                t(`${S}.expiry.until`, { date: date(token.expiresAt) }),
                token.lastUsedAt
                  ? t(`${S}.lastUsed`, { date: date(token.lastUsedAt) })
                  : t(`${S}.neverUsed`),
              )}
              trailing={
                <View style={{ alignItems: "flex-end", gap: theme.space["4"] }}>
                  <Tag tone={STANDING_TONE[standing]} label={t(`${S}.${standing}`)} />
                  {revocable ? (
                    <Button
                      testID="settings-token-revoke"
                      variant="ghost"
                      label={t(`${S}.revoke`)}
                      disabled={!online}
                      onPress={() => {
                        setDone(null);
                        revoke.ask(token);
                      }}
                    />
                  ) : null}
                </View>
              }
            />
          ))
        )}
      </Card>
      <Card testID="settings-token-create">
        {allowed === false ? (
          <Text testID="settings-token-create-off" tone="secondary">
            {t(`${S}.gateway.tokensOff`)}
          </Text>
        ) : (
          <GatewayStep
            testID="settings-token-create-gateway"
            icon="key-round"
            title={t("compassSettings.developer.create")}
            reason={t("compassSettings.developer.createReason")}
            url={createTokenUrl(config.gatewayUrl)}
          />
        )}
      </Card>
      <ConfirmSheet
        testID="settings-token-confirm"
        open={revoke.target !== null}
        title={t(`${S}.tokens.revokeConfirm.title`, { name: revoke.target?.name ?? "" })}
        sentence={t(`${S}.tokens.revokeConfirm.body`)}
        confirmLabel={t(`${S}.tokens.revokeConfirm.confirm`)}
        danger
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() => void revoke.confirm(confirmRevoke)}
        onClose={revoke.close}
      />
    </Screen>
  );
}
