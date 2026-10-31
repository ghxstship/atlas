"use client";

import { Button, Input, MoreFields, Select, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import {
  resubmitSponsorAssetAction,
  submitTypedAdvanceAction,
  supplySponsorAssetAction,
  uploadAdvanceFileAction,
} from "@/lib/actions/advance";
import type { FormResult } from "@/lib/actions/operations";
import { FormShell, useCopy } from "./forms";

/**
 * The Advance tab's typed answer forms (R9, Section 4.4.4): files, schedule windows, item and
 * credential requests and the guest list confirmation, plus the sponsor's own brand assets. Each is
 * one form with its submit, secondary when it is one of several sections (Section 11.10), and at most
 * seven fields before More fields. The actions prop lets the token pages of R10 reuse the forms.
 */

export interface Option {
  readonly value: string;
  readonly label: string;
}

type Action = (state: FormResult, form: FormData) => Promise<FormResult>;

const PARTY_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/heic,image/webp,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function FileField({
  id,
  multiple,
  label,
  help,
}: {
  id: string;
  multiple: boolean;
  label: string;
  help: string;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-4 text-text-13">
      <span className="font-medium">{label}</span>
      <input
        id={id}
        type="file"
        name="file"
        required
        multiple={multiple}
        accept={PARTY_ACCEPT}
        className="min-h-touch-min max-w-full text-text-13"
      />
      <span className="text-text-12 text-text-secondary">{help}</span>
    </label>
  );
}

/** A File section: one to max files, uploaded to party-uploads and attached to one answer. */
export function AdvanceFileForm(props: {
  orgId: string;
  recipientId: string;
  sectionId: string;
  maxFiles: number;
  label: string;
  actions?: { upload: Action };
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    props.actions?.upload ?? uploadAdvanceFileAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("advanceTyped.uploadSubmit")}
      doneLabel={t("advanceTyped.done")}
      label={props.label}
    >
      <input type="hidden" name="orgId" value={props.orgId} />
      <input type="hidden" name="recipientId" value={props.recipientId} />
      <input type="hidden" name="sectionId" value={props.sectionId} />
      <FileField
        id={`advance-file-${props.sectionId}`}
        multiple={props.maxFiles > 1}
        label={t("advanceTyped.files")}
        help={t("advanceTyped.filesHelp", { n: props.maxFiles })}
      />
      <MoreFields>
        <Textarea
          id={`advance-file-note-${props.sectionId}`}
          name="note"
          label={t("advanceTyped.note")}
          maxLength={2000}
          rows={2}
        />
      </MoreFields>
    </FormShell>
  );
}

/**
 * Lines of a Schedule Window (windows only), Item Request or Credential Request section. A line is
 * an item and a quantity, a person when the section is per person (or, for a credential, when one
 * is named), with its window and note behind More fields; a window line is a start and an end.
 */
export function AdvanceLinesForm(props: {
  recipientId: string;
  sectionId: string;
  kind: "Schedule Window" | "Item Request" | "Credential Request";
  label: string;
  timeZone: string;
  maxLines: number;
  perPerson: boolean;
  items: readonly Option[];
  people: readonly Option[];
  actions?: { submit: Action };
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    props.actions?.submit ?? submitTypedAdvanceAction,
    {},
  );
  const [count, setCount] = useState(1);
  const windows = props.kind === "Schedule Window";
  const personField = !windows && (props.perPerson || props.kind === "Credential Request");
  const key = (n: number, field: string) => `advance-${props.sectionId}-${n}-${field}`;
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("advanceTyped.submit")}
      doneLabel={t("advanceTyped.done")}
      label={props.label}
    >
      <input type="hidden" name="recipientId" value={props.recipientId} />
      <input type="hidden" name="sectionId" value={props.sectionId} />
      <input type="hidden" name="lines" value={count} />
      {Array.from({ length: count }, (_, n) => (
        <fieldset key={n} className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-text-13 font-medium text-text-secondary">
            {windows
              ? t("advanceTyped.windowN", { n: n + 1 })
              : t("advanceTyped.lineN", { n: n + 1 })}
          </legend>
          {windows ? (
            <div className="flex flex-wrap items-end gap-12">
              <Input
                id={key(n, "from")}
                name={`line.${n}.from`}
                type="datetime-local"
                required
                label={t("advanceTyped.from")}
              />
              <Input
                id={key(n, "to")}
                name={`line.${n}.to`}
                type="datetime-local"
                required
                label={t("advanceTyped.to")}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-12">
                <Select
                  id={key(n, "item")}
                  name={`line.${n}.item`}
                  label={
                    props.kind === "Credential Request"
                      ? t("advanceTyped.credential")
                      : t("advanceTyped.item")
                  }
                  options={[...props.items]}
                  value={props.items[0]?.value ?? ""}
                />
                <Input
                  id={key(n, "quantity")}
                  name={`line.${n}.quantity`}
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={1}
                  required
                  label={t("advanceTyped.quantity")}
                  width={120}
                />
                {personField ? (
                  <Select
                    id={key(n, "person")}
                    name={`line.${n}.person`}
                    label={t("advanceTyped.person")}
                    placeholder={
                      props.perPerson ? t("advanceTyped.personHint") : t("advanceTyped.forPool")
                    }
                    options={[...props.people]}
                  />
                ) : null}
              </div>
              <MoreFields>
                <div className="flex flex-wrap items-end gap-12">
                  <Input
                    id={key(n, "from")}
                    name={`line.${n}.from`}
                    type="datetime-local"
                    label={t("advanceTyped.neededFrom")}
                  />
                  <Input
                    id={key(n, "to")}
                    name={`line.${n}.to`}
                    type="datetime-local"
                    label={t("advanceTyped.neededTo")}
                  />
                </div>
                <Textarea
                  id={key(n, "note")}
                  name={`line.${n}.note`}
                  label={t("advanceTyped.lineNote")}
                  maxLength={500}
                  rows={2}
                />
              </MoreFields>
            </>
          )}
        </fieldset>
      ))}
      {count < props.maxLines ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCount((c) => Math.min(c + 1, props.maxLines))}
          >
            {windows ? t("advanceTyped.addWindow") : t("advanceTyped.addLine")}
          </Button>
        </div>
      ) : null}
      <MoreFields>
        <Input
          id={`advance-${props.sectionId}-zone`}
          name="timeZone"
          label={t("advanceTyped.timeZone")}
          help={t("advanceTyped.timeZoneHelp")}
          defaultValue={props.timeZone}
        />
        <Textarea
          id={`advance-${props.sectionId}-note`}
          name="note"
          label={t("advanceTyped.note")}
          maxLength={2000}
          rows={2}
        />
      </MoreFields>
    </FormShell>
  );
}

