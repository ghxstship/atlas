import { listOccupancyCounters } from "@xos/data/workforce-site";
import { OccupancyCounterScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { occupancyLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Occupancy counter (Atlas site-ops.occupancy): door counts against the permitted load, offline. */
function Occupancy(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const projectId = wf.projectId;
  const loaded = useLoad(projectId ? () => listOccupancyCounters(wf.db, projectId) : null, [
    projectId,
    wf.syncTick,
  ]);
  return (
    <OccupancyCounterScreen
      {...frameProps(loaded)}
      labels={occupancyLabels(t)}
      counters={loaded.data ?? []}
      onCount={(counterId, delta, door) =>
        wf.queue("record_occupancy_count", {
          p_counter_id: counterId,
          p_delta: delta,
          p_door: door ?? undefined,
        })
      }
      onEmptyAction={loaded.refresh}
    />
  );
}

export default function OccupancyRoute(): ReactElement {
  return (
    <WorkforceGate needsProject>
      <Occupancy />
    </WorkforceGate>
  );
}
