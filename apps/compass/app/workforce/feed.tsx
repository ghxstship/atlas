import { listFeed } from "@xos/data/workforce-feed";
import { FeedScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { feedLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";
import { useContentSafety } from "../../src/workforce/safety";

/**
 * Feed (Section 4.9, Atlas knowledge.feed): announcements, polls, reactions and acknowledgments; a post by someone
 * else can be reported or its author blocked (owner decision 19).
 */
function Feed(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(
    orgId ? () => listFeed(wf.db, orgId, wf.myMembershipIds, { projectId: wf.projectId }) : null,
    [orgId, wf.projectId, wf.syncTick],
  );
  const posts = loaded.data ?? [];
  const safety = useContentSafety("post", loaded.refresh);
  return (
    <>
      <FeedScreen
        {...frameProps(loaded)}
        labels={feedLabels(t)}
        posts={posts}
        onAcknowledge={(postId) => wf.queue("acknowledge_feed_post", { p_post_id: postId })}
        onReact={(postId, code) =>
          wf.queue("react_to_feed_post", {
            p_post_id: postId,
            p_reaction_code: code,
            p_on: !(posts.find((p) => p.id === postId)?.myReactions.includes(code) ?? false),
          })
        }
        onVote={(pollId, optionIds) =>
          wf.queue("vote_in_poll", { p_poll_id: pollId, p_option_ids: [...optionIds] })
        }
        onEmptyAction={loaded.refresh}
        contentActions={safety.contentActions}
        myMembershipIds={wf.myMembershipIds}
      />
      {safety.sheet}
    </>
  );
}

export default function FeedRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Feed />
    </WorkforceGate>
  );
}
