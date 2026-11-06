"use client";

import { Button, MultiSelect, Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";
import { ActionFeedback } from "@/components/collection-kit/kit";
import type { ActionState } from "@/lib/collection-kit/forms";
import { consolidateAction, linkOrderLinesAction } from "@/app/[org]/procurement/needs-actions";

interface Option {
  readonly value: string;
  readonly label: string;
}

const REFUSALS = "procurement.refusals";
const INITIAL: ActionState = {};

/**
 * Consolidate: the requests chosen from a long list go onto one new need per asset class, or onto the need chosen. The
 * button is secondary, because Add needs is the page's primary action (gate 27).
 */
export function ConsolidateForm({
  org,
  requests,
  needs,
}: {
  org: string;
  requests: readonly Option[];
  needs: readonly Option[];
}) {
  const t = useCopy("procurement.needs");
  const id = useId();
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [need, setNeed] = useState("");
  const [state, formAction, pending] = useActionState(consolidateAction, INITIAL);
  useEffect(() => {
    if (state.ok) {
      setPicked([]);
      setNeed("");
      router.refresh();
    }
  }, [state, router]);
  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
    >
      <input type="hidden" name="org" value={org} />
      <ActionFeedback state={state} refusals={REFUSALS} />
      <MultiSelect
        id={`${id}-requests`}
        label={t("readyRequests")}
        help={t("readyHelp")}
        options={[...requests]}
        value={picked}
        onChange={setPicked}
      />
      {picked.map((v) => (
        <input key={v} type="hidden" name="allocationId" value={v} />
      ))}
      <Select
        id={`${id}-need`}
        name="needId"
        label={t("consolidateOnto")}
        value={need}
        onChange={(e) => setNeed(e.target.value)}
        options={[{ value: "", label: t("consolidateNew") }, ...needs]}
      />
      <div>
        <Button type="submit" variant="secondary" disabled={pending || picked.length === 0}>
          {t("consolidate")}
        </Button>
      </div>
    </form>
  );
}

/** Links order lines to a need from its peek, including lines of an order that has left Proposed. */
export function LinkOrderLinesForm({
  org,
  needId,
  lines,
}: {
  org: string;
  needId: string;
  lines: readonly Option[];
}) {
  const t = useCopy("procurement.needs");
  const id = useId();
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [state, formAction, pending] = useActionState(linkOrderLinesAction, INITIAL);
  useEffect(() => {
    if (state.ok) {
      setPicked([]);
      router.refresh();
    }
  }, [state, router]);
  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="needId" value={needId} />
      <ActionFeedback state={state} refusals={REFUSALS} />
      <MultiSelect
        id={`${id}-lines`}
        label={t("linkLines")}
        options={[...lines]}
        value={picked}
        onChange={setPicked}
      />
      {picked.map((v) => (
        <input key={v} type="hidden" name="poLineId" value={v} />
      ))}
      <div>
        <Button type="submit" variant="secondary" disabled={pending || picked.length === 0}>
          {t("linkLinesSubmit")}
        </Button>
      </div>
    </form>
  );
}
