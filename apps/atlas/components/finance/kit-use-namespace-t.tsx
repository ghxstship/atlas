"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { type Translate } from "./kit.types";

/** A translator for one of A15's namespaces, with `has` for keys computed at runtime. */
export function useNamespaceT(namespace: "finance" | "reports"): Translate {
  const t = useTranslations(namespace);
  return useMemo(() => {
    const call = t as unknown as (k: string, v?: Record<string, string | number>) => string;
    const has = (t as unknown as { has: (k: string) => boolean }).has;
    return Object.assign(
      (key: string, values?: Record<string, string | number>) => call(key, values),
      { has: (key: string) => has(key) },
    );
  }, [t]);
}
