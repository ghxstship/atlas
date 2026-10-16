import { useState, type ReactElement } from "react";
import { Button, Card, InlineAlert, ListRow, ProgressBar, Tag, Text } from "@xos/ui-native";
import type { TrainingCourse, TrainingLesson } from "@xos/data/workforce-training";
import {
  Empty,
  Section,
  Stack,
  WorkforceFrame,
  defined,
  titled,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

/** One assigned course with the viewer's progress. */
export interface MyCourse {
  readonly course: TrainingCourse;
  readonly dueOn: string | null;
  readonly completedLessonIds: readonly string[];
  /** The viewer's latest result: passed, failed or not yet taken. */
  readonly result: "passed" | "failed" | null;
}

export interface TrainingScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly emptyAction: string;
  readonly failed: string;
  readonly back: string;
  readonly lessons: string;
  readonly markComplete: string;
  readonly lessonDone: string;
  readonly watchVideo: string;
  readonly submitQuiz: string;
  readonly answerAll: string;
  readonly passed: string;
  readonly retake: string;
  readonly progress: (done: number, total: number) => string;
  /** The course row's subtitle: due date and length, either of which may be unknown. */
  readonly courseMeta: (dueOn: string | null, minutes: number | null) => string;
  readonly passMark: (percent: number) => string;
}

export interface TrainingScreenProps {
  readonly status: ScreenStatus;
  readonly labels: TrainingScreenLabels;
  readonly courses: readonly MyCourse[];
  readonly onCompleteLesson: Action<[lessonId: string]>;
  /** Submits the quiz: option numbers from 1, keyed by question id. */
  readonly onCompleteCourse: Action<[courseId: string, answers: Readonly<Record<string, number>>]>;
  readonly onOpenVideo: (url: string) => void;
  readonly onEmptyAction?: () => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

function LessonCard({
  lesson,
  done,
  labels,
  busy,
  answers,
  onAnswer,
  onComplete,
  onOpenVideo,
}: {
  lesson: TrainingLesson;
  done: boolean;
  labels: TrainingScreenLabels;
  busy: boolean;
  answers: Readonly<Record<string, number>>;
  onAnswer: (questionId: string, option: number) => void;
  onComplete: () => void;
  onOpenVideo: (url: string) => void;
}): ReactElement {
  return (
    <Card title={lesson.title}>
      <Stack>
        {lesson.body !== null ? <Text>{lesson.body}</Text> : null}
        {lesson.kind === "Video" && lesson.videoUrl !== null ? (
          <Button
            label={labels.watchVideo}
            icon="play"
            onPress={() => onOpenVideo(lesson.videoUrl ?? "")}
          />
        ) : null}
        {lesson.kind === "Quiz" ? (
          lesson.questions.map((q) => (
            <Stack key={q.id}>
              <Text variant="label13">{q.prompt}</Text>
              {q.options.map((o, i) => (
                <Button
                  key={o}
                  label={o}
                  block
                  variant={answers[q.id] === i + 1 ? "primary" : "secondary"}
                  onPress={() => onAnswer(q.id, i + 1)}
                />
              ))}
            </Stack>
          ))
        ) : done ? (
          <Tag tone="success" label={labels.lessonDone} />
        ) : (
          <Button
            label={labels.markComplete}
            variant="primary"
            icon="check"
            loading={busy}
            onPress={onComplete}
          />
        )}
      </Stack>
    </Card>
  );
}

/** Compass Training: assigned courses, lessons, the quiz and the result. */
export function TrainingScreen({
  status,
  labels,
  courses,
  onCompleteLesson,
  onCompleteCourse,
  onOpenVideo,
  onEmptyAction,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: TrainingScreenProps): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const { busy, run, alert } = useActionRunner(labels.failed);
  const open = courses.find((c) => c.course.id === openId) ?? null;

  if (open !== null) {
    const { course } = open;
    const questions = course.lessons.flatMap((l) => (l.kind === "Quiz" ? l.questions : []));
    const unanswered = questions.filter((q) => answers[q.id] === undefined).length;
    const total = course.lessons.length;
    const done = course.lessons.filter((l) => open.completedLessonIds.includes(l.id)).length;
    return (
      <WorkforceFrame
        status={status}
        labels={titled(labels, course.title)}
        testID="workforce-training-course"
        footer={
          <Stack>
            {alert}
            {open.result === "passed" ? (
              <InlineAlert tone="success" message={labels.passed} />
            ) : (
              <Button
                label={open.result === "failed" ? labels.retake : labels.submitQuiz}
                variant="primary"
                block
                disabled={unanswered > 0}
                loading={busy === "quiz"}
                onPress={() => void run("quiz", () => onCompleteCourse(course.id, answers))}
              />
            )}
            {unanswered > 0 && open.result !== "passed" ? (
              <Text variant="text13" tone="secondary">
                {labels.answerAll}
              </Text>
            ) : null}
            <Button
              label={labels.back}
              variant="ghost"
              icon="arrow-left"
              onPress={() => setOpenId(null)}
            />
          </Stack>
        }
        {...defined({ refreshing, onRefresh, onRetry, errorReference })}
      >
        {course.summary !== null ? <Text tone="secondary">{course.summary}</Text> : null}
        <ProgressBar
          label={labels.progress(done, total)}
          value={total === 0 ? 0 : (100 * done) / total}
        />
        <Text variant="text13" tone="secondary">
          {labels.passMark(course.passPercent)}
        </Text>
        <Section title={labels.lessons}>
          {course.lessons.map((l) => (
            <LessonCard
              key={l.id}
              lesson={l}
              done={open.completedLessonIds.includes(l.id)}
              labels={labels}
              busy={busy === `lesson:${l.id}`}
              answers={answers}
              onAnswer={(q, o) => setAnswers((prev) => ({ ...prev, [q]: o }))}
              onComplete={() => void run(`lesson:${l.id}`, () => onCompleteLesson(l.id))}
              onOpenVideo={onOpenVideo}
            />
          ))}
        </Section>
      </WorkforceFrame>
    );
  }

  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-training"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {courses.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.emptyAction} onAction={onEmptyAction} />
      ) : (
        courses.map((c) => {
          const meta = labels.courseMeta(c.dueOn, c.course.estimatedMinutes);
          return (
            <ListRow
              key={c.course.id}
              title={c.course.title}
              icon="graduation-cap"
              onPress={() => {
                setAnswers({});
                setOpenId(c.course.id);
              }}
              {...(meta === "" ? {} : { subtitle: meta })}
              trailing={
                c.result === "passed" ? <Tag tone="success" label={labels.passed} /> : undefined
              }
            />
          );
        })
      )}
    </WorkforceFrame>
  );
}
