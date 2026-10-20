"use client";

import { Icon } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { reactAction } from "@/lib/workforce/actions";

/** The curated reaction glyphs from the XOS icon set (Section 11.10 item 8), by reaction code. */
export const REACTION_GLYPHS: Readonly<Record<string, string>> = {
  thumbs_up: "ThumbsUp",
  heart: "Heart",
  check: "Check",
  eyes: "Eye",
  laugh: "Laugh",
  celebrate: "PartyPopper",
};

export interface ReactionChoice {
  readonly code: string;
  /** Accessible name with the count, for example "Thumbs up, 2". */
  readonly label: string;
  readonly count: number;
  readonly mine: boolean;
}

/**
 * A feed post's reactions as glyph toggles (A59-027): each shows its count only when someone has
 * reacted, the person's own reactions are pressed, and a press answers at once (optimistic) before
 * the server confirms (Section 11.10 item 9).
 */
export function ReactionBar({
  org,
  postId,
  label,
  choices,
}: {
  org: string;
  postId: string;
  label: string;
  choices: readonly ReactionChoice[];
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [shown, toggle] = useOptimistic(choices, (current, code: string) =>
    current.map((c) =>
      c.code === code ? { ...c, mine: !c.mine, count: c.count + (c.mine ? -1 : 1) } : c,
    ),
  );
  const react = (choice: ReactionChoice) =>
    start(async () => {
      toggle(choice.code);
      const form = new FormData();
      form.set("org", org);
      form.set("id", postId);
      form.set("code", choice.code);
      form.set("on", choice.mine ? "false" : "true");
      await reactAction({}, form);
      router.refresh();
    });
  return (
    <div className="flex flex-wrap gap-4" role="group" aria-label={label}>
      {shown.map((c) => (
        <button
          key={c.code}
          type="button"
          aria-pressed={c.mine}
          aria-label={c.label}
          title={c.label}
          onClick={() => react(c)}
          className={`xos-hit inline-flex min-h-control-sm items-center gap-4 rounded-chip border px-8 text-text-12 tabular-nums hover:bg-bg-hover focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring ${
            c.mine
              ? "border-border-strong bg-bg-selected text-accent-text"
              : "border-border-subtle text-text-secondary"
          }`}
        >
          <Icon name={REACTION_GLYPHS[c.code] ?? "Smile"} size={14} />
          {c.count > 0 ? <span>{c.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
