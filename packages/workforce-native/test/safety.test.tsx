import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost, Recognition } from "@xos/data/workforce-feed";
import type { ChatMessage } from "@xos/data/workforce-chat";
import {
  ChatThreadScreen,
  FeedScreen,
  RecognitionScreen,
  type ChatThreadScreenLabels,
  type ContentActions,
  type FeedScreenLabels,
  type RecognitionScreenLabels,
} from "../src/index.ts";
import { AUDIENCE, expectAccessible, labels, ok } from "./helpers.tsx";

/** Owner decision 19: report and block on someone else's post, message or shout-out, never on one's own. */

const actions = (onOpen = vi.fn()): ContentActions => ({
  label: (author) => `actions(${author ?? "someone"})`,
  onOpen,
  testID: "content-actions",
});

const post = (over: Partial<FeedPost> = {}): FeedPost => ({
  id: "p1",
  kind: "Update",
  title: "Catering",
  body: "West tent.",
  audience: AUDIENCE,
  authorMembershipId: "m-ana",
  authorName: "Ana",
  pinnedAt: null,
  requiresAcknowledgment: false,
  reactionsEnabled: false,
  commentsEnabled: false,
  publishAt: "2026-10-01T10:00:00Z",
  hiddenAt: null,
  hiddenReason: null,
  acknowledgedByMe: false,
  reactions: {},
  myReactions: [],
  poll: null,
  ...over,
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "msg1",
  authorMembershipId: "m-sam",
  authorName: "Sam",
  kind: "Text",
  body: "Cables?",
  language: null,
  createdAt: "2026-10-01T10:00:00Z",
  editedAt: null,
  ...over,
});

const shoutOut = (over: Partial<Recognition> = {}): Recognition => ({
  id: "rec1",
  fromMembershipId: "m-sam",
  fromName: "Sam",
  toMembershipId: "m-me",
  toName: "Me",
  projectId: null,
  shiftId: null,
  message: "Thanks for the cover.",
  feedPostId: "fp1",
  createdAt: "2026-10-01T10:00:00Z",
  ...over,
});

describe("FeedScreen report and block", () => {
  it("offers the actions on posts by others, named for the author, and never on the viewer's own", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <FeedScreen
        status="ready"
        labels={labels<FeedScreenLabels>(["reaction", "byline"], ["kinds"])}
        posts={[post(), post({ id: "p2", authorMembershipId: "m-me", authorName: "Me" })]}
        onAcknowledge={ok}
        onReact={ok}
        onVote={ok}
        contentActions={actions(onOpen)}
        myMembershipIds={["m-me"]}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^actions\(/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "actions(Ana)" }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "Feed Post",
      id: "p1",
      authorMembershipId: "m-ana",
      authorName: "Ana",
    });
    expect(screen.getByTestId("content-actions")).toBeTruthy();
    await expectAccessible(container);
  });

  it("shows no actions when the app passes none", () => {
    render(
      <FeedScreen
        status="ready"
        labels={labels<FeedScreenLabels>(["reaction", "byline"], ["kinds"])}
        posts={[post()]}
        onAcknowledge={ok}
        onReact={ok}
        onVote={ok}
      />,
    );
    expect(screen.queryAllByRole("button", { name: /^actions\(/ })).toHaveLength(0);
  });
});

describe("ChatThreadScreen report and block", () => {
  it("offers the actions on the other person's messages only", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ChatThreadScreen
        status="ready"
        labels={labels<ChatThreadScreenLabels>(["meta"])}
        title="Sam"
        messages={[
          message(),
          message({ id: "msg2", authorMembershipId: "m-me", authorName: "Me" }),
        ]}
        myMembershipIds={["m-me"]}
        onSend={ok}
        contentActions={actions(onOpen)}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^actions\(/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "actions(Sam)" }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "Chat Message",
      id: "msg1",
      authorMembershipId: "m-sam",
      authorName: "Sam",
    });
    await expectAccessible(container);
  });
});

describe("RecognitionScreen report and block", () => {
  it("reports a shout-out as its feed post, and offers nothing on the viewer's own", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <RecognitionScreen
        status="ready"
        labels={labels<RecognitionScreenLabels>(["line"])}
        recognitions={[
          shoutOut(),
          shoutOut({ id: "rec2", fromMembershipId: "m-me", fromName: "Me", feedPostId: "fp2" }),
        ]}
        people={[]}
        onRecognize={ok}
        contentActions={actions(onOpen)}
        myMembershipIds={["m-me"]}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^actions\(/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "actions(Sam)" }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "Feed Post",
      id: "fp1",
      authorMembershipId: "m-sam",
      authorName: "Sam",
    });
    await expectAccessible(container);
  });
});
