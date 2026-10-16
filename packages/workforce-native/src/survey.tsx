import { useState, type ReactElement } from "react";
import { Button, InlineAlert, SegmentedControl, Text, TextField } from "@xos/ui-native";
import type { Survey } from "@xos/data/workforce-feed";
import {
  Stack,
  WorkforceFrame,
  defined,
  titled,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface SurveyScreenLabels extends FrameLabels {
  readonly submit: string;
  readonly submitted: string;
  readonly failed: string;
  readonly closed: string;
  readonly anonymous: string;
  /** An optional question's prompt, marked as optional. */
  readonly optionalQuestion: (prompt: string) => string;
  readonly answerRequired: (count: number) => string;
}

export interface SurveyScreenProps {
  readonly status: ScreenStatus;
  readonly labels: SurveyScreenLabels;
  readonly survey: Survey | null;
  /** Answers keyed by question id: a scale number, a choice or text. */
  readonly onRespond: Action<
    [surveyId: string, answers: Readonly<Record<string, string | number>>]
  >;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass pulse survey: scale, choice and text questions, anonymous when the survey says so. */
export function SurveyScreen({
  status,
  labels,
  survey,
  onRespond,
  onRetry,
  errorReference,
}: SurveyScreenProps): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [sent, setSent] = useState(false);
  const { busy, run, alert } = useActionRunner(labels.failed);
  const questions = survey?.questions ?? [];
  const missing = questions.filter(
    (q) => q.required && (answers[q.id] === undefined || answers[q.id] === ""),
  ).length;
  const done = sent || survey?.respondedByMe === true;
  const open = survey?.state === "Open";
  const set = (id: string, value: string | number) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  return (
    <WorkforceFrame
      status={status === "ready" && survey === null ? "error" : status}
      labels={titled(labels, survey?.title ?? labels.title)}
      testID="workforce-survey"
      footer={
        open && !done ? (
          <Stack>
            {alert}
            {missing > 0 ? (
              <Text variant="text13" tone="secondary">
                {labels.answerRequired(missing)}
              </Text>
            ) : null}
            <Button
              label={labels.submit}
              variant="primary"
              block
              disabled={missing > 0}
              loading={busy === "respond"}
              onPress={() =>
                void run("respond", () => onRespond(survey?.id ?? "", answers)).then((ok) => {
                  if (ok) setSent(true);
                })
              }
            />
          </Stack>
        ) : undefined
      }
      {...defined({ onRetry, errorReference })}
    >
      {survey?.description ? <Text tone="secondary">{survey.description}</Text> : null}
      {survey?.anonymous ? <InlineAlert tone="info" message={labels.anonymous} /> : null}
      {done ? <InlineAlert tone="success" message={labels.submitted} /> : null}
      {!open && !done ? <InlineAlert tone="warning" message={labels.closed} /> : null}
      {open && !done
        ? questions.map((q) => {
            const label = q.required ? q.prompt : labels.optionalQuestion(q.prompt);
            if (q.kind === "Text")
              return (
                <TextField
                  key={q.id}
                  label={label}
                  multiline
                  value={typeof answers[q.id] === "string" ? String(answers[q.id]) : ""}
                  onChangeText={(t) => set(q.id, t)}
                />
              );
            const options =
              q.kind === "Scale"
                ? Array.from({ length: q.scaleMax ?? 5 }, (_, i) => String(i + 1))
                : q.choices;
            return (
              <SegmentedControl
                key={q.id}
                label={label}
                value={answers[q.id] === undefined ? "" : String(answers[q.id])}
                options={options.map((o) => ({ value: o, label: o }))}
                onChange={(v) => set(q.id, q.kind === "Scale" ? Number(v) : v)}
              />
            );
          })
        : null}
    </WorkforceFrame>
  );
}
