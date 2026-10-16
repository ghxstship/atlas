"use client";

import { Button, InlineAlert, Link, Switch } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { saveAiFeaturesAction, type AiFeaturesFormState } from "./actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const INITIAL: AiFeaturesFormState = {};

export interface AiFeaturesFormProps {
  readonly org: string;
  readonly features: readonly { readonly feature: string; readonly enabled: boolean }[];
  /** org.ai.write */
  readonly canEdit: boolean;
  /** Whether the plan includes aurora_ai; without it features stay off. */
  readonly inPlan: boolean;
}

/** The six Aurora AI switches (Section 4.7), every one off until an Admin turns it on. */
export function AiFeaturesForm({ org, features, canEdit, inPlan }: AiFeaturesFormProps) {
  const t = useTranslations("aurora.settings") as unknown as Translate;
  const tPanel = useTranslations("aurora.panel") as unknown as Translate;
  const [state, action, pending] = useActionState(saveAiFeaturesAction, INITIAL);
  const editable = canEdit && inPlan;
  return (
    <form action={action} className="flex max-w-layout-form flex-col gap-12">
      <input type="hidden" name="org" value={org} />
      {state.error ? (
        <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>
      ) : state.ok ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("saved")}
        </p>
      ) : null}
      {!inPlan ? <InlineAlert tone="info">{t("notInPlan")}</InlineAlert> : null}
      {inPlan && !canEdit ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("readOnly")}</p>
      ) : null}
      <fieldset className="m-0 flex flex-col divide-y divide-border-subtle border-0 p-0">
        <legend className="mb-8 text-heading-16 font-semibold">{t("legend")}</legend>
        {features.map((f) => (
          <div key={f.feature} className="flex flex-col gap-4 py-8">
            <Switch
              id={`ai-feature-${f.feature}`}
              name="enabled"
              value={f.feature}
              label={t(`features.${f.feature}.label`)}
              defaultChecked={f.enabled}
              disabled={!editable}
              aria-describedby={`ai-feature-${f.feature}-help`}
            />
            <p id={`ai-feature-${f.feature}-help`} className="m-0 text-text-12 text-text-secondary">
              {t(`features.${f.feature}.description`)}
            </p>
          </div>
        ))}
      </fieldset>
      <p className="m-0 text-text-12">
        <Link href="/legal/ai-features-notice">{tPanel("notice")}</Link>
      </p>
      {editable ? (
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
