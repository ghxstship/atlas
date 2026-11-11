import { blockMember } from "@xos/data/content-safety";
import { listWorkforceDirectory, startDirectConversation } from "@xos/data/workforce-chat";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { DirectoryScreen, type ContentActionTarget } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { directoryLabels } from "../../src/workforce/labels";
import { actionMessage, useLoad, useWorkforce } from "../../src/workforce/runtime";
import { useCompass } from "../../src/runtime/CompassProvider";
import { ContentSafetySheet } from "../../src/screens/ContentSafetySheet";
import { InlineAlert } from "../../src/ui";

/**
 * Directory (Atlas people.chat): who is on site, call or message them, or block someone whose name or headline is
 * abusive (App Store Review Guideline 1.2; a block hides them here and everywhere they write, 1631 and 1632). Opened
 * from Today's search with ?q=, it starts searched for that name.
 */
function Directory(): ReactElement {
  const t = useT();
  const { i18n } = useTranslation();
  const region = regionFromLocale(i18n.language);
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string }>();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const [search, setSearch] = useState(typeof q === "string" ? q : "");
  const [onSiteOnly, setOnSiteOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { network } = useCompass();
  // The person to block; a card is a person, not an item, so the sheet opens on the block's confirmation.
  const [blocking, setBlocking] = useState<ContentActionTarget | null>(null);
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
        myMembershipIds={wf.myMembershipIds}
        onBlock={(membershipId, name) =>
          setBlocking({
            kind: "Chat Message",
            id: membershipId,
            authorMembershipId: membershipId,
            authorName: name,
          })
        }
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
      <ContentSafetySheet
        target={blocking}
        noun="message"
        online={network.isConnected}
        blockOnly
        onReport={() => Promise.resolve({ ok: true })}
        onBlock={(membershipId) => wf.online(blockMember(wf.db, membershipId))}
        onBlocked={loaded.refresh}
        onClose={() => setBlocking(null)}
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
