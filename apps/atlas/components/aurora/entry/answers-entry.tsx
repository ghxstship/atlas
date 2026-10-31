"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";
import type { InboxSourceProp } from "./intake-entry";

/**
 * The B15 drafting entry points (RRR-239): advance answers drafted from a project inbox message or a
 * document the party sent (G-173), and event plans, briefs, approval packs and waste plans drafted
 * from the project's own records (G-240). Each renders only while drafting is on for the org; the
 * page ships only the button, and the panel loads on first use.
 */

const answers = onDemand(() => import("./advance-answers-dialog"));
const governance = onDemand(() => import("./governance-draft-dialog"));

export interface AdvanceAnswersEntryProps {
  /** Recipients of the project's sent packets the viewer reviews; one when opened from a recipient. */
  readonly recipients: readonly { readonly id: string; readonly label: string }[];
  readonly inbox: readonly InboxSourceProp[];
  /** The message, when opened from a project inbox row. */
  readonly messageId?: string;
  readonly variant?: "secondary" | "ghost";
}

/** "Draft advance answers" on a recipient of a sent packet, or on a project inbox row. */
export function AdvanceAnswersEntry(props: AdvanceAnswersEntryProps) {
  const t = useTranslations("aurora.entry.advanceAnswers");
  const on = useAiFeature("drafting");
  const panel = useEntryPanel(answers);
  if (!on || props.recipients.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-8">
      <AiButton
        feature="drafting"
        label={t("button")}
        variant={props.variant ?? "secondary"}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.AdvanceAnswersDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </span>
  );
}

export type GovernanceKind = "event_plan" | "event_brief" | "approval_pack" | "waste_plan";
export const GOVERNANCE_KINDS: readonly GovernanceKind[] = [
  "event_plan",
  "event_brief",
  "approval_pack",
  "waste_plan",
];

export interface GovernanceDraftEntryProps {
  readonly org: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
}

/** "Draft with Aurora" on the project's Documents tab: an event plan, brief, approval pack or waste plan. */
export function GovernanceDraftEntry(props: GovernanceDraftEntryProps) {
  const t = useTranslations("aurora.entry.governance");
  const on = useAiFeature("drafting");
  const panel = useEntryPanel(governance);
  const [kind, setKind] = useState<GovernanceKind>("event_plan");
  const [menu, setMenu] = useState(false);
  if (!on) return null;
  return (
    <div className="relative flex flex-wrap items-center gap-8">
      <AiButton
        feature="drafting"
        label={t("button")}
        onOpen={() => setMenu((m) => !m)}
        onPreload={panel.preload}
      />
      {menu ? (
        <ul role="menu" aria-label={t("menu")} className="m-0 flex list-none flex-wrap gap-4 p-0">
          {GOVERNANCE_KINDS.map((k) => (
            <li key={k} role="none">
              <Button
                role="menuitem"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setKind(k);
                  setMenu(false);
                  panel.show();
                }}
              >
                {t(`kinds.${k}`)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {panel.loaded ? (
        <panel.loaded.GovernanceDraftDialog
          key={panel.session}
          {...props}
          kind={kind}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}
