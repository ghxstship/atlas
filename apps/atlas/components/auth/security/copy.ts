"use client";

import { useTranslations } from "next-intl";

/** A translator for the authSecurity namespace (second factors, passkeys, step-up, single sign-on). */
export type SecurityCopy = (key: string, values?: Record<string, string | number>) => string;

export function useSecurityCopy(): SecurityCopy {
  const t = useTranslations("authSecurity");
  return (key, values) => (t as unknown as SecurityCopy)(key, values);
}

/** The sentence for an error key from the security actions. */
export function errorText(t: SecurityCopy, key: string): string {
  return t(`errors.${key}`);
}
