"use client";

import { SENSITIVE_NOTICE_KEYS, type SensitiveCategory } from "@xos/data/sensitive-consent";
import { Button, Checkbox, Dialog, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId } from "react";
import {
  giveSensitiveConsentAction,
  withdrawSensitiveConsentAction,
  type WorkDetailsFormState,
} from "@/lib/actions/work-details";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const INITIAL: WorkDetailsFormState = {};

const SECTIONS = ["collected", "why", "who", "withdraw"] as const;

/** What is collected, why, who sees it and how to withdraw; agreeing records it with the wording's version. */
export function ConsentDialog({
  category,
  hidden,
  attest,
  onClose,
}: {
  category: SensitiveCategory;
  hidden: Readonly<Record<string, string>>;
  attest: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const key = SENSITIVE_NOTICE_KEYS[category];
  const [state, action, pending] = useActionState(giveSensitiveConsentAction, INITIAL);
  const formId = useId();
  useEffect(() => {
    if (state.ok) onClose();
  }, [state, onClose]);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t(`consent.notices.${key}.title`)}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t("consent.notNow")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={pending}>
            {t("consent.agree")}
          </Button>
        </>
      }
    >
      <form id={formId} action={action} className="flex flex-col gap-12">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="category" value={category} />
        {SECTIONS.map((s) => (
          <div key={s} className="flex flex-col gap-2">
            <h3 className="m-0 text-text-13 font-semibold">{t(`consent.headings.${s}`)}</h3>
            <p className="m-0 text-text-13 text-text-secondary">
              {t(`consent.notices.${key}.${s}`)}
            </p>
          </div>
        ))}
        {attest ? (
          <>
            <p className="m-0 text-text-13 text-text-secondary">
              {t(`consent.notices.${key}.attest`)}
            </p>
            <Checkbox
              id={`${formId}-authority`}
              name="authorityConfirmed"
              value="true"
              label={t(`consent.notices.${key}.attestAuthority`)}
            />
            <Checkbox
              id={`${formId}-notice`}
              name="noticeConfirmed"
              value="true"
              label={t(`consent.notices.${key}.attestNotice`)}
            />
          </>
        ) : null}
        {state.error ? (
          <InlineAlert tone="danger" title={t("consent.notNow")}>
            {t(`errors.${state.error}`)}
          </InlineAlert>
        ) : null}
      </form>
    </Dialog>
  );
}

/** One confirmation, then use stops and the values are cleared. */
export function WithdrawDialog({
  category,
  hidden,
  onClose,
}: {
  category: SensitiveCategory;
  hidden: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const [state, action, pending] = useActionState(withdrawSensitiveConsentAction, INITIAL);
  const formId = useId();
  useEffect(() => {
    if (state.ok && !state.held) onClose();
  }, [state, onClose]);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("consent.withdrawAction.title")}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t("consent.withdrawAction.cancel")}
          </Button>
          {state.held ? null : (
            <Button variant="danger" type="submit" form={formId} loading={pending}>
              {t("consent.withdrawAction.confirm")}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} action={action} className="flex flex-col gap-12">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="category" value={category} />
        {state.held ? (
          <InlineAlert tone="info">{t("consent.withdrawAction.held")}</InlineAlert>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("consent.withdrawAction.body")}</p>
        )}
        {state.error ? (
          <InlineAlert tone="danger" title={t("consent.notNow")}>
            {t(`errors.${state.error}`)}
          </InlineAlert>
        ) : null}
      </form>
    </Dialog>
  );
}
