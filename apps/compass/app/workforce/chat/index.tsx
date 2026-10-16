import { listMyConversations } from "@xos/data/workforce-chat";
import { ConversationsScreen } from "@xos/workforce-native";
import { useRouter } from "expo-router";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../../src/workforce/kit";
import { conversationsLabels } from "../../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../../src/workforce/runtime";

/** Conversations (Atlas people.chat): groups and direct messages with unread counts. */
function Conversations(): ReactElement {
  const t = useT();
  const router = useRouter();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(orgId ? () => listMyConversations(wf.db, orgId) : null, [
    orgId,
    wf.syncTick,
  ]);
  const conversations = loaded.data ?? [];
  return (
    <ConversationsScreen
      {...frameProps(loaded)}
      labels={conversationsLabels(t)}
      conversations={conversations}
      onOpen={(id) =>
        router.push({
          pathname: "/workforce/chat/[conversationId]",
          params: {
            conversationId: id,
            title: conversations.find((c) => c.id === id)?.title ?? "",
          },
        })
      }
      onNewMessage={() => router.push("/workforce/directory")}
    />
  );
}

export default function ConversationsRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Conversations />
    </WorkforceGate>
  );
}
