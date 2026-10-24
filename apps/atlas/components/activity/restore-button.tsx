"use client";

import type { RestoreTarget } from "@xos/data/activity";
import { Button, InlineAlert } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { restoreAction } from "@/app/[org]/trash/actions";
import type { WorkflowActionState } from "@/lib/workflow/state";

type Translate = ((key: string, values?: Record<string, string>) => string) & {
  has: (key: string) => boolean;
};

/**
 * Restore on an activity entry for a row moved to Trash (Section 11.7, ADR 0077), offered until the retention purge.
 * It restores through app.restore_trash_item as the viewer, exactly as the Trash page does, so the row's own rules
 * decide. The restored row's entry stops offering Restore when the feed reloads, so success is announced by the
 * feed, not beside the button; a refusal stays here.
 */
export function RestoreButton({
  org,
  target,
  label,
  onRestored,
}: {
  org: string;
  target: RestoreTarget;
  /** What the entry acted on, for the button's name and the announcement. */
  label: string;
  onRestored: (label: string) => void;
}) {
  const t = useTranslations("activity.feed") as unknown as Translate;
  const w = useTranslations("workflow") as unknown as Translate;
  const format = useFormatter();
  const [state, setState] = useState<WorkflowActionState>({});
  const [pending, start] = useTransition();
  const until = t("restoreUntil", {
    date: format.dateTime(new Date(target.purgeAfter), { dateStyle: "medium" }),
  });
  const refusal = state.rule
    ? w.has(`refusals.${state.rule}`)
      ? w(`refusals.${state.rule}`)
      : w("refusals.other")
    : state.error
      ? w(`errors.${state.error}`)
      : null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-4">
      <Button
        size="sm"
        variant="secondary"
        icon="Undo2"
        loading={pending}
        aria-label={t("restoreLabel", { target: label })}
        title={until}
        onClick={() =>
          start(async () => {
            const form = new FormData();
            form.set("org", org);
            form.set("table", target.table);
            form.set("id", target.id);
            const next = await restoreAction({}, form);
            setState(next);
            if (next.ok) onRestored(label);
          })
        }
      >
        {t("restore")}
      </Button>
      {refusal ? (
        <InlineAlert tone="warning">{t("restoreFailed", { message: refusal })}</InlineAlert>
      ) : null}
    </div>
  );
}
