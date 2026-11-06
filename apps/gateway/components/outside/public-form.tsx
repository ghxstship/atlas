"use client";

import { planFormWindows, unansweredFields, type PublicFormField } from "@xos/data/form-links";
import { Button, InlineAlert, Input, MultiSelect, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import { submitPublicFormAction } from "@/lib/actions/public-form";

type Translate = (key: string, values?: Record<string, string | number>) => string;

type Answers = Readonly<Record<string, unknown>>;

function FieldInput({
  field,
  value,
  missing,
  onChange,
}: {
  field: PublicFormField;
  value: unknown;
  /** A required field the respondent tried to leave empty. Native validation cannot see a Select or MultiSelect. */
  missing: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("gateway.publicForm") as unknown as Translate;
  const id = `field-${field.key}`;
  const common = { id, label: field.label };
  const error = missing ? { error: t("required") } : {};
  switch (field.kind) {
    case "long_text":
      return (
        <Textarea
          {...common}
          required={field.required}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          maxLength={10000}
        />
      );
    case "number":
      return (
        <Input
          {...common}
          type="number"
          step="any"
          required={field.required}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <Input
          {...common}
          type="date"
          required={field.required}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "yes_no":
      return (
        <Select
          {...common}
          value={value === true ? "yes" : value === false ? "no" : ""}
          placeholder={t("choose")}
          {...error}
          options={[
            { value: "yes", label: t("yes") },
            { value: "no", label: t("no") },
          ]}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}
        />
      );
    case "choice":
      return (
        <Select
          {...common}
          key={`${field.key}-${String(value ?? "")}`}
          value={typeof value === "string" ? value : ""}
          placeholder={t("choose")}
          {...error}
          options={(field.choices ?? []).map((c) => ({ value: c, label: c }))}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "multi_choice":
      // One control however many choices it has (gate 27 counts a checkbox per choice), with a search for long lists.
      return (
        <MultiSelect
          {...common}
          value={Array.isArray(value) ? (value as string[]) : []}
          placeholder={t("choose")}
          options={(field.choices ?? []).map((c) => ({ value: c, label: c }))}
          onChange={(picked) => onChange(picked)}
        />
      );
    default:
      return (
        <Input
          {...common}
          required={field.required}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          maxLength={500}
          width="100%"
        />
      );
  }
}

/**
 * The public form in windows (B2, ADR 0141): the first holds name, email and up to 5 fields, each later window up to 7,
 * with Next and Back, so gate 27's seven-field limit holds for a form of any length. Answers stay in client state across
 * windows, and the windows are worked out from the fields currently shown. Only the last window has the primary Submit.
 * Required answers are checked before each move, since native validation cannot see a Select or MultiSelect and the
 * server would otherwise refuse only at the end, spending one of the address's submits and naming no field.
 * The honeypot sits in a wrapper with the hidden attribute: gate 27 counts any element with a width, and the design
 * audit forbids off-screen offsets. The minimum fill time and the rate limits are the main protection.
 */
export function PublicFormFill({
  token,
  fields,
}: {
  token: string;
  fields: readonly PublicFormField[];
}) {
  const t = useTranslations("gateway.publicForm") as unknown as Translate;
  const tokens = useTranslations("gateway.tokens.refusals") as unknown as Translate;
  const [answers, setAnswers] = useState<Answers>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [pending, start] = useTransition();
  const windows = useMemo(() => planFormWindows(fields, answers), [fields, answers]);
  const current = Math.min(index, windows.length - 1);
  const last = current === windows.length - 1;
  const unanswered = checked ? unansweredFields(windows[current] ?? [], answers) : [];

  const submit = () =>
    start(async () => {
      setRefusal(null);
      const shownAnswers = Object.fromEntries(
        windows.flat().flatMap((f) => {
          const value = answers[f.key];
          return value === undefined || value === null ? [] : [[f.key, value]];
        }),
      );
      const result = await submitPublicFormAction(token, {
        name,
        email,
        answers: shownAnswers,
        website,
      });
      if (result.ok) setDone(true);
      else setRefusal(result.reason);
    });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    // A later answer can bring a required field into an earlier window, so the last window checks them all.
    const scope = last ? windows : [windows[current] ?? []];
    const blocked = scope.findIndex((w) => unansweredFields(w, answers).length > 0);
    if (blocked >= 0) {
      setChecked(true);
      if (last) setIndex(blocked);
      return;
    }
    setChecked(false);
    if (last) submit();
    else setIndex(current + 1);
  };

  if (done) {
    return (
      <p role="status" className="m-0 text-text-14 text-success-text" data-public-form-done="">
        {t("thanks")}
      </p>
    );
  }
  return (
    <form
      action={() => undefined}
      onSubmit={onSubmit}
      className="flex flex-col gap-12"
      data-public-form-window={current}
    >
      {refusal ? (
        <InlineAlert tone="danger">
          {refusal === "unexpected" ? t("unexpected") : tokens(refusal)}
        </InlineAlert>
      ) : null}
      {unanswered.length > 0 ? (
        <InlineAlert tone="danger">
          {t("unanswered", { fields: unanswered.map((f) => f.label).join(", ") })}
        </InlineAlert>
      ) : null}
      {windows.length > 1 ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("window", { current: current + 1, total: windows.length })}
        </p>
      ) : null}
      {current === 0 ? (
        <>
          <Input
            id="respondent-name"
            label={t("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            autoComplete="name"
            width="100%"
          />
          <Input
            id="respondent-email"
            type="email"
            label={t("email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={320}
            required
            autoComplete="email"
            width="100%"
          />
          <div hidden>
            <label>
              {t("website")}
              <input
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </label>
          </div>
        </>
      ) : null}
      {(windows[current] ?? []).map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={answers[field.key]}
          missing={unanswered.includes(field)}
          onChange={(value) => setAnswers((all) => ({ ...all, [field.key]: value }))}
        />
      ))}
      <div className="flex flex-wrap gap-8">
        {current > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setIndex(current - 1)}>
            {t("back")}
          </Button>
        ) : null}
        {last ? (
          <Button type="submit" variant="primary" loading={pending}>
            {t("submit")}
          </Button>
        ) : (
          <Button type="submit" variant="secondary">
            {t("next")}
          </Button>
        )}
      </div>
    </form>
  );
}
