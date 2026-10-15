"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState } from "react";
import { generatePermitsAction } from "@/app/[org]/safety/actions";
import { INITIAL_STATE } from "@/components/places/kit/action-state";
import { useCopy } from "@/components/places/kit/form";

/** Runs the permit engine for one project and says how many requirements it added. */
export function GenerateButton({ org, projectId }: { org: string; projectId: string }) {
  const t = useCopy("permits");
  const errors = useCopy("places");
  const [state, action, pending] = useActionState(generatePermitsAction, INITIAL_STATE);
  return (
    <form action={action} className="flex flex-col items-start gap-8">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" variant="primary" loading={pending}>
        {t("permits.generate")}
      </Button>
      {state.ok ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("permits.generated", { count: Number(state.id ?? 0) })}
        </p>
      ) : null}
      {state.error ? (
        <InlineAlert tone="danger" title={errors("errors.title")}>
          {errors(`errors.${state.error}`)}
        </InlineAlert>
      ) : null}
    </form>
  );
}
