import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import { useAllowed } from "../../src/screens/common";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  SegmentedControl,
  Switch,
  Text,
  type ThemePreference,
} from "../../src/ui";

/**
 * Compass settings: theme with the Sunlight outdoor theme, haptics, battery saver and low-data mode, kiosk
 * mode, sign-out and account deletion. The theme also saves to the person's me.theme setting (A30) when it
 * is one the platform knows; Sunlight is a device preference only.
 */
export default function SettingsScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { settings, updateSettings, status, signOut, enqueue, config } = useCompass();
  const canKiosk = useAllowed("kiosk.operate");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
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
  const queued = status?.queued ?? 0;
  return (
    <Screen testID="settings" title={t("compass.settings.title")}>
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
          value={settings.haptics}
          onChange={(haptics) => updateSettings({ haptics })}
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
      <Card>
        {canKiosk ? (
          <ListRow
            testID="settings-kiosk"
            icon="tablet"
            title={t("compass.settings.kiosk")}
            subtitle={t("compass.settings.kioskHelp")}
            onPress={() => router.push("/kiosk")}
          />
        ) : null}
        <ListRow
          icon="user"
          title={t("compass.settings.personal")}
          onPress={() => void Linking.openURL(`${config.gatewayUrl}/settings`)}
        />
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
          onPress={() => router.push("/settings/account")}
        />
      </Card>
      {confirmSignOut && queued > 0 ? (
        <InlineAlert
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
