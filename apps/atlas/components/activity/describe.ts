"use client";

import type { ActivityEntry } from "@xos/data/activity";
import { useTranslations } from "next-intl";

/*
 * Its own module so the Home tiles can describe entries without loading the activity feed's table
 * and view code (A24-009).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** What an entry says: who, the verb, the thing it acted on, and the change and reason when known. */
export function useDescribe() {
  const a = useTranslations("activity") as unknown as Translate & { has: (k: string) => boolean };
  const p = useTranslations("projects") as unknown as Translate & { has: (k: string) => boolean };
  const state = (value: unknown) => {
    const text = String(value);
    return p.has(`states.${text}`)
      ? p(`states.${text}`)
      : p.has(`phases.${text}`)
        ? p(`phases.${text}`)
        : text;
  };
  return (entry: ActivityEntry) => {
    const [subject = "", verb = ""] = entry.type.split(".");
    const action = a.has(`verbs.${verb}`) ? a(`verbs.${verb}`) : a("verbs.fallback");
    const noun = a.has(`subjects.${subject}`) ? a(`subjects.${subject}`) : a("subjects.fallback");
    const named = entry.data["criterion_id"] ?? entry.data["scope_code"];
    const criterion = typeof named === "string" ? named : null;
    const target = entry.recordKey
      ? `${entry.recordKey} ${entry.recordTitle ?? ""}`.trim()
      : subject === "project" && entry.project
        ? `${entry.project.key} ${entry.project.name}`
        : criterion && entry.project
          ? `${criterion} · ${entry.project.key}`
          : entry.project
            ? `${noun} · ${entry.project.key}`
            : noun;
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
      target,
      comment: parts.length > 0 ? parts.join(" · ") : undefined,
    };
  };
}
