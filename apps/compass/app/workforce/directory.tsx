import { listWorkforceDirectory, startDirectConversation } from "@xos/data/workforce-chat";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { DirectoryScreen } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { directoryLabels } from "../../src/workforce/labels";
import { actionMessage, useLoad, useWorkforce } from "../../src/workforce/runtime";
import { InlineAlert } from "../../src/ui";

/** Directory (Atlas people.chat): who is on site, call or message them. */
function Directory(): ReactElement {
  const t = useT();
  const { i18n } = useTranslation();
  const region = regionFromLocale(i18n.language);
  const router = useRouter();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const [search, setSearch] = useState("");
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
        formatPhone={(e164) => formatPhone(e164, region)}
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
