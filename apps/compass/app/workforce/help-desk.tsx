import { ok } from "@xos/data/result";
import {
  listHelpDeskRequests,
  listHelpDeskTeams,
  openHelpDeskRequest,
} from "@xos/data/workforce-help-desk";
import { HelpDeskScreen } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import type { ReactElement } from "react";
import { useCompass } from "../../src/runtime/CompassProvider";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { helpDeskLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/**
 * Help desk (Atlas people.help-desk): the person's own requests and asking a team. A request needs its
 * number from the server, so asking goes online; the conversation continues in Atlas.
 */
function HelpDesk(): ReactElement {
  const t = useT();
  const { config } = useCompass();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(
    orgId
      ? async () => {
          const [requests, teams] = await Promise.all([
            listHelpDeskRequests(wf.db, orgId),
            listHelpDeskTeams(wf.db, orgId),
          ]);
          if (!requests.ok) return requests;
          if (!teams.ok) return teams;
          return ok({
            requests: requests.data,
            teams: teams.data
              .filter((team) => team.archivedAt === null)
              .map((team) => ({ id: team.id, name: team.name })),
          });
        }
      : null,
    [orgId],
  );
  return (
    <HelpDeskScreen
      {...frameProps(loaded)}
      labels={helpDeskLabels(t)}
      requests={loaded.data?.requests ?? []}
      teams={loaded.data?.teams ?? []}
      onOpenRequest={() => void Linking.openURL(config.atlasUrl)}
      onAsk={async (teamId, category, subject, body) => {
        if (!orgId) return { ok: false, message: t("workforce.compass.common.unexpected") };
        const result = await wf.online(
          openHelpDeskRequest(wf.db, orgId, { teamId, category, subject, body }),
        );
        if (result.ok) loaded.refresh();
        return result;
      }}
    />
  );
}

export default function HelpDeskRoute(): ReactElement {
  return (
    <WorkforceGate>
      <HelpDesk />
    </WorkforceGate>
  );
}
