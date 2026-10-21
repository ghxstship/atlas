"use client";

import { Button, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { triageFeedbackAction } from "@/lib/help/triage-actions";

type Translate = (key: string) => string;

const TRIAGE_STATES = ["Read", "Planned", "Closed"] as const;

/** One feedback item's triage: state and note, saved by platform staff (Section 11.7, A96). */
export function TriageForm({
  id,
  state,
  note,
}: {
  readonly id: string;
  readonly state: string;
  readonly note: string | null;
}) {
  const t = useTranslations("firstRun.triage") as unknown as Translate;
  const fieldId = useId();
  const [next, setNext] = useState(state === "New" ? "Read" : state);
  const [text, setText] = useState(note ?? "");
  const [result, action, pending] = useActionState(
    async (_previous: { ok: boolean } | null, form: FormData) => triageFeedbackAction(form),
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-8">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="state" value={next} />
      <input type="hidden" name="note" value={text} />
      <Select
        id={`${fieldId}-state`}
        label={t("state")}
        value={next}
        options={TRIAGE_STATES.map((s) => ({ value: s, label: t(`states.${s}`) }))}
        onChange={(e) => setNext(e.target.value)}
      />
      <Textarea
        id={`${fieldId}-note`}
        label={t("note")}
        value={text}
        width="100%"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-8">
        <Button type="submit" variant="primary" disabled={pending}>
          {t("save")}
        </Button>
        {result ? (
          <span role={result.ok ? "status" : "alert"} className="text-text-12">
            {t(result.ok ? "saved" : "failed")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
