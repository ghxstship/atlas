"use client";

import { ACCESSIBILITY_NEEDS, DIETARY_NEEDS, workDetailLabelKey } from "@xos/data/work-details";
import type { GuestNeedsState } from "@xos/data/sensitive-consent";
import { Button, Checkbox, Dialog, InlineAlert, Input, MultiSelect, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import {
  clearGuestNeedsAction,
  setGuestNeedsAction,
  type GuestNeedsFormState,
} from "@/lib/actions/party";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const INITIAL: GuestNeedsFormState = {};

const ATTEST_SECTIONS = [
  ["collected", "attestCollected"],
  ["why", "attestWhy"],
  ["who", "attestWho"],
] as const;

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
 * on file does not come back here: whoever keeps the list reads it only with medical access, so saving replaces it. The
 * email is the exception: left empty it stays on file, so a routine correction still reaches the person it names.
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
  const keep = keepInputOnSubmit(action);
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
            {/* Its own key: reusing Continue's element would turn that click into this submit. */}
            <Button key="save" variant="primary" type="submit" form={needsForm} loading={pending}>
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
              key="continue"
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
        <form
          id={needsForm}
          action={action}
          onSubmit={keep}
          className="flex flex-col gap-12"
          noValidate
        >
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
            help={needsT(recorded?.hasEmail ? "emailOnFile" : "emailHelp")}
            {...(state.fieldErrors?.["guestEmail"] ? { error: t("errors.invalid") } : {})}
          />
          {recorded?.hasEmail ? (
            <Checkbox
              id={`${id}-clear-email`}
              name="clearGuestEmail"
              label={needsT("clearEmail")}
            />
          ) : null}
        </form>
      ) : (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13 text-text-secondary">
            {t("consent.notices.dietary.attest")}
          </p>
          {/* What the guest must have been told: the two statements below are about exactly this. */}
          {ATTEST_SECTIONS.map(([heading, part]) => (
            <div key={part} className="flex flex-col gap-2">
              <h3 className="m-0 text-text-13 font-semibold">{t(`consent.headings.${heading}`)}</h3>
              <p className="m-0 text-text-13 text-text-secondary">
                {t(`consent.notices.dietary.${part}`)}
              </p>
              <p className="m-0 text-text-13 text-text-secondary">
                {t(`consent.notices.accessibility.${part}`)}
              </p>
            </div>
          ))}
          <Checkbox
            id={`${id}-authority`}
            label={t("consent.notices.dietary.attestAuthority")}
            checked={authority}
            onChange={(event) => setAuthority(event.target.checked)}
          />
          <Checkbox
            id={`${id}-notice`}
            label={t("consent.notices.dietary.attestNotice")}
            checked={notice}
            onChange={(event) => setNotice(event.target.checked)}
          />
        </div>
      )}
    </Dialog>
  );
}
