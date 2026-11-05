"use client";

import type { PermitRecord } from "@xos/data/safety-permits";
import { Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { permitDetailsAction, transitionPermitAction } from "@/app/[org]/safety/actions";
import { ActionForm, useCopy } from "@/components/places/kit/form";

/** ISO date part of a timestamp, for date inputs. */
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * Moves the Permit record to one of the states the record lifecycle allows from its current state
 * (app.lifecycle_transition_rules). Blocked asks for the blocker and Deferred for a replan reason,
 * which the database also requires. The next-state field is the record's Change state shortcut
 * target (data-shortcut="record.state").
 */
export function PermitTransitionForm({
  org,
  record,
  nextStates,
}: {
  org: string;
  record: PermitRecord;
  nextStates: readonly string[];
}) {
  const t = useCopy("permits");
  const [next, setNext] = useState(nextStates[0] ?? "");
  if (nextStates.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("permits.noMoves")}</p>;
  }
  return (
    <ActionForm
      action={transitionPermitAction}
      org={org}
      hidden={{ recordId: record.id, expected: record.state }}
      submitLabel={t("permits.move")}
      successMessage={t("permits.moved")}
    >
      {(error) => (
        <>
          <div data-shortcut="record.state" className="contents">
            <Select
              id={`permit-next-${record.id}`}
              name="next"
              label={t("permits.nextState")}
              value={next}
              options={nextStates.map((s) => ({ value: s, label: t(`states.${s}`) }))}
              onChange={(e) => setNext(e.target.value)}
              error={error("next")}
            />
          </div>
          <Input
            id={`permit-reason-${record.id}`}
            name="reason"
            required
            width="100%"
            label={t("permits.reason")}
            error={error("reason")}
          />
          {next === "Blocked" ? (
            <Textarea
              id={`permit-blocker-${record.id}`}
              name="blocker"
              required
              width="100%"
              rows={2}
              label={t("permits.blocker")}
              error={error("blocker")}
            />
          ) : null}
          {next === "Deferred" ? (
            <Textarea
              id={`permit-replan-${record.id}`}
              name="replanReason"
              required
              width="100%"
              rows={2}
              label={t("permits.replanReason")}
              error={error("replanReason")}
            />
          ) : null}
        </>
      )}
    </ActionForm>
  );
}

/** The authority's permit number and validity, recorded on the Permit record (never minted). */
export function PermitDetailsForm({ org, record }: { org: string; record: PermitRecord }) {
  const t = useCopy("permits");
  return (
    <ActionForm
      action={permitDetailsAction}
      org={org}
      hidden={{ recordId: record.id }}
      submitLabel={t("permits.saveDetails")}
      successMessage={t("permits.detailsSaved")}
    >
      {(error) => (
        <>
          <Input
            id={`permit-number-${record.id}`}
            name="permitIdentifier"
            label={t("permits.fields.number")}
            help={t("permits.fields.numberHelp")}
            defaultValue={record.permitIdentifier ?? ""}
          />
          <div className="flex flex-wrap gap-12">
            <Input
              id={`permit-issued-${record.id}`}
              name="issuedOn"
              type="date"
              label={t("permits.fields.issued")}
              defaultValue={dateOf(record.issuedAt)}
              error={error("issuedOn")}
            />
            <Input
              id={`permit-expires-${record.id}`}
              name="expiresOn"
              type="date"
              label={t("permits.fields.expires")}
              defaultValue={dateOf(record.expiresAt)}
              error={error("expiresOn")}
            />
          </div>
        </>
      )}
    </ActionForm>
  );
}
