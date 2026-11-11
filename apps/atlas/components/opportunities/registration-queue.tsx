"use client";

import { Button, InlineAlert } from "@xos/ui";
import type { DecisionResult, RegistrationRow } from "@xos/data/registration";
import dynamic from "next/dynamic";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { decideRegistrationsAction } from "@/app/[org]/opportunities/registration-pages/actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import type { OpportunityActionState } from "@/lib/opportunities/action-state";

const RegistrationPicker = dynamic(() =>
  import("./registration-picker").then((m) => m.RegistrationPicker),
);

type State = OpportunityActionState & { readonly decisions?: readonly DecisionResult[] };
type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const INITIAL: State = {};

/**
 * The registrations queue: bulk Approve or Decline, with each row's outcome on the page itself, because a decided row can
 * leave the list after the refresh and a confirmation inside it would never be seen. People are chosen in one picker: a
 * checkbox per row would count as a field per row, and a form has at most seven. A reader who cannot decide gets the rows
 * alone: application.read opens them org-wide, and deciding needs pool.write.
 */
export function RegistrationQueue({
  org,
  rows,
  canDecide,
}: {
  org: string;
  rows: readonly RegistrationRow[];
  canDecide: boolean;
}) {
  return canDecide ? <DecidingQueue org={org} rows={rows} /> : <RegistrationRows rows={rows} />;
}

function RegistrationRows({ rows }: { rows: readonly RegistrationRow[] }) {
  const t = useTranslations("opportunities.registrations") as unknown as Translate;
  const format = useFormatter();
  return (
    <ul className="m-0 flex list-none flex-col gap-8 p-0">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
        >
          <div className="flex flex-wrap items-center justify-between gap-8">
            <span className="font-medium">{r.personName ?? t("unnamed")}</span>
            <span className="text-text-12 text-text-secondary">
              {t("line", {
                page: r.pageTitle ?? "",
                state: t(`states.${r.state}`),
                when: r.submittedAt
                  ? format.dateTime(new Date(r.submittedAt), { dateStyle: "medium" })
                  : "",
              })}
            </span>
          </div>
          {r.answers.map((a) => (
            <p key={a.prompt} className="m-0 text-text-12">
              <span className="text-text-secondary">{a.prompt}</span> {a.answer}
            </p>
          ))}
          {r.confirmedMinimumAge ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("ageConfirmed", { age: r.confirmedMinimumAge })}
            </p>
          ) : null}
          {r.profileShareId ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("sharedProfile")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DecidingQueue({ org, rows }: { org: string; rows: readonly RegistrationRow[] }) {
  const t = useTranslations("opportunities.registrations") as unknown as Translate;
  const refusals = useTranslations("opportunities.errors.refusal") as unknown as Translate;
  const [state, formAction, pending] = useActionState(decideRegistrationsAction, INITIAL);
  const keep = useKeepInput(state, formAction, (done) => Boolean(done.ok));
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const submitted = rows.filter((r) => r.state === "Submitted");
  // Someone decided here or elsewhere leaves the picker with the refresh.
  const chosen = picked.filter((id) => submitted.some((r) => r.id === id));
  const decisions = state.decisions ?? [];
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.personName ?? t("unnamed");
  return (
    <form action={formAction} {...keep} aria-label={t("title")} className="flex flex-col gap-12">
      <input type="hidden" name="org" value={org} />
      {decisions.length > 0 ? (
        <InlineAlert tone={decisions.some((d) => d.outcome === "refused") ? "warning" : "success"}>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {decisions.map((d) => (
              <li key={d.id}>
                {d.outcome === "applied"
                  ? t("decided", { name: nameOf(d.id) })
                  : t("refused", {
                      name: nameOf(d.id),
                      why: refusals.has(d.code ?? "")
                        ? refusals(d.code ?? "")
                        : refusals("generic", { rule: d.code ?? "" }),
                    })}
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      {state.error ? <InlineAlert tone="danger">{t("decideFailed")}</InlineAlert> : null}
      <RegistrationRows rows={rows} />
      {submitted.length > 0 ? (
        <div className="flex max-w-layout-form flex-col gap-8">
          {chosen.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          {choosing ? (
            <RegistrationPicker
              key={submitted.map((r) => r.id).join()}
              label={t("pick")}
              help={t("pickHelp")}
              value={[...chosen]}
              options={submitted.map((r) => ({
                value: r.id,
                label: `${r.personName ?? t("unnamed")} · ${r.pageTitle ?? ""}`,
              }))}
              onChange={setPicked}
            />
          ) : (
            <div>
              <Button type="button" size="sm" onClick={() => setChoosing(true)}>
                {t("pick")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-8">
            <Button
              type="submit"
              name="approve"
              value="true"
              variant="secondary"
              disabled={pending || chosen.length === 0}
            >
              {t("approve", { count: chosen.length })}
            </Button>
            <Button
              type="submit"
              name="approve"
              value="false"
              variant="secondary"
              disabled={pending || chosen.length === 0}
            >
              {t("decline", { count: chosen.length })}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
