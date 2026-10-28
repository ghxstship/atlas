"use client";

import { signalOnSuccess } from "@xos/data/workflow-signal";
import { Button, Checkbox, Dialog, InlineAlert, Input, Textarea } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import {
  applyAction,
  reportListingAction,
  saveSearchAction,
  type ApplyState,
  type SimpleState,
} from "@/lib/actions/marketplace";

import { keepInputOnSubmit } from "@/components/forms/keep-input";

/**
 * Profile sections an applicant may share with the org (app.share_profile_sections, 1132); the
 * same list as SHAREABLE_SECTIONS in @xos/data/profile-sharing, kept here so the form bundles no
 * data code.
 */
const SHAREABLE_SECTIONS = [
  "headline",
  "bio",
  "pronouns",
  "location",
  "skills",
  "certifications",
  "rates",
  "languages",
  "links",
] as const;
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Saves the current Explore filters as a search with alerts (Section 4.4.3, Discovery). It sends
 * Explore's query string, which the action parses with the page's own rules, so every filter the
 * person sees is saved.
 */
export function SaveSearchForm({ defaultName, search }: { defaultName: string; search: string }) {
  const t = useTranslations("gateway.explore.saveSearch") as unknown as Translate;
  const [state, action, pending] = useActionState<SimpleState, FormData>(saveSearchAction, {});
  if (state.done) {
    return (
      <InlineAlert tone="success">
        {t("saved")}{" "}
        <NextLink href={"/explore/alerts" as Route} className="text-accent-text underline">
          {t("title")}
        </NextLink>
      </InlineAlert>
    );
  }
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-wrap items-end gap-8"
      aria-label={t("title")}
    >
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="search" value={search} />
      <Input
        id="save-search-name"
        name="name"
        label={t("name")}
        help={t("nameHelp")}
        defaultValue={defaultName}
        required
      />
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {t("submit")}
      </Button>
    </form>
  );
}

export interface ApplyFormProps {
  readonly opportunityId: string;
  readonly role: string;
  readonly org: string;
  readonly mode: "person" | "bid" | "artist" | "slate";
  readonly personName: string | null;
  readonly email: string | null;
  readonly accountName: string | null;
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly required: boolean;
  }[];
  readonly feePosted: boolean;
  readonly currency: string;
  readonly roster: readonly { readonly personId: string; readonly name: string }[];
}

// A sent application completes the Apply funnel (A146); submitting it is the funnel's step.
const applyAndSignal = signalOnSuccess(
  applyAction,
  "gateway.apply:done",
  (s: ApplyState) => s.sent === true,
);

/**
 * Apply in one step (Section 4.4.3, Section 11.12 Apply): the person sees exactly what they share,
 * answers the org's questions and confirms availability. Vendors bid line by line, artists accept
 * or propose a fee, and agencies pick named staff from their roster. Nothing is sent until submit,
 * and typed input survives a refused submit.
 */
