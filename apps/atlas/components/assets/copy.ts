"use client";

import { useTranslations } from "next-intl";

/** A translator over the `assets` namespace for keys built at runtime (state and rule names). */
export type AssetsTranslate = (key: string, values?: Record<string, string | number>) => string;

export function useAssetsCopy(): AssetsTranslate {
  const t = useTranslations("assets");
  return (key, values) => (t as unknown as AssetsTranslate)(key, values);
}
