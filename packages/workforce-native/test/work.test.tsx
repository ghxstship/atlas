import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkforceEvent } from "@xos/data/workforce-events";
import type { FormTemplate } from "@xos/data/workforce-forms";
import type { HandbookArticle, TrainingCourse } from "@xos/data/workforce-training";
import type { HelpDeskRequest } from "@xos/data/workforce-help-desk";
import {
  EventsScreen,
  FormFillScreen,
  HandbookScreen,
  HelpDeskScreen,
  TrainingScreen,
  type EventsScreenLabels,
  type FormFillScreenLabels,
  type HandbookScreenLabels,
  type HelpDeskScreenLabels,
  type MyCourse,
  type TrainingScreenLabels,
} from "../src/index.ts";
import { AUDIENCE, at, expectAccessible, labels, ok, refused } from "./helpers.tsx";

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(button(name));
  });
};

const NOW = new Date("2026-10-02T09:30:00Z");
const event = (over: Partial<WorkforceEvent> = {}): WorkforceEvent => ({
  id: "e1",
  kind: "Briefing",
  title: "Show Day Safety Briefing",
  agenda: "Weather plan.",
  location: "Pier Deck",
  venueId: null,
  spaceId: null,
  audience: AUDIENCE,
  organizerMembershipId: "m-org",
  organizerName: "Ana",
  startsAt: "2026-10-02T09:00:00Z",
  endsAt: "2026-10-02T10:00:00Z",
  rsvpRequired: true,
  canceledAt: null,
  cancelReason: null,
  rsvps: [{ membershipId: "m-me", name: "Me", response: "Maybe" }],
  checkIns: [],
  ...over,
});

describe("EventsScreen", () => {
  it("answers RSVPs and checks in to a live event", async () => {
    const onRsvp = vi.fn(ok);
    const onCheckIn = vi.fn(ok);
    const el = labels<EventsScreenLabels>(["when", "counts"], ["kinds", "responses", "phases"]);
    const { container } = render(
      <EventsScreen
        status="ready"
        labels={el}
        now={NOW}
        myMembershipIds={["m-me"]}
        events={[
          event(),
          event({
            id: "e2",
            title: "Canceled",
            canceledAt: "2026-10-01T00:00:00Z",
            cancelReason: "Rain.",
            agenda: null,
          }),
          event({
            id: "e3",
            title: "Done",
            startsAt: "2026-10-01T09:00:00Z",
            endsAt: "2026-10-01T10:00:00Z",
          }),
          event({
            id: "e4",
            title: "Attended",
            checkIns: [
              { membershipId: "m-me", name: "Me", method: "Self", at: "2026-10-02T09:05:00Z" },
            ],
          }),
        ]}
        onRsvp={onRsvp}
        onCheckIn={onCheckIn}
      />,
    );
    expect(screen.getByText("Rain.")).toBeTruthy();
    expect(screen.getByText("phases.canceled")).toBeTruthy();
    expect(screen.getByText("checkedIn")).toBeTruthy();
    await act(async () => {
      fireEvent.click(at(screen.getAllByRole("button", { name: "responses.Going" }), 0));
    });
    expect(onRsvp).toHaveBeenCalledWith("e1", "Going");
    await press("checkIn");
    expect(onCheckIn).toHaveBeenCalledWith("e1");
    await expectAccessible(container);
  });

  it("shows the empty state", () => {
    const onEmptyAction = vi.fn();
    render(
      <EventsScreen
        status="ready"
        labels={labels<EventsScreenLabels>()}
        events={[]}
        myMembershipIds={[]}
        onRsvp={ok}
        onCheckIn={ok}
        onEmptyAction={onEmptyAction}
      />,
    );
    fireEvent.click(button("emptyAction"));
    expect(onEmptyAction).toHaveBeenCalled();
  });
});

const template = (over: Partial<FormTemplate> = {}): FormTemplate => ({
  id: "t1",
  name: "Rigging Pre-Use Check",
  description: "Before every lift.",
  recordKind: "Inspection",
  recordSubtype: "Safety",
  requiresSignature: true,
  requiresLocation: true,
  passScore: 2,
  approverRoleId: null,
  state: "Published",
  version: 1,
  updatedAt: "2026-10-01T00:00:00Z",
  fields: [
    {
      key: "hoist_ok",
      label: "Hoist inspected",
      kind: "yes_no",
      required: true,
      points: { true: 2 },
    },
    {
      key: "defect",
      label: "Defect",
      kind: "long_text",
      required: true,
      show_if: { key: "hoist_ok", equals: false },
    },
    { key: "load", label: "Load class", kind: "choice", choices: ["Light", "Heavy"] },
    { key: "tags", label: "Tags", kind: "multi_choice", choices: ["Wet", "Windy"] },
    { key: "weight", label: "Weight", kind: "number" },
    { key: "when", label: "Inspected on", kind: "date" },
    { key: "photos", label: "Photos", kind: "photo", required: true },
  ],
  ...over,
});

