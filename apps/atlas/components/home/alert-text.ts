"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { Alert } from "@/lib/home/data";
import { formatAlert } from "./format-alert";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The text of an alert, from the catalog, with dates on the org's calendar (`timeZone`, from the
 * server page's getOrgTimeZone). Its own module so the Home views can use it without loading the
 * Home tiles or the table and chart code (A24-009).
 */
export function useAlertText(timeZone: string) {
  const t = useTranslations("home.alerts") as unknown as Translate;
  const format = useFormatter();
  return (a: Alert) =>
    formatAlert(
      t,
      (date, zone) => format.dateTime(date, { dateStyle: "medium", timeZone: zone }),
      a,
      timeZone,
    );
}
