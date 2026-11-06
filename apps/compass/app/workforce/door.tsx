import { listDoorGuests } from "@xos/data/workforce-site";
import { DoorCheckInScreen } from "@xos/workforce-native";
import { useLocalSearchParams } from "expo-router";
import { useState, type ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { doorLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/**
 * Guest check-in (Atlas site-ops.guest-check-in): approved guests admitted with plus-ones, offline. A guest pass the
 * Scan tab read arrives as ?pass=, which searches the door list for that exact code (6254) and opens the guest.
 */
function Door({ scannedPass }: { readonly scannedPass: string | null }): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const projectId = wf.projectId;
  const [search, setSearch] = useState(scannedPass ?? "");
  const loaded = useLoad(
    projectId ? () => listDoorGuests(wf.db, projectId, search.trim() || null) : null,
    [projectId, search, wf.syncTick],
  );
  return (
    <DoorCheckInScreen
      {...frameProps(loaded)}
      labels={doorLabels(t)}
      guests={loaded.data ?? []}
      scannedPass={scannedPass}
      search={search}
      onSearch={setSearch}
      onCheckIn={(entryId, plusOnesAdmitted, door) =>
        wf.queue("check_in_guest", {
          p_guest_list_entry_id: entryId,
          p_plus_ones_admitted: plusOnesAdmitted,
          p_door: door ?? undefined,
        })
      }
    />
  );
}

export default function DoorRoute(): ReactElement {
  const { pass } = useLocalSearchParams<{ pass?: string }>();
  return (
    <WorkforceGate needsProject>
      {/* Each scanned pass starts again, with its own search and its own answer. */}
      <Door key={pass ?? "door"} scannedPass={pass ?? null} />
    </WorkforceGate>
  );
}
