import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ClockTeam } from "../src/screens/ClockTeam";
import { Gate } from "../src/screens/common";
import { Screen } from "../src/ui";

/**
 * Clock in team (R12, G-126): a field supervisor from the Crew tab, or a staffing agency's lead from Today,
 * punches the people they supervise in or out at once.
 */
export default function ClockTeamScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <Screen testID="clock-team" title={t("nav.compass.routes.clockTeam")}>
      <Gate feature="clock.team">
        <ClockTeam />
      </Gate>
    </Screen>
  );
}
