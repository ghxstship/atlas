import {
  lessonProgress,
  listMyLessonProgress,
  listTrainingAssignments,
  listTrainingCompletions,
  listTrainingCourses,
  trainingStanding,
  type TrainingCourse,
} from "@xos/data/workforce-training";
import { getFormatter } from "next-intl/server";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  addLessonAction,
  addQuizQuestionAction,
  assignCourseAction,
  completeCourseAction,
  completeLessonAction,
  createCourseAction,
  issueCertificationAction,
  publishCourseAction,
  retireCourseAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { REFUSALS, memberOptions, orgPickers, workforceCopy } from "./shared";
import * as enums from "@xos/data/enums";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["list", "table", "gallery"];

function courseState(c: TrainingCourse, t: Copy): KitState {
  return c.state === "Draft"
    ? { state: "proposed", label: t("training.states.Draft") }
    : c.state === "Published"
      ? { state: "active", label: t("training.states.Published") }
      : { state: "canceled", label: t("training.states.Retired") };
}

/**
 * Knowledge > Training (Section 4.9 Training): short courses of readings, videos and quizzes. Course
 * editors build, publish and assign them; learners finish the lessons and submit the quiz, which the
 * database grades without ever showing the answer key. A pass carries a certificate number and expiry,
 * and a verifier turns it into the certification it grants.
 */
