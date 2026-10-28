import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import {
  FactorsCard,
  PasswordCard,
  SecurityOffline,
  useSecurityData,
} from "../../src/screens/settings/SecurityCards";
import {
  PasskeysCard,
  RecoveryCard,
  SessionsCard,
} from "../../src/screens/settings/SecuritySessions";
import { useStepUp } from "../../src/screens/settings/StepUp";
import { Screen, Text } from "../../src/ui";

/**
 * Settings, Security (sitemap settings.security; Section 4.5.6 item 4, A77, A99): the password, second factors,
 * passkeys, recovery codes, and sessions and devices of the one sign-in Atlas, Gateway and Compass share, under the
 * rules Gateway applies, step-up included (ADR 0070). Everything here needs a connection. Sign in with Apple is
 * Compass's own sign-in method and is not managed here.
 */
export default function SecurityScreen(): ReactElement {
  const { t } = useTranslation();
  const { network } = useCompass();
  const data = useSecurityData();
  const stepUp = useStepUp("settings-security-step-up");
  return (
    <Screen
      testID="settings-security"
      title={t("nav.settings.personal.security")}
      keyboardShouldPersistTaps="handled"
    >
      <Text tone="secondary">{t("gateway.settings.leads.security")}</Text>
      {!network.isConnected ? <SecurityOffline /> : null}
      <PasswordCard data={data} stepUp={stepUp} />
      <FactorsCard data={data} stepUp={stepUp} />
      <RecoveryCard data={data} stepUp={stepUp} />
      <PasskeysCard data={data} stepUp={stepUp} />
      <SessionsCard data={data} />
      {stepUp.sheet}
    </Screen>
  );
}
