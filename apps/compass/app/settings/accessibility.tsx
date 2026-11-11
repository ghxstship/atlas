import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { RegistrySettingsScreen } from "../../src/screens/settings/RegistrySettings";

/**
 * Settings, Accessibility (sitemap settings.accessibility, A111): text size, contrast, motion, haptics, sounds and
 * captions. Compass applies a change at once (themeOptionsOf, hapticsOn, soundsOn) and every shell reads the same
 * values.
 */
export default function AccessibilityScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <RegistrySettingsScreen
      section="settings.accessibility"
      title={t("nav.settings.personal.accessibility")}
      testID="settings-accessibility"
    />
  );
}
