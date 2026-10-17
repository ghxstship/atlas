"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { Alert } from "@/lib/home/data";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The text of an alert, from the catalog. Its own module so the Home tiles can use it without
 * loading the Home views and their table and chart code (A24-009).
 */
export function useAlertText() {
  const t = useTranslations("home.alerts") as unknown as Translate;
  const format = useFormatter();
  return (a: Alert) => {
    const values = { ...a.values };
    if (a.kind === "gateGap" || a.kind === "overdue") {
      const raw = String(values["date"] ?? "");
      if (raw) {
        values["date"] = format.dateTime(new Date(raw.length === 10 ? `${raw}T00:00:00` : raw), {
          dateStyle: "medium",
        });
      }
    }
    return t(a.kind, values);
  };
}
