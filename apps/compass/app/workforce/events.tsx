import { listWorkforceEvents } from "@xos/data/workforce-events";
import { EventsScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { eventsLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Events (Atlas schedule.events): briefings, crew calls and meetings; RSVP and check in offline. */
function Events(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(
    orgId
      ? () =>
          listWorkforceEvents(wf.db, orgId, {
            from: new Date(Date.now() - 12 * 3_600_000).toISOString(),
            projectId: wf.projectId,
          })
      : null,
    [orgId, wf.projectId, wf.syncTick],
  );
  return (
    <EventsScreen
      {...frameProps(loaded)}
      labels={eventsLabels(t)}
      events={loaded.data ?? []}
      myMembershipIds={wf.myMembershipIds}
      onRsvp={(eventId, response) =>
        wf.queue("rsvp_to_event", { p_event_id: eventId, p_response: response })
      }
      onCheckIn={(eventId) => wf.queue("check_in_to_event", { p_event_id: eventId })}
      onEmptyAction={loaded.refresh}
    />
  );
}

export default function EventsRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Events />
    </WorkforceGate>
  );
}
