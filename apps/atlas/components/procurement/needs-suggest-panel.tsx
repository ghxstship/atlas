"use client";

import { createAuroraClient } from "@xos/ai/client";
import { Button, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  findNeedCandidatesAction,
  setNeedElementAction,
} from "@/app/[org]/procurement/needs-actions";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { useCopy } from "@/components/collection-kit/use-copy";
import type { ActionState } from "@/lib/collection-kit/forms";

type Phase =
  | { readonly kind: "running" }
  | { readonly kind: "none" }
  | {
      readonly kind: "proposal";
      readonly elementId: string;
      readonly name: string;
      readonly suggestionIds: readonly string[];
    };

/** The proposal itself (needs-suggest-button.tsx): the need takes the element only after the person confirms. */
export function SuggestCategoryPanel({
  org,
  needId,
  description,
}: {
  org: string;
  needId: string;
  description: string;
}) {
  const t = useCopy("procurement.needs");
  const router = useRouter();
  const client = useMemo(() => createAuroraClient({ baseUrl: "/api/v1" }), []);
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<ActionState>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const candidates = await findNeedCandidatesAction(org, description);
      if (candidates.length === 0) {
        if (live) setPhase({ kind: "none" });
        return;
      }
      // The body takes a code of up to 100 characters and the whole description beside it.
      const result = await client.bindCode({
        code: description.slice(0, 100),
        description,
        candidates,
      });
      if (!live) return;
      setPhase(
        result.ok && result.data.outcome === "answer" && result.data.answer
          ? {
              kind: "proposal",
              elementId: result.data.answer.elementId,
              name: result.data.answer.name,
              suggestionIds: result.data.suggestions.map((s) => s.suggestion_id),
            }
          : { kind: "none" },
      );
    })();
    return () => {
      live = false;
    };
  }, [client, org, description]);
  if (phase.kind === "running") {
    return <p className="m-0 text-text-13 text-text-secondary">{t("suggest.running")}</p>;
  }
  if (phase.kind === "none") {
    return <InlineAlert tone="info">{t("suggest.none")}</InlineAlert>;
  }
  const confirm = () =>
    start(async () => {
      const form = new FormData();
      form.set("org", org);
      form.set("id", needId);
      form.set("elementId", phase.elementId);
      const state = await setNeedElementAction({}, form);
      setOutcome(state);
      if (state.ok) {
        await Promise.all(phase.suggestionIds.map((id) => client.reject(id, t("suggest.closed"))));
        router.refresh();
      }
    });
  return (
    <div className="flex flex-col gap-8 text-text-13">
      <ActionFeedback state={outcome} refusals="procurement.refusals" />
      <div className="flex flex-wrap items-center gap-8">
        <span>{t("suggest.proposal", { name: phase.name })}</span>
        <Button variant="secondary" size="sm" disabled={pending} onClick={confirm}>
          {t("suggest.confirm")}
        </Button>
      </div>
    </div>
  );
}
