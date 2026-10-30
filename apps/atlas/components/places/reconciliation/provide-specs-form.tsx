"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState } from "react";
import { providePlaceSpecsAction } from "@/app/[org]/places/plan-actions";
import { INITIAL_STATE } from "../kit/action-state";
import { useCopy } from "../kit/form";

/**
 * "Add venue specs as capabilities" (G-92, ADR 0140 D9): copies the project venue's known power, rigging and
 * connectivity specs into Provide capabilities, DOCUMENTED or CLAIMED, and says how many it wrote. It never runs on its
 * own, so a later change to the specs shows as "Venue specs changed" until it runs again. Needs projects.scope.write.
 */
export function ProvideSpecsForm({ org, projectId }: { org: string; projectId: string }) {
  const t = useCopy("places");
  const [state, action, pending] = useActionState(providePlaceSpecsAction, INITIAL_STATE);
  return (
    <form action={action} className="flex flex-col gap-8">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectId" value={projectId} />
      {state.error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${state.error}`)}
        </InlineAlert>
      ) : null}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant="secondary" loading={pending}>
          {t("specs.provide")}
        </Button>
        {state.ok ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {t("specs.provided", { count: Number(state.id ?? 0) })}
          </p>
        ) : null}
      </div>
    </form>
  );
}
