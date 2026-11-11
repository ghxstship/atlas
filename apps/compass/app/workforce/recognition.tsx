import { ok } from "@xos/data/result";
import { listWorkforceDirectory } from "@xos/data/workforce-chat";
import { listRecognitions } from "@xos/data/workforce-feed";
import { RecognitionScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { recognitionLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";
import { useContentSafety } from "../../src/workforce/safety";

/**
 * Recognition (Atlas people.recognition): shout-outs, given offline; a shout-out from someone else can be reported or
 * its author blocked (ADR 0033 decision 57).
 */
function Recognitions(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(
    orgId
      ? async () => {
          const [recognitions, people] = await Promise.all([
            listRecognitions(wf.db, orgId),
            listWorkforceDirectory(wf.db, orgId),
          ]);
          if (!recognitions.ok) return recognitions;
          if (!people.ok) return people;
          const me = new Set(wf.myMembershipIds);
          return ok({
            recognitions: recognitions.data,
            people: people.data
              .filter((p) => !me.has(p.membershipId))
              .map((p) => ({ membershipId: p.membershipId, name: p.preferredName ?? p.name })),
          });
        }
      : null,
    [orgId, wf.syncTick],
  );
  const safety = useContentSafety("shoutOut", loaded.refresh);
  return (
    <>
      <RecognitionScreen
        {...frameProps(loaded)}
        labels={recognitionLabels(t)}
        recognitions={loaded.data?.recognitions ?? []}
        people={loaded.data?.people ?? []}
        onRecognize={(membershipId, message) =>
          wf.queue("recognize", {
            p_org_id: orgId,
            p_to_membership_id: membershipId,
            p_message: message,
            p_project_id: wf.projectId ?? undefined,
          })
        }
        contentActions={safety.contentActions}
        myMembershipIds={wf.myMembershipIds}
      />
      {safety.sheet}
    </>
  );
}

export default function RecognitionRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Recognitions />
    </WorkforceGate>
  );
}
