import { useState, type ReactElement } from "react";
import {
  Button,
  Card,
  Checkbox,
  InlineAlert,
  SegmentedControl,
  SignaturePad,
  Text,
  TextField,
} from "@xos/ui-native";
import {
  fieldShown,
  formScore,
  missingAnswers,
  type FormAnswer,
  type FormAnswers,
  type FormField,
  type FormTemplate,
} from "@xos/data/workforce-forms";
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

export interface FormFillScreenLabels extends FrameLabels {
  readonly submit: string;
  readonly submitted: string;
  readonly failed: string;
  readonly yes: string;
  readonly no: string;
  readonly required: string;
  /** A required field's label, marked as required. */
  readonly requiredField: (label: string) => string;
  readonly missing: (count: number) => string;
  readonly score: (score: number, max: number, pass: number | null) => string;
  readonly addPhoto: string;
  readonly photos: (count: number) => string;
  readonly dateHelp: string;
  readonly numberError: string;
  readonly signature: string;
  readonly attestation: string;
  readonly clearSignature: string;
  readonly signatureMissing: string;
  /** The GPS stamp: the place the app resolved, or a sentence saying location is still locating. */
  readonly location: string;
}

export interface FormFillScreenProps {
  readonly status: ScreenStatus;
  readonly labels: FormFillScreenLabels;
  readonly template: FormTemplate | null;
  /** Captures one photo for a field and resolves with its storage path, or null when canceled. */
  readonly onCapturePhoto: (fieldKey: string) => Promise<string | null>;
  /**
   * Submits the shown answers and the drawn signature (an SVG path, uploaded by the app), with the
   * GPS stamp the app reads when the template requires location.
   */
  readonly onSubmit: Action<[answers: FormAnswers, signature: string | null]>;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

function FieldInput({
  field,
  value,
  labels,
  onChange,
  onPhoto,
  showErrors,
}: {
  field: FormField;
  value: FormAnswer | undefined;
  labels: FormFillScreenLabels;
  onChange: (value: FormAnswer | undefined) => void;
  onPhoto: () => void;
  showErrors: boolean;
}): ReactElement {
  const label = field.required ? labels.requiredField(field.label) : field.label;
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  const error = showErrors && field.required && empty ? labels.required : undefined;
  switch (field.kind) {
    case "yes_no":
      // The control's label is only spoken; the question shows above it, as for a choice field (on the
      // simulator a form read just "Yes | No" with no question).
      return (
        <Stack>
          <Text variant="label13">{label}</Text>
          <SegmentedControl
            label={label}
            value={value === true ? "yes" : value === false ? "no" : ""}
            options={[
              { value: "yes", label: labels.yes },
              { value: "no", label: labels.no },
            ]}
            onChange={(v) => onChange(v === "yes")}
          />
        </Stack>
      );
    case "choice":
      return (
        <Stack>
          <Text variant="label13">{label}</Text>
          {(field.choices ?? []).map((c) => (
            <Button
              key={c}
              label={c}
              variant={value === c ? "primary" : "secondary"}
              block
              onPress={() => onChange(c)}
            />
          ))}
        </Stack>
      );
    case "multi_choice": {
      const chosen = Array.isArray(value) ? (value as readonly string[]) : [];
      return (
        <Stack>
          <Text variant="label13">{label}</Text>
          {(field.choices ?? []).map((c) => (
            <Checkbox
              key={c}
              label={c}
              checked={chosen.includes(c)}
              onChange={(on) => onChange(on ? [...chosen, c] : chosen.filter((x) => x !== c))}
            />
          ))}
        </Stack>
      );
    }
    case "photo": {
      const paths = Array.isArray(value) ? (value as readonly string[]) : [];
      return (
        <Stack>
          <Text variant="label13">{label}</Text>
          <Text variant="text13" tone={error ? "danger" : "secondary"}>
            {error ?? labels.photos(paths.length)}
          </Text>
          <Button label={labels.addPhoto} icon="camera" onPress={onPhoto} />
        </Stack>
      );
    }
    case "number": {
      const text =
        typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
      const bad = text !== "" && !Number.isFinite(Number(text));
      return (
        <TextField
          label={label}
          value={text}
          keyboard="numeric"
          onChangeText={(t) =>
            onChange(t === "" ? undefined : Number.isFinite(Number(t)) ? Number(t) : t)
          }
          {...defined({ error: bad ? labels.numberError : error })}
        />
      );
    }
    default:
      return (
        <TextField
          label={label}
          value={typeof value === "string" ? value : ""}
          multiline={field.kind === "long_text"}
          onChangeText={(t) => onChange(t === "" ? undefined : t)}
          {...defined({
            help: field.kind === "date" ? labels.dateHelp : undefined,
            error,
          })}
        />
      );
  }
}

/** Compass form filler: conditional fields, photos, the running score, signature and GPS stamp. */
export function FormFillScreen({
  status,
  labels,
  template,
  onCapturePhoto,
  onSubmit,
  onRetry,
  errorReference,
}: FormFillScreenProps): ReactElement {
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [signature, setSignature] = useState<string | null>(null);
  // Bumped after each submission to remount the pad: its drawing is its own state, and an old signature
  // left on screen read as signed when it no longer counted.
  const [round, setRound] = useState(0);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, run, alert } = useActionRunner(labels.failed);
  const fields = template?.fields ?? [];
  const shown = fields.filter((f) => fieldShown(f, answers));
  const missing = missingAnswers(fields, answers);
  const score = formScore(fields, answers);
  const needsSignature = template?.requiresSignature === true && signature === null;

