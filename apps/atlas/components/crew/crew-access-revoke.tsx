"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  revokeCrewAccessLinkAction,
  type RevokeState,
} from "@/app/[org]/crew/access-links/actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const INITIAL: RevokeState = {};

/** Revokes one crew access link and says so in place when it could not. A revoked link's row loses this control. */
export function CrewAccessRevoke({ org, id }: { org: string; id: string }) {
  const t = useTranslations("crew.crewAccess");
  const refusals = useTranslations("crew.crewAccess.refusals") as unknown as Translate;
  const [state, formAction, pending] = useActionState(revokeCrewAccessLinkAction, INITIAL);
  const keep = useKeepInput(state, formAction, (done) => Boolean(done.done));
  return (
    <form action={formAction} {...keep} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={id} />
      {state.failed ? <InlineAlert tone="danger">{t("revokeFailed")}</InlineAlert> : null}
      {state.rule ? (
        <InlineAlert tone="danger">
          {refusals.has(state.rule)
            ? refusals(state.rule)
            : refusals("generic", { rule: state.rule })}
        </InlineAlert>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" disabled={pending} aria-busy={pending}>
          {t("revoke")}
        </Button>
      </div>
    </form>
  );
}