const formLabels = labels<FormFillScreenLabels>(["missing", "score", "photos", "requiredField"]);

describe("FormFillScreen", () => {
  it("fills conditional fields, photos and the signature, then submits shown answers", async () => {
    const onSubmit = vi.fn(ok);
    const onCapturePhoto = vi
      .fn<(key: string) => Promise<string | null>>()
      .mockResolvedValueOnce("o/forms/p/1.jpg")
      .mockResolvedValueOnce(null);
    const { container } = render(
      <FormFillScreen
        status="ready"
        labels={formLabels}
        template={template()}
        onCapturePhoto={onCapturePhoto}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText("Before every lift.")).toBeTruthy();
    // A yes/no question shows its text, not only Yes and No (simulator defect).
    expect(screen.getByText('requiredField("Hoist inspected")')).toBeTruthy();
    expect(screen.getByText("location")).toBeTruthy();
    await press("submit");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("missing(2)")).toBeTruthy();
    expect(screen.getByText("signatureMissing")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "no" }));
    expect(screen.getByLabelText('requiredField("Defect")')).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "yes" }));
    expect(screen.queryByLabelText('requiredField("Defect")')).toBeNull();
    expect(screen.getByText("score(2,2,2)")).toBeTruthy();

    fireEvent.click(button("Heavy"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wet" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Windy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wet" }));
    const weight = screen.getByLabelText("Weight");
    fireEvent.change(weight, { target: { value: "abc" } });
    expect(screen.getByText("numberError")).toBeTruthy();
    fireEvent.change(weight, { target: { value: "" } });
    fireEvent.change(weight, { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Inspected on"), { target: { value: "2026-10-02" } });
    expect(screen.getByText("dateHelp")).toBeTruthy();
    await press("addPhoto");
    await press("addPhoto");
    expect(screen.getByText("photos(1)")).toBeTruthy();
    await expectAccessible(container);

    await press("submit");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits without a signature when none is required and reports refusals", async () => {
    const onSubmit = vi
      .fn()
      .mockImplementationOnce(refused("This form is retired."))
      .mockImplementationOnce(ok);
    render(
      <FormFillScreen
        status="ready"
        labels={formLabels}
        template={template({
          requiresSignature: false,
          requiresLocation: false,
          description: null,
          fields: [{ key: "note", label: "Note", kind: "text", required: true }],
        })}
        onCapturePhoto={() => Promise.resolve(null)}
        onSubmit={onSubmit}
      />,
    );
    const note = screen.getByLabelText('requiredField("Note")');
    fireEvent.change(note, { target: { value: "All clear" } });
    await press("submit");
    expect(screen.getByRole("alert").textContent).toContain("This form is retired.");
    await press("submit");
    expect(onSubmit).toHaveBeenLastCalledWith({ note: "All clear" }, null);
    expect(screen.getByText("submitted")).toBeTruthy();
    fireEvent.change(note, { target: { value: "x" } });
    fireEvent.change(note, { target: { value: "" } });
    expect(screen.queryByText("submitted")).toBeNull();
  });

  it("treats a missing template as an error", () => {
    render(
      <FormFillScreen
        status="ready"
        labels={formLabels}
        template={null}
        onCapturePhoto={() => Promise.resolve(null)}
        onSubmit={ok}
      />,
    );
    expect(screen.getByText("errorTitle")).toBeTruthy();
  });
});

const course: TrainingCourse = {
  id: "c1",
  title: "Rigging Basics",
  summary: "Slings and shackles.",
  roleCode: null,
  certificationId: null,
  gateCriterionId: null,
  validityDays: 365,
  passPercent: 50,
  estimatedMinutes: 15,
  state: "Published",
  lessons: [
    {
      id: "l1",
      position: 1,
      title: "Inspect",
      kind: "Reading",
      body: "Check slings.",
      videoUrl: null,
      questions: [],
    },
    {
      id: "l2",
      position: 2,
      title: "Watch",
      kind: "Video",
      body: null,
      videoUrl: "https://v.example/1",
      questions: [],
    },
    {
      id: "l3",
      position: 3,
      title: "Quiz",
      kind: "Quiz",
      body: null,
      videoUrl: null,
      questions: [
        { id: "q1", position: 1, prompt: "Before a lift?", options: ["Inspect", "Skip"] },
      ],
    },
  ],
};

