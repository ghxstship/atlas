import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { RegistrySettingsScreen } from "../../src/screens/settings/RegistrySettings";

/**
 * Settings, Preferences (sitemap settings.preferences, A111): the language, time zone, date and number formats,
 * start page and the registry's other preferences, as Atlas and Gateway show them. The theme stays on Settings.
 */
export default function PreferencesScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <RegistrySettingsScreen
      section="settings.preferences"
      title={t("nav.settings.personal.preferences")}
      testID="settings-preferences"
    />
  );
}
