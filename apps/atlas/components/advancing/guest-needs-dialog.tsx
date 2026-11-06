"use client";

import { ACCESSIBILITY_NEEDS, DIETARY_NEEDS, workDetailLabelKey } from "@xos/data/work-details";
import type { GuestNeedsState } from "@xos/data/sensitive-consent";
import { Button, Checkbox, Dialog, InlineAlert, Input, MultiSelect, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import {
  clearGuestNeedsAction,
  setGuestNeedsAction,
  type GuestNeedsFormState,
} from "./guest-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const INITIAL: GuestNeedsFormState = {};

function HiddenFields({ values }: { values: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * Two steps: the attestation, then the needs. Each step has its own few fields, and the needs are all optional. What is
 * on file does not come back here: whoever keeps the list reads it only with medical access, so saving replaces it.
 */
export function GuestNeedsDialog({
  hidden,
  guestId,
  guestName,
  state: recorded,
  onClose,
}: {
  hidden: Readonly<Record<string, string>>;
  guestId: string;
  guestName: string;
  state: GuestNeedsState | null;
  onClose: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const format = useFormatter();
  const [authority, setAuthority] = useState(false);
  const [notice, setNotice] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [dietary, setDietary] = useState<string[]>([]);
  const [access, setAccess] = useState<string[]>([]);
  const [state, action, pending] = useActionState(setGuestNeedsAction, INITIAL);
  const [cleared, clear, clearing] = useActionState(clearGuestNeedsAction, INITIAL);
  const keep = useKeepInput(state, action, (s) => s.ok === true);
  const id = useId();
  const needsForm = `${id}-needs`;
  const clearForm = `${id}-clear`;
  useEffect(() => {
    if (state.ok || cleared.ok) onClose();
  }, [state, cleared, onClose]);
  const needsT = (key: string, values?: Record<string, string | number>) =>
    t(`consent.guestNeeds.${key}`, values);
  const error = state.error ?? cleared.error;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={needsT("openNamed", { name: guestName })}
      actions={
        confirmed ? (
          <>
            <Button variant="secondary" type="button" onClick={onClose}>
              {needsT("cancel")}
            </Button>
            {recorded ? (
              <Button variant="danger" type="submit" form={clearForm} loading={clearing}>
                {needsT("clear")}
              </Button>
            ) : null}
            <Button variant="primary" type="submit" form={needsForm} loading={pending}>
              {needsT("save")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={onClose}>
              {needsT("cancel")}
            </Button>
            {recorded ? (
              <Button variant="danger" type="submit" form={clearForm} loading={clearing}>
                {needsT("clear")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              type="button"
              disabled={!authority || !notice}
              onClick={() => setConfirmed(true)}
            >
              {needsT("continue")}
            </Button>
          </>
        )
      }
    >
      <form id={clearForm} action={clear}>
        <HiddenFields values={{ ...hidden, guestId }} />
      </form>
      {error ? (
        <InlineAlert tone="danger" title={needsT("openNamed", { name: guestName })}>
          {t(`errors.${error}`)}
        </InlineAlert>
      ) : null}
      {recorded ? (
        <p className="m-0 mb-8 text-text-13 text-text-secondary">
          {needsT("recorded", {
            name: recorded.givenByName ?? "",
            date: format.dateTime(new Date(recorded.givenAt), { dateStyle: "medium" }),
          })}{" "}
          {needsT("replaces")}
        </p>
      ) : null}
      {confirmed ? (
        <form id={needsForm} action={action} {...keep} className="flex flex-col gap-12" noValidate>
          <HiddenFields
            values={{ ...hidden, guestId, authorityConfirmed: "true", noticeConfirmed: "true" }}
          />
          {dietary.map((v) => (
            <input key={v} type="hidden" name="dietaryNeeds" value={v} />
          ))}
          {access.map((v) => (
            <input key={v} type="hidden" name="accessibilityNeeds" value={v} />
          ))}
          <MultiSelect
            id={`${id}-dietary`}
            label={needsT("dietaryNeeds")}
            value={dietary}
            onChange={setDietary}
            options={DIETARY_NEEDS.map((n) => ({
              value: n,
              label: t(`dietaryNeeds.${workDetailLabelKey(n)}`),
            }))}
          />
          <Textarea
            id={`${id}-allergies`}
            name="allergies"
            maxLength={500}
            width="100%"
            label={needsT("allergies")}
            help={needsT("allergiesHelp")}
          />
          <Textarea
            id={`${id}-dietary-notes`}
            name="dietaryNotes"
            maxLength={500}
            width="100%"
            label={needsT("dietaryNotes")}
          />
          <MultiSelect
            id={`${id}-access`}
            label={needsT("accessibilityNeeds")}
            value={access}
            onChange={setAccess}
            options={ACCESSIBILITY_NEEDS.map((n) => ({
              value: n,
              label: t(`accessibilityNeeds.${workDetailLabelKey(n)}`),
            }))}
          />
          <Textarea
            id={`${id}-access-notes`}
            name="accessibilityNotes"
            maxLength={1000}
            width="100%"
            label={needsT("accessibilityNotes")}
          />
          <Input
            id={`${id}-email`}
            name="guestEmail"
            type="email"
            maxLength={320}
            width="100%"
            autoComplete="off"
            label={needsT("email")}
            help={needsT("emailHelp")}
            {...(state.fieldErrors?.["guestEmail"] ? { error: t("errors.invalid") } : {})}
          />
        </form>
      ) : (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13 text-text-secondary">
            {t("consent.notices.dietary.attest")}
          </p>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("consent.notices.dietary.collected")}
          </p>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("consent.notices.accessibility.collected")}
          </p>
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
        </div>
      )}
    </Dialog>
  );
}
