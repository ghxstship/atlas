"use client";

import { useTranslations } from "next-intl";
import type { Copy } from "@/lib/collection-kit/i18n";

/** The client twin of getCopy: a translator for one namespace with runtime keys. */
export function useCopy(namespace: string): Copy {
  return useTranslations(namespace as never) as unknown as Copy;
}