describe("TrainingScreen", () => {
  it("opens a course, completes lessons, watches video and submits the quiz", async () => {
    const onCompleteLesson = vi.fn(ok);
    const onCompleteCourse = vi.fn(ok);
    const onOpenVideo = vi.fn();
    const tl = labels<TrainingScreenLabels>(["progress", "courseMeta", "passMark"]);
    const mine: MyCourse = {
      course,
      dueOn: "2026-10-09",
      completedLessonIds: ["l2"],
      result: null,
    };
    const { container, rerender } = render(
      <TrainingScreen
        status="ready"
        labels={tl}
        courses={[mine]}
        onCompleteLesson={onCompleteLesson}
        onCompleteCourse={onCompleteCourse}
        onOpenVideo={onOpenVideo}
      />,
    );
    expect(screen.getByText('courseMeta("2026-10-09",15)')).toBeTruthy();
    fireEvent.click(screen.getByText("Rigging Basics"));
    expect(screen.getByText("Slings and shackles.")).toBeTruthy();
    expect(screen.getByText("lessonDone")).toBeTruthy();
    expect(screen.getByText("answerAll")).toBeTruthy();
    await press("markComplete");
    expect(onCompleteLesson).toHaveBeenCalledWith("l1");
    fireEvent.click(button("watchVideo"));
    expect(onOpenVideo).toHaveBeenCalledWith("https://v.example/1");
    fireEvent.click(button("Inspect"));
    await press("submitQuiz");
    expect(onCompleteCourse).toHaveBeenCalledWith("c1", { q1: 1 });
    await expectAccessible(container);

    rerender(
      <TrainingScreen
        status="ready"
        labels={tl}
        courses={[{ ...mine, result: "failed" }]}
        onCompleteLesson={onCompleteLesson}
        onCompleteCourse={onCompleteCourse}
        onOpenVideo={onOpenVideo}
      />,
    );
    expect(button("retake")).toBeTruthy();
    rerender(
      <TrainingScreen
        status="ready"
        labels={tl}
        courses={[{ ...mine, result: "passed" }]}
        onCompleteLesson={onCompleteLesson}
        onCompleteCourse={onCompleteCourse}
        onOpenVideo={onOpenVideo}
      />,
    );
    expect(screen.getByText("passed")).toBeTruthy();
    fireEvent.click(button("back"));
    expect(screen.getByText("passed")).toBeTruthy();
  });

  it("shows the empty list and an empty course", () => {
    const tl = labels<TrainingScreenLabels>(["progress", "courseMeta", "passMark"], [], {
      courseMeta: () => "",
    });
    const { rerender } = render(
      <TrainingScreen
        status="ready"
        labels={tl}
        courses={[]}
        onCompleteLesson={ok}
        onCompleteCourse={ok}
        onOpenVideo={() => undefined}
      />,
    );
    expect(screen.getByText("empty")).toBeTruthy();
    rerender(
      <TrainingScreen
        status="ready"
        labels={tl}
        courses={[
          {
            course: { ...course, summary: null, lessons: [], estimatedMinutes: null },
            dueOn: null,
            completedLessonIds: [],
            result: null,
          },
        ]}
        onCompleteLesson={ok}
        onCompleteCourse={ok}
        onOpenVideo={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Rigging Basics"));
    expect(screen.getByLabelText("progress(0,0)")).toBeTruthy();
  });
});

const article = (over: Partial<HandbookArticle> = {}): HandbookArticle => ({
  id: "a1",
  sectionId: "s1",
  title: "Hearing Protection",
  body: "draft",
  mandatory: true,
  state: "Published",
  version: 2,
  publishedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  published: {
    title: "Hearing Protection on Site",
    body: "Wear plugs near the stacks.\n\nFoam plugs are at every gate.",
    changeSummary: "Added gate supply.",
  },
  acknowledgedByMe: false,
  ...over,
});

describe("HandbookScreen", () => {
  it("lists mandatory reads, opens an article and acknowledges it", async () => {
    const onAcknowledge = vi.fn(ok);
    const onSearch = vi.fn();
    const hl = labels<HandbookScreenLabels>(["changes"]);
    const { container } = render(
      <HandbookScreen
        status="ready"
        labels={hl}
        articles={[
          article(),
          article({
            id: "a2",
            mandatory: false,
            published: { title: "Parking", body: "Lot B.", changeSummary: null },
          }),
          article({ id: "a3", published: null }),
          article({
            id: "a4",
            acknowledgedByMe: true,
            published: { title: "Radios", body: "Channel 4.", changeSummary: null },
          }),
        ]}
        search=""
        onSearch={onSearch}
        onAcknowledge={onAcknowledge}
      />,
    );
    expect(screen.getByText("mustRead")).toBeTruthy();
    expect(screen.getAllByText("Hearing Protection on Site")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "plug" } });
    expect(onSearch).toHaveBeenCalledWith("plug");
    await expectAccessible(container);
    fireEvent.click(at(screen.getAllByText("Hearing Protection on Site"), 0));
    expect(screen.getByText("Foam plugs are at every gate.")).toBeTruthy();
    expect(screen.getByText('changes("Added gate supply.")')).toBeTruthy();
    await press("acknowledge");
    expect(onAcknowledge).toHaveBeenCalledWith("a1");
    fireEvent.click(button("back"));
    fireEvent.click(screen.getByText("Radios"));
    expect(screen.getByText("acknowledged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "acknowledge" })).toBeNull();
  });

  it("offers to clear the search when nothing matches", () => {
    const onSearch = vi.fn();
    render(
      <HandbookScreen
        status="ready"
        labels={labels<HandbookScreenLabels>(["changes"])}
        articles={[]}
        search="zzz"
        onSearch={onSearch}
        onAcknowledge={ok}
      />,
    );
    fireEvent.click(button("clearSearch"));
    expect(onSearch).toHaveBeenCalledWith("");
  });
});

const request = (over: Partial<HelpDeskRequest> = {}): HelpDeskRequest => ({
  id: "r1",
  number: "SUP-0001",
  teamId: "t1",
  category: "Access",
  severity: "Severity 3",
  subject: "Dock tablet will not sign in",
  body: "Blank screen.",
  state: "Open",
  requesterMembershipId: "m-me",
  requesterName: "Me",
  assigneeMembershipId: null,
  assigneeName: null,
  responseDueAt: "2026-10-02T08:00:00Z",
  firstRespondedAt: null,
  createdAt: "2026-10-02T04:00:00Z",
  ...over,
});

describe("HelpDeskScreen", () => {
  it("lists requests with overdue marks and asks a team", async () => {
    const onAsk = vi.fn(ok);
    const onOpenRequest = vi.fn();
    const hl = labels<HelpDeskScreenLabels>(["meta"], ["states", "categories"]);
    const teams = [
      { id: "t1", name: "Site IT Desk" },
      { id: "t2", name: "HR" },
    ];
    const { container } = render(
      <HelpDeskScreen
        status="ready"
        labels={hl}
        now={NOW}
        requests={[
          request(),
          request({ id: "r2", state: "Resolved", firstRespondedAt: "2026-10-02T05:00:00Z" }),
        ]}
        teams={teams}
        onOpenRequest={onOpenRequest}
        onAsk={onAsk}
      />,
    );
    expect(screen.getAllByText("overdue")).toHaveLength(1);
    fireEvent.click(at(screen.getAllByText("Dock tablet will not sign in"), 1));
    expect(onOpenRequest).toHaveBeenCalledWith("r2");
    fireEvent.click(button("ask"));
    fireEvent.click(screen.getByRole("radio", { name: "HR" }));
    fireEvent.click(screen.getByRole("radio", { name: "categories.Problem" }));
    fireEvent.change(screen.getByLabelText("subject"), { target: { value: "Badge" } });
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "Lost my badge." } });
    await expectAccessible(container);
    await press("send");
    expect(onAsk).toHaveBeenCalledWith("t2", "Problem", "Badge", "Lost my badge.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides asking when no team is set up", () => {
    render(
      <HelpDeskScreen
        status="ready"
        labels={labels<HelpDeskScreenLabels>(["meta"], ["states", "categories"])}
        requests={[]}
        teams={[]}
        onOpenRequest={() => undefined}
        onAsk={ok}
      />,
    );
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "ask" })).toHaveLength(1);
  });
});
