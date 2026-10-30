"use client";

import { SITE_PLAN_MOVES, type SitePlanState } from "@xos/data/places";
import { Button, Textarea } from "@xos/ui";
import { useState } from "react";
import { transitionSitePlanAction } from "@/app/[org]/places/plan-actions";
import { ActionForm, useCopy } from "../kit/form";

/** The move each state offers first (ADR 0140 D1); the others are secondary, and Archive sits last. */
const PRIMARY: Readonly<Record<SitePlanState, SitePlanState>> = {
  Draft: "Locked",
  Locked: "Live",
  Live: "Locked",
  Archived: "Draft",
};

/** The action label of a move, by the state it leaves and the state it reaches. */
function moveKey(from: SitePlanState, to: SitePlanState): string {
  if (to === "Archived") return "archive";
  if (to === "Draft") return from === "Archived" ? "reopen" : "unlock";
  if (to === "Live") return "makeLive";
  return from === "Live" ? "backToLocked" : "lock";
}

/**
 * A plan's state actions: one primary move per state and the rest secondary, each confirmed with a required reason that
 * the ledger keeps (app.transition_site_plan). Reversible, so it confirms inline rather than in a dialog.
 */
export function PlanStateActions({
  org,
  id,
  state,
}: {
  org: string;
  id: string;
  state: SitePlanState;
}) {
  const t = useCopy("places");
  const [next, setNext] = useState<SitePlanState | null>(null);
  const moves = [...SITE_PLAN_MOVES[state]].sort((a, b) =>
    a === PRIMARY[state]
      ? -1
      : b === PRIMARY[state]
        ? 1
        : a === "Archived"
          ? 1
          : b === "Archived"
            ? -1
            : 0,
  );
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap gap-8">
        {moves.map((to) => (
          <Button
            key={to}
            variant={to === PRIMARY[state] ? "primary" : to === "Archived" ? "ghost" : "secondary"}
            size="sm"
            aria-expanded={next === to}
            onClick={() => setNext(next === to ? null : to)}
          >
            {t(`plans.actions.${moveKey(state, to)}`)}
          </Button>
        ))}
      </div>
      {next ? (
        <ActionForm
          key={next}
          action={transitionSitePlanAction}
          org={org}
          hidden={{ id, expected: state, next }}
          submitLabel={t(`plans.actions.${moveKey(state, next)}`)}
          onSuccess={() => {
            setNext(null);
            return null;
          }}
        >
          {(error) => (
            <>
              <p className="m-0 text-text-13 text-text-secondary">
                {t(`plans.actions.confirm.${moveKey(state, next)}`)}
              </p>
              <Textarea
                id={`plan-reason-${next}`}
                name="reason"
                required
                label={t("plans.actions.reason")}
                error={error("reason")}
              />
            </>
          )}
        </ActionForm>
      ) : null}
    </div>
  );
}