export function ApplyForm(props: ApplyFormProps) {
  const t = useTranslations("gateway.explore.applyForm") as unknown as Translate;
  const [state, action, pending] = useActionState<ApplyState, FormData>(applyAndSignal, {});
  const [lines, setLines] = useState([0]);
  const [next, setNext] = useState(1);
  if (state.sent) {
    return (
      <InlineAlert tone="success">
        {t("sent")}{" "}
        <NextLink href={"/work/applications" as Route} className="text-accent-text underline">
          {t("title", { role: props.role })}
        </NextLink>
      </InlineAlert>
    );
  }
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
      aria-label={t("title", { role: props.role })}
      data-workflow="gateway.apply:step1"
    >
      <input type="hidden" name="opportunityId" value={props.opportunityId} />
      {state.fieldError ? (
        <InlineAlert tone="danger">{t(`errors.${state.fieldError}`)}</InlineAlert>
      ) : null}
      <OutcomeAlert outcome={state.outcome} />

      <fieldset className="m-0 flex flex-col gap-8 rounded-control border border-border-subtle p-12">
        <legend className="px-4 text-text-13 font-medium">{t("shared", { org: props.org })}</legend>
        {props.personName ? (
          <Checkbox
            name="share_full_name"
            defaultChecked
            label={`${t("fieldName")}: ${props.personName}`}
          />
        ) : null}
        {props.email ? (
          <Checkbox
            name="share_email"
            defaultChecked
            label={`${t("fieldEmail")}: ${props.email}`}
          />
        ) : null}
        {props.accountName && (props.mode === "bid" || props.mode === "slate") ? (
          <Checkbox name="share_company_name" defaultChecked label={props.accountName} />
        ) : null}
        <p className="m-0 text-text-12 text-text-secondary">{t("sharedHelp")}</p>
      </fieldset>

      {props.mode === "person" ? (
        <fieldset className="m-0 flex flex-col gap-8 rounded-control border border-border-subtle p-12">
          <legend className="px-4 text-text-13 font-medium">
            {t("profileSections", { org: props.org })}
          </legend>
          <div className="flex flex-wrap gap-x-16 gap-y-4">
            {SHAREABLE_SECTIONS.map((section) => (
              <Checkbox
                key={section}
                name="share_section"
                value={section}
                label={t(`sections.${section}`)}
              />
            ))}
          </div>
          <p className="m-0 text-text-12 text-text-secondary">{t("profileSectionsHelp")}</p>
        </fieldset>
      ) : null}

      {props.questions.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
          <legend className="mb-8 text-text-13 font-medium">
            {t("questions", { org: props.org })}
          </legend>
          {props.questions.map((q) => (
            <Textarea
              key={q.id}
              id={`q-${q.id}`}
              name={`q_${q.id}`}
              label={q.prompt}
              required={q.required}
              rows={2}
              width="100%"
            />
          ))}
        </fieldset>
      ) : null}

      {props.mode === "artist" || props.mode === "person" ? (
        <Input
          id="apply-fee"
          name="fee"
          inputMode="decimal"
          label={`${t("fee")} (${props.currency})`}
          help={props.feePosted ? t("feeHelp") : t("feeRequestHelp")}
        />
      ) : null}
      {props.mode === "artist" ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("epkHelp")}</p>
      ) : null}

      {props.mode === "bid" ? (
        <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
          <legend className="mb-4 text-text-13 font-medium">{t("bidTitle")}</legend>
          <p className="m-0 text-text-12 text-text-secondary">
            {t("bidHelp")} {t("bidCurrency", { currency: props.currency })}
          </p>
          {lines.map((line, i) => (
            <div
              key={line}
              className="flex flex-wrap items-end gap-8 rounded-control bg-bg-surface p-8"
            >
              <Input
                id={`line-${line}-description`}
                name="lineDescription"
                label={t("bidDescription")}
                width="100%"
              />
              <Input
                id={`line-${line}-quantity`}
                name="lineQuantity"
                inputMode="decimal"
                label={t("bidQuantity")}
                width={120}
                defaultValue="1"
              />
              <Input
                id={`line-${line}-price`}
                name="linePrice"
                inputMode="decimal"
                label={t("bidUnitPrice")}
                {...(i === 0 ? { help: t("bidUnitPriceHelp") } : {})}
                width={160}
              />
              {lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setLines(lines.filter((l) => l !== line))}
                >
                  {t("bidRemoveLine", { n: i + 1 })}
                </Button>
              ) : null}
            </div>
          ))}
          <div>
            <Button
              type="button"
              icon="Plus"
              onClick={() => {
                setLines([...lines, next]);
                setNext(next + 1);
              }}
            >
              {t("bidAddLine")}
            </Button>
          </div>
          <Input id="bid-valid-until" name="validUntil" type="date" label={t("bidValidUntil")} />
        </fieldset>
      ) : null}

      {props.mode === "slate" ? (
        <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-text-13 font-medium">{t("slateTitle")}</legend>
          <p className="m-0 text-text-12 text-text-secondary">{t("slateHelp")}</p>
          {props.roster.length === 0 ? (
            <InlineAlert tone="info">{t("slateEmpty")}</InlineAlert>
          ) : (
            props.roster.map((m) => (
              <Checkbox key={m.personId} name="slate" value={m.personId} label={m.name} />
            ))
          )}
        </fieldset>
      ) : null}

      <Textarea id="apply-note" name="coverNote" label={t("coverNote")} rows={3} width="100%" />
      <Checkbox name="available" required label={t("available")} />
      <div>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** Report a listing (Section 4.4.3, Abuse): reason, what was seen, notice and action. */
export function ReportListing({
  opportunityId,
  reasons,
}: {
  opportunityId: string;
  reasons: readonly { readonly value: string; readonly label: string }[];
}) {
  const t = useTranslations("gateway.explore.reportForm") as unknown as Translate;
  const tr = useTranslations("gateway.explore.detail") as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SimpleState, FormData>(reportListingAction, {});
  if (state.done)
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("sent")}
      </p>
    );
  return (
    <>
      <Button variant="ghost" size="sm" icon="Flag" onClick={() => setOpen(true)}>
        {tr("report")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("body")}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              form="report-listing"
              variant="danger"
              disabled={pending}
              aria-busy={pending}
            >
              {t("submit")}
            </Button>
          </>
        }
      >
        <form
          id="report-listing"
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-col gap-12"
        >
          <OutcomeAlert outcome={state.outcome} />
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <label className="flex flex-col gap-4 text-text-13">
            <span className="font-medium">{t("reason")}</span>
            <select
              name="reason"
              required
              className="min-h-touch-min min-w-0 max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
            >
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <Textarea id="report-details" name="details" label={t("details")} rows={3} width="100%" />
        </form>
      </Dialog>
    </>
  );
}
