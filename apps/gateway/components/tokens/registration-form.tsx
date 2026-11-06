"use client";

import { Button, Checkbox, InlineAlert, Input, MultiSelect, Stepper, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { submitRegistrationAction, type RegistrationState } from "@/lib/actions/registration";

const INITIAL: RegistrationState = {};
/** At most seven visible fields a step; the work phone comes first and takes one on the first step. */
const PER_STEP = 7;

const SECTIONS = ["headline", "bio", "pronouns", "location", "skills", "certifications", "rates", "languages", "links"] as const;

export interface RegistrationQuestionRow {
  readonly id: string;
  readonly prompt: string;
  readonly isRequired: boolean;
}

/**
 * The registration form: one form across its steps, so every answer is posted together. A step that is not showing stays in
 * the DOM, hidden, and the last step holds the age confirmation (only when the page asks more than the account's 16) and the
 * optional profile share.
 */
export function RegistrationForm({
  orgId,
  orgSlug,
  pageSlug,
  minimumAge,
  questions,
  phone,
}: {
  orgId: string;
  orgSlug: string;
  pageSlug: string;
  minimumAge: number;
  questions: readonly RegistrationQuestionRow[];
  phone: string;
}) {
  const t = useTranslations("gateway.registration");
  const refusals = useTranslations("gateway.tokens.refusals");
  const outcomes = useTranslations("gateway.outcomes");
  const [state, formAction, pending] = useActionState(submitRegistrationAction, INITIAL);
  const [step, setStep] = useState(0);
  const [sections, setSections] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  // The first step holds the phone and six questions; later steps hold seven.
  const chunks: RegistrationQuestionRow[][] = [questions.slice(0, PER_STEP - 1)];
  for (let i = PER_STEP - 1; i < questions.length; i += PER_STEP) chunks.push([...questions.slice(i, i + PER_STEP)]);
  const stepNames = [...chunks.map((_c, i) => t("stepQuestions", { n: i + 1 })), t("stepConfirm")];
  const last = stepNames.length - 1;
  const next = (event: FormEvent) => {
    event.preventDefault();
    const empty = [...(ref.current?.querySelectorAll<HTMLTextAreaElement>(`[data-step="${step}"] textarea[required]`) ?? [])].some(
      (el) => el.value.trim() === "",
    );
    setMissing(empty);
    if (!empty) setStep((s) => Math.min(s + 1, last));
  };
  return (
    <form
      ref={ref}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      noValidate
      aria-label={t("formLabel")}
      className="flex flex-col gap-16"
    >
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="pageSlug" value={pageSlug} />
      <input type="hidden" name="sections" value={sections.join(",")} />
      <Stepper steps={stepNames} current={step} />
      {state.refusal ? <InlineAlert tone="danger">{refusals.has(state.refusal) ? refusals(state.refusal) : t("refused")}</InlineAlert> : null}
      {state.outcome ? <InlineAlert tone="danger">{outcomes(state.outcome)}</InlineAlert> : null}
      {missing ? <InlineAlert tone="warning">{t("answerRequired")}</InlineAlert> : null}
      {chunks.map((chunk, i) => (
        <div key={i} data-step={i} hidden={step !== i} className={step === i ? "flex flex-col gap-12" : undefined}>
          {i === 0 ? (
            <Input
              id="registration-phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              defaultValue={phone}
              label={t("phone")}
              help={t("phoneHelp")}
            />
          ) : null}
          {chunk.map((q) => (
            <Textarea
              key={q.id}
              id={`q-${q.id}`}
              name={`answer:${q.id}`}
              label={q.prompt}
              required={q.isRequired}
              rows={2}
              width="100%"
            />
          ))}
        </div>
      ))}
      <div data-step={last} hidden={step !== last} className={step === last ? "flex flex-col gap-12" : undefined}>
        {minimumAge > 16 ? (
          <Checkbox name="ageConfirmed" value="true" label={t("ageConfirm", { age: minimumAge })} />
        ) : null}
        <MultiSelect
          label={t("share")}
          help={t("shareHelp")}
          value={sections}
          options={SECTIONS.map((s) => ({ value: s, label: t(`sections.${s}`) }))}
          onChange={setSections}
        />
      </div>
      <div className="flex flex-wrap gap-8">
        {step > 0 ? (
          <Button type="button" variant="secondary" onClick={() => setStep((s) => s - 1)}>
            {t("back")}
          </Button>
        ) : null}
        {step < last ? (
          <Button type="button" variant="primary" onClick={next}>
            {t("next")}
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
            {t("submit")}
          </Button>
        )}
      </div>
    </form>
  );
}
