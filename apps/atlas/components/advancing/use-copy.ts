"use client";

import { useTranslations } from "next-intl";

/** A client translator scoped to an Advancing namespace whose keys are computed at runtime. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "advancing");
  return (key, values) => (t as unknown as Translate)(key, values);
}
