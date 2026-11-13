"use client";

import { Button, InlineAlert, Input, Tag } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import {
  acceptCrewShiftAction,
  openCrewShiftsAction,
  type CrewAccessState,
} from "@/lib/actions/crew-shifts";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const INITIAL: CrewAccessState = {};

function Problem({ state }: { state: CrewAccessState }) {
  const t = useTranslations("gateway.tokens") as unknown as Translate;
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  if (state.refusal)
    return <InlineAlert tone="danger">{t(`refusals.${state.refusal}`)}</InlineAlert>;
  if (state.outcome) return <InlineAlert tone="danger">{outcomes(state.outcome)}</InlineAlert>;
  return null;
}

/** The code step: neutral, with no org or brand until a right code. */
export function CrewCodeForm({ token }: { token: string }) {
  const t = useTranslations("gateway.tokens");
  const [state, formAction, pending] = useActionState(openCrewShiftsAction, INITIAL);
  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      aria-label={t("crewShifts.codeLabel")}
    >
      <input type="hidden" name="token" value={token} />
      <Problem state={state} />
      <Input
        id="access-code"
        name="accessCode"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        label={t("code")}
        help={t("crewShifts.codeHelp")}
      />
      <div>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          {t("open")}
        </Button>
      </div>
    </form>
  );
}

export interface CrewShiftRow {
  readonly id: string;
  readonly day: string;
  readonly call: string;
  readonly title: string;
  readonly show: string | null;
  readonly venue: string | null;
  readonly state: string;
  readonly stateLabel: string;
}

const TONES: Readonly<Record<string, "success" | "warning" | "neutral">> = {
  Accepted: "success",
  Published: "warning",
};

/**
 * The worker's shifts grouped by day. Accept is secondary, because a worker may have several Published shifts and a screen
 * has at most one primary. Declining needs a sign-in (ADR 0149 decision 2), so a Published row links there instead. The confirmation is the row's tag and a message at the top of the page, never text inside the
 * row's control, which leaves once the row is Accepted.
 */
export function CrewShiftList({ token, rows }: { token: string; rows: readonly CrewShiftRow[] }) {
  const t = useTranslations("gateway.tokens.crewShifts");
  const [state, formAction, pending] = useActionState(acceptCrewShiftAction, INITIAL);
  const days = [...new Set(rows.map((r) => r.day))];
  return (
    <div className="flex flex-col gap-16">
      <Problem state={state} />
      {state.accepted ? (
        <p role="status" className="m-0 rounded-card border border-border-subtle p-12 text-text-14">
          {t("accepted")}
        </p>
      ) : null}
      {days.map((day) => (
        <section key={day} aria-label={day} className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">{day}</h2>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {rows
              .filter((r) => r.day === day)
              .map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                >
                  <div className="flex flex-wrap items-start justify-between gap-8">
                    <div className="flex min-w-0 flex-col gap-4">
                      <p className="m-0 text-text-14 font-medium">{r.call}</p>
                      <p className="m-0 text-text-13">{r.title}</p>
                      {r.show ? (
                        <p className="m-0 text-text-13 text-text-secondary">{r.show}</p>
                      ) : null}
                      {r.venue ? (
                        <p className="m-0 text-text-13 text-text-secondary">{r.venue}</p>
                      ) : null}
                    </div>
                    <Tag tone={TONES[r.state] ?? "neutral"}>{r.stateLabel}</Tag>
                  </div>
                  {r.state === "Published" ? (
                    <div className="flex flex-wrap items-center gap-12">
                      <form action={formAction} onSubmit={keepInputOnSubmit(formAction)}>
                        <input type="hidden" name="token" value={token} />
                        <input type="hidden" name="shiftId" value={r.id} />
                        <Button
                          type="submit"
                          variant="secondary"
                          disabled={pending}
                          aria-busy={pending}
                        >
                          {t("accept")}
                        </Button>
                      </form>
                      {/* Declining stays signed in, with a reason (ADR 0149 decision 2): the link says where. */}
                      <NextLink
                        href={"/auth/sign-in" as Route}
                        className="text-text-13 text-accent-text underline"
                      >
                        {t("declineSignedIn")}
                      </NextLink>
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