  const set = (key: string, value: FormAnswer | undefined) => {
    setDone(false);
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined)
        return Object.fromEntries(Object.entries(next).filter(([k]) => k !== key));
      next[key] = value;
      return next;
    });
  };
  const photo = async (key: string) => {
    const path = await onCapturePhoto(key);
    if (path === null) return;
    setDone(false);
    setAnswers((prev) => {
      const had = prev[key];
      return { ...prev, [key]: [...(Array.isArray(had) ? (had as readonly string[]) : []), path] };
    });
  };
  const submit = async () => {
    setTried(true);
    if (missing.length > 0 || needsSignature) return;
    const visible = Object.fromEntries(
      Object.entries(answers).filter(([k]) => shown.some((f) => f.key === k)),
    );
    if (await run("submit", () => onSubmit(visible, signature))) {
      setAnswers({});
      setSignature(null);
      setRound((r) => r + 1);
      setTried(false);
      setDone(true);
    }
  };

  return (
    <WorkforceFrame
      status={status === "ready" && template === null ? "error" : status}
      labels={titled(labels, template?.name ?? labels.title)}
      testID="workforce-form-fill"
      footer={
        <Stack>
          {alert}
          {tried && missing.length > 0 ? (
            <Text tone="danger">{labels.missing(missing.length)}</Text>
          ) : null}
          {tried && needsSignature ? <Text tone="danger">{labels.signatureMissing}</Text> : null}
          <Button
            label={labels.submit}
            variant="primary"
            icon="send"
            block
            loading={busy === "submit"}
            onPress={() => void submit()}
          />
        </Stack>
      }
      {...defined({ onRetry, errorReference })}
    >
      {done ? <InlineAlert tone="success" message={labels.submitted} /> : null}
      {template?.description ? <Text tone="secondary">{template.description}</Text> : null}
      {shown.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          value={answers[f.key]}
          labels={labels}
          showErrors={tried}
          onChange={(v) => set(f.key, v)}
          onPhoto={() => void photo(f.key)}
        />
      ))}
      {score !== null ? (
        <Card>
          <Text variant="label13">
            {labels.score(score.score, score.max, template?.passScore ?? null)}
          </Text>
        </Card>
      ) : null}
      {template?.requiresSignature ? (
        <SignaturePad
          key={round}
          label={labels.signature}
          attestation={labels.attestation}
          clearLabel={labels.clearSignature}
          onChange={setSignature}
        />
      ) : null}
      {template?.requiresLocation ? (
        <Text variant="text13" tone="secondary">
          {labels.location}
        </Text>
      ) : null}
    </WorkforceFrame>
  );
}
