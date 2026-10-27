"use client";

import type { ActivityEntry } from "@xos/data/activity";
import { useFormatter, useTranslations } from "next-intl";

/*
 * Its own module so the Home tiles can describe entries without loading the activity feed's table
 * and view code (A24-009).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface ActivityDescription {
  readonly actor: string;
  readonly action: string;
  /** What the entry acted on: the record's key and title, or the subject's own name (A59-030). */
  readonly target: string;
  /**
   * The target in pieces, joined it reads as `target`: each value (a key, a name, a role, a start) apart from the
   * separators between them, so a line shows each as its own text and the pseudo-locale check (gate 16) can tell
   * every piece is data. A value may hold a separator itself ("Head Arena / Festival Rigger").
   */
  readonly targetParts: readonly string[];
  /** The record the entry opens in the peek, when it acted on a record. */
  readonly recordKey: string | null;
  readonly comment: string | undefined;
}

/** What an entry says: who, the verb, the thing it acted on, and the change and reason when known. */
export function useDescribe() {
  const a = useTranslations("activity") as unknown as Translate & { has: (k: string) => boolean };
  const p = useTranslations("projects") as unknown as Translate & { has: (k: string) => boolean };
  const format = useFormatter();
  const state = (value: unknown) => {
    const text = String(value);
    return p.has(`states.${text}`)
      ? p(`states.${text}`)
      : p.has(`phases.${text}`)
        ? p(`phases.${text}`)
        : text;
  };
  return (entry: ActivityEntry): ActivityDescription => {
    const [subject = "", verb = ""] = entry.type.split(".");
    const action = a.has(`verbs.${verb}`) ? a(`verbs.${verb}`) : a("verbs.fallback");
    const noun = a.has(`subjects.${subject}`) ? a(`subjects.${subject}`) : a("subjects.fallback");
    const named = entry.data["criterion_id"] ?? entry.data["scope_code"];
    const criterion = typeof named === "string" ? named : null;
    const where = entry.project ? [" · ", entry.project.key] : [];
    const targetParts: string[] = entry.recordKey
      ? entry.recordTitle
        ? [entry.recordKey, " ", entry.recordTitle]
        : [entry.recordKey]
      : subject === "project" && entry.project
        ? [entry.project.key, " ", entry.project.name]
        : entry.subjectLabel
          ? [
              entry.subjectLabel,
              ...(entry.subjectAt
                ? [
                    " · ",
                    format.dateTime(new Date(entry.subjectAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  ]
                : []),
              ...where,
            ]
          : criterion && entry.project
            ? [criterion, " · ", entry.project.key]
            : [noun, ...where];
    const d = entry.data;
    const from = d["from_state"] ?? d["from_phase_code"];
    const to = d["to_state"] ?? d["to_phase_code"];
    const parts: string[] = [];
    if (from !== undefined && from !== null && to !== undefined && to !== null) {
      parts.push(a("feed.fromTo", { from: state(from), to: state(to) }));
    }
    if (typeof d["reason"] === "string" && d["reason"] !== "") {
      parts.push(a("feed.reason", { reason: d["reason"] }));
    }
    return {
      actor: entry.actor ?? a("feed.system"),
      action,
      target: targetParts.join(""),
      targetParts,
      recordKey: entry.recordKey,
      comment: parts.length > 0 ? parts.join(" · ") : undefined,
    };
  };
}

export interface CollapsedEntry {
  readonly entry: ActivityEntry;
  readonly description: ActivityDescription;
  /** How many identical events in a row this line stands for (A59-030). */
  readonly count: number;
}

/**
 * Folds runs of identical lines (same actor, verb, target and change, one after another) into one
 * line with a count, so three "changed the state of a shift" in a row read once (A59-030).
 */
export function collapseRepeats(
  entries: readonly ActivityEntry[],
  describe: (e: ActivityEntry) => ActivityDescription,
): CollapsedEntry[] {
  const out: CollapsedEntry[] = [];
  for (const entry of entries) {
    const description = describe(entry);
    const last = out[out.length - 1];
    const same =
      last &&
      last.description.actor === description.actor &&
      last.description.action === description.action &&
      last.description.target === description.target &&
      last.description.comment === description.comment;
    if (last && same) out[out.length - 1] = { ...last, count: last.count + 1 };
    else out.push({ entry, description, count: 1 });
  }
  return out;
}
