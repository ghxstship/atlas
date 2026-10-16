import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost, Recognition, Survey } from "@xos/data/workforce-feed";
import type { ChatMessage, ConversationSummary, DirectoryPerson } from "@xos/data/workforce-chat";
import {
  ChatThreadScreen,
  ConversationsScreen,
  DirectoryScreen,
  FeedScreen,
  RecognitionScreen,
  SurveyScreen,
  type ChatThreadScreenLabels,
  type ConversationsScreenLabels,
  type DirectoryScreenLabels,
  type FeedScreenLabels,
  type RecognitionScreenLabels,
  type SurveyScreenLabels,
} from "../src/index.ts";
import { AUDIENCE, at, expectAccessible, labels, ok, refused } from "./helpers.tsx";

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(button(name));
  });
};

const post = (over: Partial<FeedPost> = {}): FeedPost => ({
  id: "p1",
  kind: "Announcement",
  title: "Wristband Change",
  body: "Orange from Friday.",
  audience: AUDIENCE,
  authorMembershipId: "m-author",
  authorName: "Ana",
  pinnedAt: "2026-10-01T10:00:00Z",
  requiresAcknowledgment: true,
  reactionsEnabled: true,
  commentsEnabled: true,
  publishAt: "2026-10-01T10:00:00Z",
  hiddenAt: null,
  hiddenReason: null,
  acknowledgedByMe: false,
  reactions: { thumbs_up: 2 },
  myReactions: [],
  poll: null,
  ...over,
});

const feedLabels = labels<FeedScreenLabels>(["reaction", "byline"], ["kinds"]);

