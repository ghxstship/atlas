import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { Card } from "../Surface/Surface.tsx";
import { Checkbox, Textarea } from "../Forms/Forms.tsx";
import { type ApplicationFormProps } from "./Gateway.types.ts";

/** What the person shares before applying, the org's questions and availability confirmation. */
export function ApplicationForm({
  role,
  org,
  shared,
  questions,
  onSubmit,
}: ApplicationFormProps): ReactElement {
  const t = useT();
  return (
    <Card
      title={t("apply.title", { role })}
      meta={org}
      footer={
        <>
          <span className="me-auto text-text-secondary">{t("apply.draftSaved")}</span>
          <Button variant="primary" onClick={onSubmit}>
            {t("apply.submit")}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-8">
        <legend className="mb-8 text-text-12 font-medium text-text-secondary">
          {t("apply.shared", { org })}
        </legend>
        <ul className="grid grid-cols-2 max-sm:grid-cols-1 gap-8 m-0 px-12 py-8 list-none rounded-control bg-bg-surface">
          {shared.map((s) => (
            <li key={s.label}>
              <Checkbox label={s.label} defaultChecked={s.on} />
            </li>
          ))}
        </ul>
      </fieldset>
      {questions.map((q) => (
        <Textarea key={q} label={q} width="100%" rows={2} />
      ))}
      <Checkbox label={t("apply.available")} />
    </Card>
  );
}
