"use client";

import type { AuroraClient, AuroraOpenProposal, AuroraProblem } from "@xos/ai/client";
import { InlineAlert, Tag } from "@xos/ui";
import { useEffect, useState } from "react";
import { problemKey, type Translate } from "./shared";

/**
 * What the B15 intake panels share (RRR-239): files read at concurrency 2 and metered per file, the
 * allowance left this month, per-rule problem sentences, and the proposed fields of an open proposal.
 * Loaded only with a panel, never with the page.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_INTAKE_FILES = 25;
const MEDIA = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"] as const;
export type Media = (typeof MEDIA)[number];

export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A file as aurora.extract and aurora.draftAdvanceAnswers take it. */
export async function fileSource(file: File) {
  const media: Media = (MEDIA as readonly string[]).includes(file.type)
    ? (file.type as Media)
    : "text/plain";
  return { media_type: media, content_base64: await toBase64(file), file_name: file.name };
}

/** Requests left this month, or null when the plan sets no limit. */
export function useRequestsLeft(client: AuroraClient, open: boolean) {
  const [left, setLeft] = useState<{ left: number | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.status().then((s) => {
      if (!live || !s.ok) return;
      setLeft({
        left: s.data.allowance === null ? null : Math.max(0, s.data.allowance - s.data.used),
      });
    });
    return () => {
      live = false;
    };
  }, [client, open]);
  return left;
}

/** Runs a task per item at most `limit` at a time; a failed one does not stop the rest. */
export async function atConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type FileStatus = "waiting" | "reading" | "read" | "failed";

/** One line per file: the per-file status a multi-file send shows. */
export function FileStatusList({
  t,
  files,
  statuses,
}: {
  t: Translate;
  files: readonly File[];
  statuses: readonly FileStatus[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label={t("intake.fileStatusLabel")}>
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className="flex flex-wrap items-center gap-8 text-text-13">
          <span>{f.name}</span>
          <Tag tone={statuses[i] === "failed" ? "danger" : statuses[i] === "read" ? "success" : "neutral"}>
            {t(`intake.fileStatus.${statuses[i] ?? "waiting"}`)}
          </Tag>
        </li>
      ))}
    </ul>
  );
}

/** The refusal rules with their own sentence in the catalog (entry.rules). */
const RULES = new Set([
  "aurora_intake_item_invalid",
  "aurora_intake_project_required",
  "aurora_itinerary_traveler",
  "aurora_invoice_currency",
  "aurora_invoice_lines_foreign",
  "aurora_advance_no_open_sections",
  "aurora_advance_source_empty",
  "aurora_advance_section_not_allowed",
  "advance_answer_pending",
  "invoice_locked",
  "sod_advance_submitter",
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

/** An open proposal's field. */
export function fieldOf(proposal: AuroraOpenProposal, path: string) {
  return proposal.proposed_fields.find((f) => f.field_path === path);
}

/** A proposed value as text, or "" when it is NO_ANSWER or absent. */
export function textOf(proposal: AuroraOpenProposal, path: string): string {
  const f = fieldOf(proposal, path);
  if (!f || f.refusal !== null || f.proposed_value === null || f.proposed_value === undefined) {
    return "";
  }
  return String(f.proposed_value);
}

/** A proposed money value in minor units, or null. */
export function minorOf(proposal: AuroraOpenProposal, path: string): number | null {
  const text = textOf(proposal, path);
  return text !== "" && Number.isInteger(Number(text)) ? Number(text) : null;
}

const exponentOf = (currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;

/** Major units in a currency, from minor units, for display. */
export function formatMinor(minor: number | null, currency: string, locale: string): string {
  if (minor === null) return "";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      minor / 10 ** exponentOf(currency),
    );
  } catch {
    return String(minor);
  }
}

/** A typed major-unit amount as minor units, by decimal text, or null. */
export function toMinor(text: string, currency: string): number | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  let exponent = 2;
  try {
    exponent = exponentOf(currency);
  } catch {
    exponent = 2;
  }
  const fraction = (match[2] ?? "").padEnd(exponent, "0").slice(0, exponent);
  return Number(`${match[1] ?? "0"}${fraction}`);
}

/** Minor units as the major-unit text an input takes. */
export function toMajorText(minor: number | null, currency: string): string {
  if (minor === null) return "";
  let exponent = 2;
  try {
    exponent = exponentOf(currency);
  } catch {
    exponent = 2;
  }
  if (exponent === 0) return String(minor);
  const text = String(minor).padStart(exponent + 1, "0");
  return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
}
