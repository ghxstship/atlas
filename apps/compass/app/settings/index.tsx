import { listOrgsAllowingPersonalTokens } from "@xos/data/developer";
import type { XosClient } from "@xos/data/client";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter, type Href } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { hapticsOn } from "../../src/domain/settings";
import { useCompass } from "../../src/runtime/CompassProvider";
import { useAllowed } from "../../src/screens/common";
import { groupSections, settingsSections, type SettingsSection } from "../../src/settings/sections";
import {
  Button,
  Card,
  Icon,
  InlineAlert,
  ListRow,
  Screen,
  SegmentedControl,
  Switch,
  Text,
  type ThemePreference,
} from "../../src/ui";

/**
 * Whether an org the person belongs to allows personal API tokens, so Settings lists Developer (the sitemap's
 * org-allows-personal-tokens condition, as Gateway reads it). Unknown offline, and then left out.
 */
function usePersonalTokens(): boolean {
  const { client, resolved, network } = useCompass();
  const [allowed, setAllowed] = useState(false);
  const member = resolved?.contexts.some((c) => c.kind === "member") ?? false;
  useEffect(() => {
    if (!network.isConnected || !member) return undefined;
    let live = true;
    void listOrgsAllowingPersonalTokens(client as unknown as XosClient).then((orgs) => {
      if (live) setAllowed(orgs.ok && orgs.data.length > 0);
    });
    return () => {
      live = false;
    };
  }, [client, member, network.isConnected]);
  return allowed;
}

/**
 * Compass settings. This device first: theme with the Sunlight outdoor theme, haptics, battery saver and low-data
 * mode, biometric unlock and kiosk mode. The theme also saves to the person's me.theme setting (A30) when it is
 * one the platform knows; Sunlight is a device preference only. Then the person's own settings (Section 4.5.6,
 * src/settings/sections.ts): the sitemap's 14 sections by group, each opening its Compass screen or, until
 * Compass draws it, the same section in Gateway. Then help, account deletion and sign-out.
 */
export default function SettingsScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { settings, updateSettings, status, signOut, enqueue, config, orgSettings, resolved } =
    useCompass();
  const canKiosk = useAllowed("kiosk.operate");
  const personalTokens = usePersonalTokens();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const audience = resolved?.identity.audience;
  const sections = audience ? settingsSections(audience, config, { personalTokens }) : [];
  const setTheme = (theme: ThemePreference) => {
    updateSettings({ theme });
    if (theme !== "sunlight") {
      void enqueue({
        op: "rpc",
        target: "set_personal_setting",
        table: "personal_settings",
        rowId: "me.theme",
        payload: { p_setting_key: "me.theme", p_value_text: theme },
        policy: "append",
      });
    }
  };
  const open = (section: SettingsSection) => {
    if (section.target.kind === "native") router.push(section.target.route as Href);
    else void Linking.openURL(section.target.url);
  };
  const queued = status?.queued ?? 0;
  return (
    <Screen testID="settings" title={t("compass.settings.title")}>
      <Text variant="heading16" heading>
        {t("compassSettings.index.device")}
      </Text>
      <Card title={t("compass.settings.theme")}>
        <SegmentedControl
          testID="settings-theme"
          label={t("compass.settings.theme")}
          value={settings.theme}
          options={[
            { value: "system", label: t("compass.settings.themeSystem") },
            { value: "dark", label: t("compass.settings.themeDark") },
            { value: "light", label: t("compass.settings.themeLight") },
            { value: "sunlight", label: t("compass.settings.themeSunlight"), icon: "sun" },
          ]}
          onChange={(v) => setTheme(v as ThemePreference)}
        />
        <Text variant="text13" tone="tertiary">
          {t("compass.settings.sunlightHelp")}
        </Text>
      </Card>
      <Card>
        <Switch
          testID="settings-haptics"
          label={t("compass.settings.haptics")}
          help={t("compass.settings.hapticsHelp")}
          value={hapticsOn(settings.haptics, orgSettings)}
          onChange={(haptics) => {
            updateSettings({ haptics });
            void enqueue({
              op: "rpc",
              target: "set_personal_setting",
              table: "personal_settings",
              rowId: "me.haptics",
              payload: { p_setting_key: "me.haptics", p_value_boolean: haptics },
              policy: "append",
            });
          }}
        />
        <Switch
          testID="settings-battery"
          label={t("compass.settings.batterySaver")}
          help={t("compass.settings.batterySaverHelp")}
          value={settings.batterySaver}
          onChange={(batterySaver) => updateSettings({ batterySaver })}
        />
        <Switch
          testID="settings-low-data"
          label={t("compass.settings.lowData")}
          help={t("compass.settings.lowDataHelp")}
          value={settings.lowData}
          onChange={(lowData) => updateSettings({ lowData })}
        />
        <Switch
          testID="settings-biometric"
          label={t("compass.settings.biometric")}
          help={t("compass.settings.biometricHelp")}
          value={settings.biometric}
          onChange={(biometric) => updateSettings({ biometric })}
        />
      </Card>
      {canKiosk ? (
        <Card>
          <ListRow
            testID="settings-kiosk"
            icon="tablet"
            title={t("compass.settings.kiosk")}
            subtitle={t("compass.settings.kioskHelp")}
            onPress={() => router.push("/kiosk")}
          />
        </Card>
      ) : null}
      <Text variant="heading16" heading>
        {t("compassSettings.index.personal")}
      </Text>
      {groupSections(sections).map(({ group, sections: inGroup }) => (
        <Card
          key={group}
          testID={`settings-group-${group}`}
          title={t(`compassSettings.groups.${group}`)}
        >
          {inGroup.map((section) => (
            <ListRow
              key={section.id}
              testID={`settings-section-${section.id}`}
              icon={section.icon}
              title={t(section.label)}
              subtitle={
                section.target.kind === "native"
                  ? t(section.lead)
                  : t("compassSettings.index.inGateway", { lead: t(section.lead) })
              }
              trailing={
                section.target.kind === "gateway" ? (
                  <Icon name="external-link" size={20} tone="secondary" />
                ) : undefined
              }
              onPress={() => open(section)}
            />
          ))}
        </Card>
      ))}
      <Card>
        <ListRow
          testID="settings-help"
          icon="circle-help"
          title={t("compass.help.entry")}
          subtitle={t("compass.help.entryHelp")}
          onPress={() => router.push("/help")}
        />
        <ListRow
          icon="ban"
          title={t("compass.settings.deleteAccount")}
          subtitle={t("compass.settings.deleteAccountHelp")}
          testID="settings-delete-account"
          onPress={() => router.push("/settings/delete-account")}
        />
      </Card>
      {confirmSignOut && queued > 0 ? (
        <InlineAlert
          testID="settings-sign-out-queued"
          tone="warning"
          message={t("compass.settings.signOutQueued", { count: queued })}
        />
      ) : null}
      <Button
        testID="settings-sign-out"
        variant={confirmSignOut && queued > 0 ? "danger" : "secondary"}
        icon="log-out"
        block
        label={t(
          confirmSignOut && queued > 0
            ? "compass.settings.signOutConfirm"
            : "compass.settings.signOut",
        )}
        onPress={() => {
          if (queued > 0 && !confirmSignOut) {
            setConfirmSignOut(true);
            return;
          }
          void signOut();
        }}
      />
      <Text variant="text12" tone="tertiary">
        {t("compass.settings.version", { version: Constants.expoConfig?.version ?? "" })}
      </Text>
    </Screen>
  );
}
