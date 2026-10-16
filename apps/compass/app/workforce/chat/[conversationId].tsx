import { listMessages } from "@xos/data/workforce-chat";
import { ChatThreadScreen } from "@xos/workforce-native";
import { useLocalSearchParams } from "expo-router";
import { useEffect, type ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../../src/workforce/kit";
import { threadLabels } from "../../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../../src/workforce/runtime";

/** One conversation: messages oldest first; sending and read marks queue offline. */
function Thread(): ReactElement {
  const t = useT();
  const { conversationId, title } = useLocalSearchParams<{
    conversationId: string;
    title?: string;
  }>();
  const wf = useWorkforce(t);
  const { queue } = wf;
  const loaded = useLoad(() => listMessages(wf.db, conversationId), [conversationId, wf.syncTick]);
  useEffect(() => {
    void queue("mark_conversation_read", { p_conversation_id: conversationId });
  }, [conversationId, queue]);
  const name = title && title.length > 0 ? title : t("workforce.compass.chat.title");
  return (
    <ChatThreadScreen
      {...frameProps(loaded)}
      labels={threadLabels(t, name)}
      title={name}
      messages={loaded.data ?? []}
      myMembershipIds={wf.myMembershipIds}
      onSend={(body) =>
        queue("send_chat_message", { p_conversation_id: conversationId, p_body: body })
      }
    />
  );
}

export default function ThreadRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Thread />
    </WorkforceGate>
  );
}