describe("FeedScreen", () => {
  it("shows the loading, error and empty states", async () => {
    const onRetry = vi.fn();
    const actions = { onAcknowledge: ok, onReact: ok, onVote: ok };
    const { rerender, container } = render(
      <FeedScreen status="loading" labels={feedLabels} posts={[]} {...actions} />,
    );
    expect(screen.getByLabelText("loading")).toBeTruthy();
    rerender(
      <FeedScreen
        status="error"
        labels={feedLabels}
        posts={[]}
        onRetry={onRetry}
        errorReference="ref-1"
        {...actions}
      />,
    );
    expect(screen.getByText("errorTitle")).toBeTruthy();
    fireEvent.click(button("retry"));
    expect(onRetry).toHaveBeenCalled();
    const onEmptyAction = vi.fn();
    rerender(
      <FeedScreen
        status="ready"
        labels={feedLabels}
        posts={[]}
        onEmptyAction={onEmptyAction}
        {...actions}
      />,
    );
    expect(screen.getByText("empty")).toBeTruthy();
    fireEvent.click(button("emptyAction"));
    expect(onEmptyAction).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("acknowledges, reacts, opens comments and shows a refusal", async () => {
    const onAcknowledge = vi.fn(ok);
    const onReact = vi.fn(refused("Reactions are off for this post."));
    const onOpenComments = vi.fn();
    const { container } = render(
      <FeedScreen
        status="ready"
        labels={feedLabels}
        posts={[post()]}
        onAcknowledge={onAcknowledge}
        onReact={onReact}
        onVote={ok}
        onOpenComments={onOpenComments}
      />,
    );
    expect(screen.getByText("pinned")).toBeTruthy();
    expect(screen.getByText("mustAcknowledge")).toBeTruthy();
    expect(screen.getByText('byline("Ana","2026-10-01T10:00:00Z")')).toBeTruthy();
    await press("acknowledge");
    expect(onAcknowledge).toHaveBeenCalledWith("p1");
    await press('reaction("thumbs_up",2,false)');
    expect(onReact).toHaveBeenCalledWith("p1", "thumbs_up");
    expect(screen.getByRole("alert").textContent).toContain("Reactions are off for this post.");
    fireEvent.click(button("comments"));
    expect(onOpenComments).toHaveBeenCalledWith("p1");
    await expectAccessible(container);
  });

  it("votes in single and multiple choice polls and shows a thrown error", async () => {
    const onVote = vi.fn(ok);
    const single = post({
      id: "p2",
      kind: "Poll",
      title: null,
      pinnedAt: null,
      requiresAcknowledgment: false,
      reactionsEnabled: false,
      commentsEnabled: false,
      poll: {
        id: "poll1",
        question: "Crew meal?",
        allowsMultiple: false,
        closesAt: null,
        options: [
          { id: "o1", position: 1, label: "Tacos" },
          { id: "o2", position: 2, label: "Pasta" },
        ],
        myChoices: [],
      },
    });
    const multi = post({
      id: "p3",
      kind: "Poll",
      pinnedAt: null,
      requiresAcknowledgment: true,
      acknowledgedByMe: true,
      reactionsEnabled: false,
      poll: {
        id: "poll2",
        question: "Which days?",
        allowsMultiple: true,
        closesAt: null,
        options: [
          { id: "d1", position: 1, label: "Friday" },
          { id: "d2", position: 2, label: "Saturday" },
        ],
        myChoices: [],
      },
    });
    const voted = post({
      id: "p4",
      pinnedAt: null,
      requiresAcknowledgment: false,
      reactionsEnabled: false,
      poll: {
        ...(multi.poll as NonNullable<FeedPost["poll"]>),
        id: "poll3",
        allowsMultiple: false,
        myChoices: ["d1"],
      },
    });
    render(
      <FeedScreen
        status="ready"
        labels={feedLabels}
        posts={[single, multi, voted]}
        onAcknowledge={ok}
        onReact={ok}
        onVote={onVote}
      />,
    );
    expect(screen.getAllByText("kinds.Poll").length).toBeGreaterThan(0);
    await press("Tacos");
    expect(onVote).toHaveBeenCalledWith("poll1", ["o1"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Saturday" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Friday" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Friday" }));
    await press("vote");
    expect(onVote).toHaveBeenCalledWith("poll2", ["d2"]);
    expect(screen.getByText("voted")).toBeTruthy();
    expect(screen.getByText("acknowledged")).toBeTruthy();

    onVote.mockImplementationOnce(() => Promise.reject(new Error("Network down")));
    await press("Pasta");
    expect(screen.getByRole("alert").textContent).toContain("Network down");
    onVote.mockImplementationOnce(() => Promise.reject(new Error("")));
    await press("Pasta");
    expect(screen.getByRole("alert").textContent).toContain("failed");
  });
});

const surveyLabels = labels<SurveyScreenLabels>(["answerRequired", "optionalQuestion"]);
const survey = (over: Partial<Survey> = {}): Survey => ({
  id: "s1",
  title: "Load-In Pulse",
  description: "Three questions.",
  audience: AUDIENCE,
  authorMembershipId: null,
  anonymous: true,
  minResponses: 3,
  state: "Open",
  closesAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  respondedByMe: false,
  questions: [
    {
      id: "q1",
      position: 1,
      prompt: "Safe?",
      kind: "Scale",
      choices: [],
      scaleMax: 5,
      required: true,
    },
    {
      id: "q2",
      position: 2,
      prompt: "Shift?",
      kind: "Choice",
      choices: ["Morning", "Night"],
      scaleMax: null,
      required: true,
    },
    {
      id: "q3",
      position: 3,
      prompt: "Fix?",
      kind: "Text",
      choices: [],
      scaleMax: null,
      required: false,
    },
  ],
  ...over,
});

describe("SurveyScreen", () => {
  it("collects scale, choice and text answers and submits them", async () => {
    const onRespond = vi.fn(ok);
    const { container } = render(
      <SurveyScreen status="ready" labels={surveyLabels} survey={survey()} onRespond={onRespond} />,
    );
    expect(screen.getByText("anonymous")).toBeTruthy();
    expect(screen.getByText("answerRequired(2)")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.click(screen.getByRole("radio", { name: "Night" }));
    fireEvent.change(screen.getByLabelText('optionalQuestion("Fix?")'), {
      target: { value: "More water" },
    });
    await expectAccessible(container);
    await press("submit");
    expect(onRespond).toHaveBeenCalledWith("s1", { q1: 4, q2: "Night", q3: "More water" });
    expect(screen.getByText("submitted")).toBeTruthy();
  });

  it("shows closed, answered and missing surveys", () => {
    const { rerender } = render(
      <SurveyScreen
        status="ready"
        labels={surveyLabels}
        survey={survey({ state: "Closed" })}
        onRespond={ok}
      />,
    );
    expect(screen.getByText("closed")).toBeTruthy();
    rerender(
      <SurveyScreen
        status="ready"
        labels={surveyLabels}
        survey={survey({ respondedByMe: true, anonymous: false, description: null })}
        onRespond={ok}
      />,
    );
    expect(screen.getByText("submitted")).toBeTruthy();
    rerender(<SurveyScreen status="ready" labels={surveyLabels} survey={null} onRespond={ok} />);
    expect(screen.getByText("errorTitle")).toBeTruthy();
  });
});

const conversation = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c1",
  kind: "Group",
  groupId: "g1",
  title: "Production Crew Space",
  otherMembershipId: null,
  lastMessageAt: "2026-10-01T06:00:00Z",
  lastMessageBody: "Load-in at 06:00",
  unread: 3,
  muted: false,
  ...over,
});

describe("ConversationsScreen", () => {
  it("lists conversations with unread and muted marks, and starts a new message", async () => {
    const onOpen = vi.fn();
    const onNewMessage = vi.fn();
    const props = { onOpen, onNewMessage };
    const cl = labels<ConversationsScreenLabels>(["unread"]);
    const { container, rerender } = render(
      <ConversationsScreen
        status="ready"
        labels={cl}
        conversations={[
          conversation(),
          conversation({
            id: "c2",
            kind: "Direct",
            title: "Sam",
            lastMessageBody: null,
            unread: 0,
            muted: true,
          }),
          conversation({ id: "c3", title: "Quiet", unread: 0 }),
        ]}
        {...props}
      />,
    );
    expect(screen.getByLabelText("unread(3)")).toBeTruthy();
    expect(screen.getByText("muted")).toBeTruthy();
    expect(screen.getByText("noMessages")).toBeTruthy();
    fireEvent.click(screen.getByText("Sam"));
    expect(onOpen).toHaveBeenCalledWith("c2");
    fireEvent.click(button("newMessage"));
    expect(onNewMessage).toHaveBeenCalled();
    await expectAccessible(container);
    rerender(<ConversationsScreen status="ready" labels={cl} conversations={[]} {...props} />);
    expect(screen.getByText("empty")).toBeTruthy();
  });
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "x1",
  authorMembershipId: "m-me",
  authorName: "Me",
  kind: "Text",
  body: "On my way.",
  language: "en",
  createdAt: "2026-10-01T06:01:00Z",
  editedAt: null,
  ...over,
});

describe("ChatThreadScreen", () => {
  it("sends a message, clears the draft and opens attachments", async () => {
    const onSend = vi.fn(ok);
    const onOpenAttachment = vi.fn();
    const tl = labels<ChatThreadScreenLabels>(["meta"], [], { readBy: "Read by Ana" });
    const { container } = render(
      <ChatThreadScreen
        status="ready"
        labels={tl}
        title="Production Crew Space"
        myMembershipIds={["m-me"]}
        messages={[
          message(),
          message({
            id: "x2",
            authorMembershipId: "m-ana",
            authorName: null,
            kind: "Photo",
            body: null,
            editedAt: "2026-10-01T06:05:00Z",
          }),
        ]}
        onSend={onSend}
        onOpenAttachment={onOpenAttachment}
      />,
    );
    expect(screen.getByText('meta("you","2026-10-01T06:01:00Z")')).toBeTruthy();
    expect(screen.getByText('meta("someone","2026-10-01T06:01:00Z")')).toBeTruthy();
    expect(screen.getByText("edited")).toBeTruthy();
    expect(screen.getByText("Read by Ana")).toBeTruthy();
    fireEvent.click(button("attachment"));
    expect(onOpenAttachment).toHaveBeenCalledWith("x2");
    const box = screen.getByLabelText("message");
    fireEvent.change(box, { target: { value: "  Coffee?  " } });
    await press("send");
    expect(onSend).toHaveBeenCalledWith("Coffee?");
    expect((box as HTMLTextAreaElement).value).toBe("");
    await expectAccessible(container);
  });

  it("keeps the draft when sending is refused and shows the empty thread", async () => {
    const tl = labels<ChatThreadScreenLabels>(["meta"]);
    const { rerender } = render(
      <ChatThreadScreen
        status="ready"
        labels={tl}
        title="Sam"
        myMembershipIds={[]}
        messages={[]}
        onSend={refused("You left this conversation.")}
      />,
    );
    expect(screen.getByText("empty")).toBeTruthy();
    const box = screen.getByLabelText("message");
    fireEvent.change(box, { target: { value: "Hello" } });
    await press("send");
    expect((box as HTMLTextAreaElement).value).toBe("Hello");
    expect(screen.getByRole("alert").textContent).toContain("You left this conversation.");
    rerender(
      <ChatThreadScreen
        status="loading"
        labels={tl}
        title="Sam"
        myMembershipIds={[]}
        messages={[]}
        onSend={ok}
      />,
    );
    expect(screen.getByLabelText("loading")).toBeTruthy();
  });
});

const person = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  membershipId: "m1",
  personId: "p1",
  name: "Samuel Rivera",
  preferredName: "Sam",
  headline: "Rigger",
  photoPath: null,
  roles: ["Rigger"],
  onSite: true,
  onSiteProjectId: "prj",
  onSiteSince: "2026-10-01T06:00:00Z",
  workPhone: "+1 (305) 555-0100",
  recognitionCount: 2,
  ...over,
});

describe("DirectoryScreen", () => {
  it("searches, filters to on site, calls and messages", async () => {
    const onSearch = vi.fn();
    const onScopeChange = vi.fn();
    const onCall = vi.fn();
    const onMessage = vi.fn();
    const dl = labels<DirectoryScreenLabels>(["call", "message", "recognitions"]);
    const props = { onSearch, onScopeChange, onCall, onMessage };
    const { container, rerender } = render(
      <DirectoryScreen
        status="ready"
        labels={dl}
        people={[
          person(),
          person({
            membershipId: "m2",
            preferredName: null,
            name: "Ana",
            headline: null,
            onSite: false,
            workPhone: null,
            recognitionCount: null,
            roles: [],
          }),
        ]}
        search=""
        onSiteOnly={false}
        {...props}
      />,
    );
    expect(screen.getByText("onSite")).toBeTruthy();
    expect(screen.getByText("recognitions(2)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "sa" } });
    expect(onSearch).toHaveBeenCalledWith("sa");
    fireEvent.click(screen.getByRole("radio", { name: "onSiteNow" }));
    expect(onScopeChange).toHaveBeenCalledWith(true);
    fireEvent.click(button('call("Sam")'));
    expect(onCall).toHaveBeenCalledWith("tel:+13055550100");
    expect(screen.queryByRole("button", { name: 'call("Ana")' })).toBeNull();
    fireEvent.click(button('message("Ana")'));
    expect(onMessage).toHaveBeenCalledWith("m2");
    await expectAccessible(container);
    rerender(
      <DirectoryScreen status="ready" labels={dl} people={[]} search="zz" onSiteOnly {...props} />,
    );
    fireEvent.click(button("clearSearch"));
    expect(onSearch).toHaveBeenCalledWith("");
    expect(onScopeChange).toHaveBeenCalledWith(false);
  });
});

const recognition = (over: Partial<Recognition> = {}): Recognition => ({
  id: "r1",
  fromMembershipId: "m1",
  fromName: "Ana",
  toMembershipId: "m2",
  toName: "Sam",
  projectId: null,
  shiftId: null,
  message: "Re-rigged the truss in record time.",
  feedPostId: null,
  createdAt: "2026-10-01T22:00:00Z",
  ...over,
});

describe("RecognitionScreen", () => {
  it("lists recognitions and recognizes a teammate from the sheet", async () => {
    const onRecognize = vi.fn(ok);
    const rl = labels<RecognitionScreenLabels>(["line"]);
    const people = [
      { membershipId: "m2", name: "Sam" },
      { membershipId: "m3", name: "Lee" },
    ];
    const { container, rerender } = render(
      <RecognitionScreen
        status="ready"
        labels={rl}
        recognitions={[recognition()]}
        people={people}
        onRecognize={onRecognize}
      />,
    );
    expect(screen.getByText("Re-rigged the truss in record time.")).toBeTruthy();
    fireEvent.click(button("give"));
    expect(screen.getByRole("dialog", { name: "sheetTitle" })).toBeTruthy();
    fireEvent.click(button("Lee"));
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "Thanks for the night shift." },
    });
    await expectAccessible(container);
    await press("send");
    expect(onRecognize).toHaveBeenCalledWith("m3", "Thanks for the night shift.");
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <RecognitionScreen
        status="ready"
        labels={rl}
        recognitions={[]}
        people={people}
        onRecognize={onRecognize}
      />,
    );
    expect(screen.getByText("empty")).toBeTruthy();
    fireEvent.click(at(screen.getAllByRole("button", { name: "give" }), 0));
    const closers = screen.getAllByRole("button", { name: "close" });
    fireEvent.click(at(closers, -1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