export async function TrainingSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, courses, progress, completions, assignments] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listTrainingCourses(db, ctx.org.id),
    listMyLessonProgress(db, [ctx.org.membershipId]),
    listTrainingCompletions(db, ctx.org.id),
    listTrainingAssignments(db, ctx.org.id),
  ]);
  const title = t("training.title");
  if (!courses.ok || !progress.ok || !completions.ok || !assignments.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("training.what")} />
      </CollectionPage>
    );
  }
  const canEdit = ctx.capabilities.has("knowledge.sop.publish");
  const canVerify = ctx.capabilities.has("people.certification.verify");
  const finished = new Set(progress.data);
  const date = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const mineFor = (courseId: string) =>
    completions.data.filter(
      (c) => c.courseId === courseId && c.membershipId === ctx.org.membershipId,
    );
  const myAssignment = (courseId: string) =>
    assignments.data.find(
      (a) => a.courseId === courseId && a.membershipId === ctx.org.membershipId,
    );
  const selected = state.peek ? courses.data.find((c) => c.id === state.peek) : undefined;
  const standing = (c: TrainingCourse) => t(`training.standing.${trainingStanding(mineFor(c.id))}`);

  if (selected && state.full) {
    const pickers = canEdit ? await orgPickers(ctx) : null;
    const quizQuestions = selected.lessons.flatMap((l) => (l.kind === "Quiz" ? l.questions : []));
    const readingsDone = lessonProgress(selected, finished) === 100;
    const courseCompletions = completions.data.filter((c) => c.courseId === selected.id);
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("training.back")}
        recordKey={selected.roleCode ?? t("training.course")}
        title={selected.title}
        state={courseState(selected, t)}
        properties={[
          { label: t("training.passPercent"), value: `${selected.passPercent}%` },
          {
            label: t("training.validity"),
            value: selected.validityDays
              ? t("training.days", { days: selected.validityDays })
              : t("training.noExpiry"),
          },
          { label: t("training.progress"), value: `${lessonProgress(selected, finished)}%` },
          { label: t("training.mine"), value: standing(selected) },
        ]}
        actions={courseActions(ctx, t, selected, canEdit)}
      >
        {selected.summary ? <p className="m-0 text-text-14">{selected.summary}</p> : null}
        {selected.lessons.map((l) => (
          <KitSection key={l.id} id={`lesson-${l.id}`} title={`${l.position}. ${l.title}`}>
            {l.kind === "Video" && l.videoUrl ? (
              <p className="m-0 text-text-14">
                <a
                  href={l.videoUrl}
                  className="text-text-link underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("training.watch")}
                </a>
              </p>
            ) : null}
            {l.body ? <p className="m-0 whitespace-pre-wrap text-text-14">{l.body}</p> : null}
            {l.kind !== "Quiz" && selected.state === "Published" ? (
              finished.has(l.id) ? (
                <p className="m-0 text-text-12 text-text-secondary">{t("training.lessonDone")}</p>
              ) : (
                <ActionButton
                  action={completeLessonAction}
                  hidden={{ org: ctx.org.slug, id: l.id }}
                  label={t("training.markDone")}
                  refusals={REFUSALS}
                />
              )
            ) : null}
            {l.kind === "Quiz" ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("training.quizCount", { count: l.questions.length })}
              </p>
            ) : null}
            {canEdit && selected.state === "Draft" && l.kind === "Quiz" ? (
              <EntityForm
                id={`question-${l.id}`}
                action={addQuizQuestionAction}
                hidden={{ org: ctx.org.slug, id: l.id }}
                refusals={REFUSALS}
                submitLabel={t("training.addQuestion")}
                fields={[
                  { kind: "text", name: "prompt", label: t("training.prompt"), required: true },
                  {
                    kind: "textarea",
                    name: "options",
                    label: t("training.options"),
                    required: true,
                    rows: 4,
                    help: t("training.optionsHelp"),
                  },
                  {
                    kind: "number",
                    name: "correct",
                    label: t("training.correct"),
                    required: true,
                    help: t("training.correctHelp"),
                  },
                  {
                    kind: "number",
                    name: "position",
                    label: t("training.position"),
                    defaultValue: String(l.questions.length + 1),
                  },
                ]}
              />
            ) : null}
          </KitSection>
        ))}
        {selected.state === "Published" && quizQuestions.length > 0 ? (
          <KitSection id="course-quiz" title={t("training.quiz")}>
            {!readingsDone ? <p className="m-0 text-text-13">{t("training.finishFirst")}</p> : null}
            <EntityForm
              id={`quiz-${selected.id}`}
              action={completeCourseAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("training.submitQuiz")}
              fields={quizQuestions.map((q) => ({
                kind: "select" as const,
                name: `q:${q.id}`,
                label: q.prompt,
                required: true,
                blankLabel: t("feed.pickOne"),
                options: q.options.map((o, i) => ({ value: String(i + 1), label: o })),
              }))}
            />
          </KitSection>
        ) : selected.state === "Published" ? (
          <ActionButton
            action={completeCourseAction}
            hidden={{ org: ctx.org.slug, id: selected.id }}
            label={t("training.complete")}
            variant="primary"
            refusals={REFUSALS}
          />
        ) : null}
        {mineFor(selected.id).length > 0 ? (
          <KitSection id="course-mine" title={t("training.myAttempts")}>
            <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
              {mineFor(selected.id).map((c) => (
                <li key={c.id}>
                  {c.passed
                    ? t("training.passLine", {
                        date: date(c.completedAt),
                        score: c.scorePercent ?? 100,
                        certificate: c.certificateNumber ?? "",
                      })
                    : t("training.failLine", {
                        date: date(c.completedAt),
                        score: c.scorePercent ?? 0,
                      })}
                </li>
              ))}
            </ul>
          </KitSection>
        ) : null}
        {canEdit && selected.state === "Draft" ? (
          <KitSection id="course-lesson" title={t("training.addLesson")}>
            <EntityForm
              id={`lesson-add-${selected.id}`}
              action={addLessonAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("training.addLesson")}
              fields={[
                { kind: "text", name: "title", label: t("training.lessonTitle"), required: true },
                {
                  kind: "select",
                  name: "kind",
                  label: t("training.lessonKind"),
                  required: true,
                  defaultValue: "Reading",
                  options: enums.trainingLessonKind.map((k) => ({
                    value: k,
                    label: t(`training.kinds.${k}`),
                  })),
                },
                {
                  kind: "textarea",
                  name: "body",
                  label: t("training.body"),
                  rows: 6,
                  help: t("training.bodyHelp"),
                },
                {
                  kind: "url",
                  name: "videoUrl",
                  label: t("training.videoUrl"),
                  help: t("training.videoHelp"),
                },
                {
                  kind: "number",
                  name: "position",
                  label: t("training.position"),
                  required: true,
                  defaultValue: String(selected.lessons.length + 1),
                },
              ]}
            />
          </KitSection>
        ) : null}
        {canEdit && selected.state === "Published" && pickers ? (
          <KitSection id="course-assign" title={t("training.assign")}>
            <EntityForm
              id={`assign-${selected.id}`}
              action={assignCourseAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("training.assign")}
              fields={[
                {
                  kind: "checkboxes",
                  name: "membershipIds",
                  label: t("training.learners"),
                  options: memberOptions(pickers.members),
                },
                { kind: "date", name: "dueOn", label: t("training.dueOn") },
                { kind: "text", name: "reason", label: t("training.reason") },
              ]}
            />
          </KitSection>
        ) : null}
        {canEdit || canVerify ? (
          <KitSection id="course-records" title={t("training.records")}>
            {courseCompletions.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("training.noRecords")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
                {courseCompletions.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-8">
                    <span>
                      {t("training.recordLine", {
                        name: c.name ?? t("someone"),
                        result: c.passed ? t("training.passed") : t("training.failed"),
                        score: c.scorePercent ?? 100,
                        date: date(c.completedAt),
                      })}
                    </span>
                    {canVerify &&
                    c.passed &&
                    selected.certificationId &&
                    !c.certificationHolderId ? (
                      <ActionButton
                        action={issueCertificationAction}
                        hidden={{ org: ctx.org.slug, id: c.id }}
                        label={t("training.issue")}
                        confirm={{
                          title: t("training.issueTitle"),
                          body: t("training.issueBody", { name: c.name ?? t("someone") }),
                        }}
                        refusals={REFUSALS}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </KitSection>
        ) : null}
      </RecordPage>
    );
  }

  let drawer = null;
  if (state.create && canEdit) {
    drawer = (
      <FormDrawer title={t("training.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="course-create"
          action={createCourseAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("training.create")}
          successHref={withQuery(path, state, { peek: "{id}", full: "1" })}
          fields={[
            { kind: "text", name: "title", label: t("training.courseTitle"), required: true },
            { kind: "textarea", name: "summary", label: t("training.summary"), rows: 3 },
            {
              kind: "number",
              name: "passPercent",
              label: t("training.passPercent"),
              defaultValue: "80",
            },
            {
              kind: "number",
              name: "validityDays",
              label: t("training.validity"),
              help: t("training.validityHelp"),
            },
            {
              kind: "text",
              name: "roleCode",
              label: t("training.roleCode"),
              help: t("training.roleCodeHelp"),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    const due = myAssignment(selected.id)?.dueOn;
    drawer = (
      <PeekDrawer
        recordKey={selected.roleCode ?? t("training.course")}
        title={selected.title}
        state={courseState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={[
          { label: t("training.lessons"), value: String(selected.lessons.length) },
          { label: t("training.progress"), value: `${lessonProgress(selected, finished)}%` },
          { label: t("training.mine"), value: standing(selected) },
          { label: t("training.dueOn"), value: due ? date(due) : t("training.notAssigned") },
        ]}
        actions={
          <>
            <KitLink
              href={withQuery(path, state, { peek: selected.id, full: "1" })}
              variant="primary"
              size="sm"
            >
              {t("training.open")}
            </KitLink>
            {courseActions(ctx, t, selected, canEdit)}
          </>
        }
      >
        {selected.summary ? <p className="m-0 text-text-14">{selected.summary}</p> : null}
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = courses.data.map((c) => {
    const due = myAssignment(c.id)?.dueOn ?? null;
    return {
      id: c.id,
      key: c.roleCode ?? t("training.course"),
      title: c.title,
      state: courseState(c, t),
      meta: due ? t("training.dueLine", { date: date(due) }) : standing(c),
      cells: {
        title: c.title,
        state: courseState(c, t),
        lessons: c.lessons.length,
        progress: lessonProgress(c, finished),
        mine: standing(c),
        due: due ? date(due) : null,
      },
    };
  });
  const createHref = withQuery(path, state, { create: "1" });
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "title", label: t("training.courseTitle"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "lessons", label: t("training.lessons"), type: "number" },
        { key: "progress", label: t("training.progressPercent"), type: "number" },
        { key: "mine", label: t("training.mine") },
        { key: "due", label: t("training.dueOn") },
      ]}
      rows={rows}
      actions={
        canEdit ? (
          <KitLink href={createHref} variant="primary">
            {t("training.create")}
          </KitLink>
        ) : null
      }
      empty={
        canEdit ? (
          <EmptyStateLink
            icon="GraduationCap"
            sentence={t("training.empty")}
            actionLabel={t("training.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="GraduationCap" sentence={t("training.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}

function courseActions(ctx: OrgContext, t: Copy, c: TrainingCourse, canEdit: boolean) {
  if (!canEdit) return null;
  return c.state === "Draft" ? (
    <ActionButton
      action={publishCourseAction}
      hidden={{ org: ctx.org.slug, id: c.id }}
      label={t("training.publish")}
      confirm={{
        title: t("training.publishTitle", { title: c.title }),
        body: t("training.publishBody"),
      }}
      refusals={REFUSALS}
    />
  ) : c.state === "Published" ? (
    <ActionButton
      action={retireCourseAction}
      hidden={{ org: ctx.org.slug, id: c.id }}
      label={t("training.retire")}
      variant="danger"
      reason={t("training.retireReason")}
      refusals={REFUSALS}
    />
  ) : null;
}