/** A Guest List section: the party confirms its list once the guests are in. */
export function GuestListConfirmForm(props: {
  recipientId: string;
  sectionId: string;
  label: string;
  timeZone: string;
  actions?: { submit: Action };
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    props.actions?.submit ?? submitTypedAdvanceAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("advanceTyped.confirmGuests")}
      doneLabel={t("advanceTyped.done")}
      label={props.label}
    >
      <input type="hidden" name="recipientId" value={props.recipientId} />
      <input type="hidden" name="sectionId" value={props.sectionId} />
      <input type="hidden" name="lines" value={0} />
      <input type="hidden" name="timeZone" value={props.timeZone} />
      <p className="m-0 text-text-13 text-text-secondary">{t("advanceTyped.confirmGuestsHelp")}</p>
    </FormShell>
  );
}

/** The sponsor supplies a brand asset for an entitlement: kind, title and files, the rest under More fields. */
export function SupplySponsorAssetForm(props: {
  orgId: string;
  entitlements: readonly Option[];
  kinds: readonly Option[];
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    supplySponsorAssetAction,
    {},
  );
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("sponsorSupply.submit")}
      doneLabel={t("sponsorSupply.done")}
      label={t("sponsorSupply.title")}
    >
      <input type="hidden" name="orgId" value={props.orgId} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="supply-entitlement"
          name="entitlementId"
          label={t("sponsorSupply.entitlement")}
          options={[...props.entitlements]}
          value={props.entitlements[0]?.value ?? ""}
        />
        <Select
          id="supply-kind"
          name="kind"
          label={t("sponsorSupply.kind")}
          options={[...props.kinds]}
          value="Logo"
        />
      </div>
      <Input
        id="supply-title"
        name="title"
        required
        maxLength={200}
        label={t("sponsorSupply.assetTitle")}
      />
      <FileField
        id="supply-files"
        multiple
        label={t("sponsorSupply.files")}
        help={t("sponsorSupply.filesHelp")}
      />
      <MoreFields>
        <Textarea
          id="supply-usage"
          name="usageNote"
          label={t("sponsorSupply.usageNote")}
          maxLength={1000}
          rows={2}
        />
        <Input id="supply-due" name="dueOn" type="date" label={t("sponsorSupply.dueOn")} />
      </MoreFields>
    </FormShell>
  );
}

/** The sponsor resubmits a returned asset it supplied, with new files. */
export function ResubmitSponsorAssetForm(props: {
  orgId: string;
  entitlementId: string;
  assetId: string;
  title: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    resubmitSponsorAssetAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("sponsorSupply.resubmit")}
      doneLabel={t("sponsorSupply.resubmitted")}
      label={props.title}
    >
      <input type="hidden" name="orgId" value={props.orgId} />
      <input type="hidden" name="entitlementId" value={props.entitlementId} />
      <input type="hidden" name="assetId" value={props.assetId} />
      <FileField
        id={`resubmit-files-${props.assetId}`}
        multiple
        label={t("sponsorSupply.files")}
        help={t("sponsorSupply.filesHelp")}
      />
      <MoreFields>
        <Textarea
          id={`resubmit-reason-${props.assetId}`}
          name="reason"
          label={t("sponsorSupply.reason")}
          maxLength={500}
          rows={2}
        />
      </MoreFields>
    </FormShell>
  );
}
