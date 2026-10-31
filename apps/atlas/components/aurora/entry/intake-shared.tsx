"use client";

import type {
  AuroraClient,
  AuroraProblem,
  AuroraSuggestion,
  AuroraSuggestionField,
} from "@xos/ai/client";
import { Checkbox, InlineAlert } from "@xos/ui";
import { useEffect, useState } from "react";
import { problemKey, type Translate } from "./shared";

/**
 * What the B15 intake and drafting panels share (RRR-239): files and project inbox messages as
 * sources, the allowance left this month, per-rule problem sentences, and the proposed fields of a
 * stored suggestion. Loaded only with a panel, never with the page.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_INTAKE_FILES = 25;
const MEDIA = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"] as const;
export type Media = (typeof MEDIA)[number];

/** A verified project inbox message a person may pick as a source (no body is sent to the page). */
export interface InboxSource {
  readonly id: string;
  readonly subject: string | null;
  readonly fromAddress: string;
  readonly receivedAt: string;
}

export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A file as aurora.extract and aurora.draft take it. */
export async function fileSource(file: File) {
  const media: Media = (MEDIA as readonly string[]).includes(file.type)
    ? (file.type as Media)
    : "text/plain";
  return { media_type: media, content_base64: await toBase64(file), file_name: file.name };
}

/** Requests left this month, or null when the plan sets no limit. */
export function useRequestsLeft(client: AuroraClient, open: boolean) {
  const [left, setLeft] = useState<{ left: number | null; allowance: number | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.status().then((s) => {
      if (!live || !s.ok) return;
      setLeft({
        allowance: s.data.allowance,
        left: s.data.allowance === null ? null : Math.max(0, s.data.allowance - s.data.used),
      });
    });
    return () => {
      live = false;
    };
  }, [client, open]);
  return left;
}

/** The B15 refusal rules with their own sentence in the catalog (entry.rules). */
const RULES = new Set([
  "aurora_intake_closed",
  "aurora_intake_full",
  "aurora_intake_item_invalid",
  "ai_suggestion_batch_apply",
  "itinerary_duplicate",
  "intake_fee_restricted",
  "intake_group_party",
  "aurora_invoice_not_proposed",
  "aurora_draft_source_invalid",
  "aurora_extract_source",
  "aurora_field_restricted",
  "advance_section_not_draftable",
  "advance_answer_pending",
  "sod_advance_submitter",
  "plan_limit_exceeded",
]);

/** The plain sentence for a problem: the rule's own sentence when it has one, with the database's detail. */
export function problemSentence(t: Translate, problem: AuroraProblem): string {
  if (problem.rule && RULES.has(problem.rule)) {
    return t(`rules.${problem.rule}`, { detail: problem.detail });
  }
  return t(problemKey(problem), { detail: problem.detail });
}

export function ProblemAlert({ t, problem }: { t: Translate; problem: AuroraProblem | null }) {
  if (!problem) return null;
  return <InlineAlert tone="danger">{problemSentence(t, problem)}</InlineAlert>;
}

/** A proposed field of a stored suggestion. */
export function fieldOf(
  suggestion: AuroraSuggestion,
  path: string,
): AuroraSuggestionField | undefined {
  return suggestion.proposed_fields.find((f) => f.field_path === path);
}

/** A proposed value as text, or "" when it is NO_ANSWER or absent. */
export function textOf(suggestion: AuroraSuggestion, path: string): string {
  const f = fieldOf(suggestion, path);
  if (!f || f.refusal !== null || f.proposed_value === null || f.proposed_value === undefined)
    return "";
  return String(f.proposed_value);
}

/** Inbox messages to pick from, with a checkbox each. */
export function InboxPicker({
  t,
  messages,
  picked,
  onChange,
  multiple,
}: {
  t: Translate;
  messages: readonly InboxSource[];
  picked: readonly string[];
  onChange: (ids: string[]) => void;
  multiple: boolean;
}) {
  if (messages.length === 0) {
    return <p className="m-0 text-text-12 text-text-secondary">{t("intake.inboxEmpty")}</p>;
  }
  return (
    <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
      <legend className="mb-4 text-text-13 font-medium">{t("intake.inbox")}</legend>
      {messages.map((m) => (
        <Checkbox
          key={m.id}
          label={t("intake.inboxItem", {
            subject: m.subject ?? t("intake.noSubject"),
            from: m.fromAddress,
          })}
          checked={picked.includes(m.id)}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            onChange(
              on ? (multiple ? [...picked, m.id] : [m.id]) : picked.filter((id) => id !== m.id),
            );
          }}
        />
      ))}
    </fieldset>
  );
}

/** Major units in a currency, from minor units, for a hint. */
export function formatMinor(minor: number | null, currency: string, locale: string): string {
  if (minor === null) return "";
  try {
    const exponent =
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      minor / 10 ** exponent,
    );
  } catch {
    return String(minor);
  }
}
