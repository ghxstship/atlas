"use client";

import { Button, Checkbox, Dialog, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { attestRosterMealAction, consentRosterMealAction } from "@/lib/actions/roster-facts";

type Translate = (key: string) => string;

const SECTIONS = ["collected", "why", "who", "withdraw"] as const;

/**
 * The step before a meal preference: the person reads the dietary wording and agrees, or the company confirms it has the
 * person's authority and that the person has had notice. No input is typed here, so nothing is lost by closing it.
 */
export function MealConsentDialog({
  rosterEntryId,
  mode,
  onClose,
  onGranted,
}: {
  rosterEntryId: string;
  mode: "person" | "company";
  onClose: () => void;
  onGranted: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const id = useId();
  const [authority, setAuthority] = useState(false);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const company = mode === "company";
  const agree = () =>
    startTransition(async () => {
      const result = company
        ? await attestRosterMealAction(rosterEntryId, authority, notice)
        : await consentRosterMealAction();
      if (result.ok) onGranted();
      else setError(result.error);
    });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={company ? t("consent.attest.mealTitle") : t("consent.notices.dietary.title")}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t("consent.notNow")}
          </Button>
          <Button
            variant="primary"
            type="button"
            loading={pending}
            disabled={company && (!authority || !notice)}
            onClick={agree}
          >
            {t("consent.agree")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        {company ? (
          <>
            <p className="m-0 text-text-13 text-text-secondary">{t("consent.attest.mealBody")}</p>
            <Checkbox
              id={`${id}-authority`}
              label={t("consent.attest.authority")}
              checked={authority}
              onChange={(event) => setAuthority(event.target.checked)}
            />
            <Checkbox
              id={`${id}-notice`}
              label={t("consent.attest.notice")}
              checked={notice}
              onChange={(event) => setNotice(event.target.checked)}
            />
          </>
        ) : (
          SECTIONS.map((s) => (
            <div key={s} className="flex flex-col gap-2">
              <h3 className="m-0 text-text-13 font-semibold">{t(`consent.headings.${s}`)}</h3>
              <p className="m-0 text-text-13 text-text-secondary">
                {t(`consent.notices.dietary.${s}`)}
              </p>
            </div>
          ))
        )}
        {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      </div>
    </Dialog>
  );
}
