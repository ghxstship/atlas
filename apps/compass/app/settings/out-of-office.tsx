import type { Row } from "@xos/sync";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  RegistrySettingsScreen,
  type CrossCheck,
} from "../../src/screens/settings/RegistrySettings";
import { checkAwayPeriod } from "../../src/settings/preferences";

const STARTS = "me.out_of_office.starts_on";
const ENDS = "me.out_of_office.ends_on";
const ORDER = "compassPersonal.outOfOffice.order";

/** The saved date of one out-of-office setting, or null. */
function dateOf(rows: readonly Row[], key: string): string | null {
  const value = rows.find((r) => r.id === key)?.["value"];
  return typeof value === "string" && value !== "" ? value : null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** An out-of-office period never ends before it starts (private.person_away, 1325). */
function awayChecks(rows: readonly Row[]): Readonly<Record<string, CrossCheck>> {
  return {
    [STARTS]: (value) => (checkAwayPeriod(text(value), dateOf(rows, ENDS)) ? ORDER : null),
    [ENDS]: (value) => (checkAwayPeriod(dateOf(rows, STARTS), text(value)) ? ORDER : null),
  };
}

/**
 * Settings, Out of Office (sitemap settings.out-of-office, A111): whether the person is away, from and until when,
 * and the reply people see. Approvals go to their delegate while they are away (1325, 1395).
 */
export default function OutOfOfficeScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <RegistrySettingsScreen
      section="settings.out-of-office"
      title={t("nav.settings.personal.outOfOffice")}
      testID="settings-out-of-office"
      checks={awayChecks}
    />
  );
}
