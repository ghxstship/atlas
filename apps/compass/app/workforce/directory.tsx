import { listWorkforceDirectory, startDirectConversation } from "@xos/data/workforce-chat";
import { DirectoryScreen } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, type ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { directoryLabels } from "../../src/workforce/labels";
import { actionMessage, useLoad, useWorkforce } from "../../src/workforce/runtime";
import { InlineAlert } from "../../src/ui";

/**
 * Directory (Atlas people.chat): who is on site, call or message them. Opened from Today's search with ?q=, it starts
 * searched for that name.
 */
function Directory(): ReactElement {
  const t = useT();
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string }>();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const [search, setSearch] = useState(typeof q === "string" ? q : "");
  const [onSiteOnly, setOnSiteOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useLoad(
    orgId ? () => listWorkforceDirectory(wf.db, orgId, { search, onSiteOnly }) : null,
    [orgId, search, onSiteOnly],
  );
  return (
    <>
      {error ? <InlineAlert tone="danger" message={error} /> : null}
      <DirectoryScreen
        {...frameProps(loaded)}
        labels={directoryLabels(t)}
        people={loaded.data ?? []}
        search={search}
        onSearch={setSearch}
        onSiteOnly={onSiteOnly}
        onScopeChange={setOnSiteOnly}
        onCall={(href) => void Linking.openURL(href)}
        onMessage={(membershipId) => {
          if (!orgId) return;
          // A direct message needs its conversation id from the server, so it opens online.
          void startDirectConversation(wf.db, orgId, membershipId).then((result) => {
            if (!result.ok) {
              setError(actionMessage(result.error, t));
              return;
            }
            setError(null);
            router.push({
              pathname: "/workforce/chat/[conversationId]",
              params: {
                conversationId: result.data.id,
                title: loaded.data?.find((p) => p.membershipId === membershipId)?.name ?? "",
              },
            });
          });
        }}
      />
    </>
  );
}

export default function DirectoryRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Directory />
    </WorkforceGate>
  );
}
