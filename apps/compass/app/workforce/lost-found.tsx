import { listLostItems } from "@xos/data/workforce-site";
import { LostFoundScreen } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import type { ReactElement } from "react";
import { useCompass } from "../../src/runtime/CompassProvider";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { lostFoundLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Lost and found (Atlas site-ops.lost-and-found): log found items offline; claims continue in Atlas. */
function LostFound(): ReactElement {
  const t = useT();
  const { config } = useCompass();
  const wf = useWorkforce(t);
  const projectId = wf.projectId;
  const loaded = useLoad(projectId ? () => listLostItems(wf.db, projectId) : null, [
    projectId,
    wf.syncTick,
  ]);
  return (
    <LostFoundScreen
      {...frameProps(loaded)}
      labels={lostFoundLabels(t)}
      items={loaded.data ?? []}
      onLog={(draft) =>
        wf.queue("log_lost_item", {
          p_project_id: projectId,
          p_category: draft.category,
          p_description: draft.description,
          p_found_location: draft.foundLocation,
          p_storage_location: draft.storageLocation ?? undefined,
          p_found_at: new Date().toISOString(),
        })
      }
      onOpenItem={() => void Linking.openURL(config.atlasUrl)}
    />
  );
}

export default function LostFoundRoute(): ReactElement {
  return (
    <WorkforceGate needsProject>
      <LostFound />
    </WorkforceGate>
  );
}
