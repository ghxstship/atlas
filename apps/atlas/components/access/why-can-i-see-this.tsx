"use client";

import type { AccessPath } from "@xos/data/access";
import { usePlatformT } from "@/components/platform/kit";

/**
 * Why can I see this (Section 8.4): the memberships, roles, grants, support sessions, delegations and
 * the read policy that give the viewer a record, most direct first. Collapsed until opened; null paths
 * mean the explanation could not be read, which is said plainly.
 */
export function WhyCanISeeThis({ paths }: { paths: readonly AccessPath[] | null }) {
  const t = usePlatformT();
  return (
    <details className="rounded-card border border-border-subtle p-12">
      <summary className="cursor-pointer text-text-13 font-medium">{t("access.why.title")}</summary>
      {paths === null ? (
        <p className="mt-8 mb-0 text-text-13 text-text-secondary">{t("access.why.error")}</p>
      ) : (
        <ul
          className="mt-8 mb-0 flex list-none flex-col gap-8 p-0"
          aria-label={t("access.why.title")}
        >
          {paths.map((p, i) => (
            <li key={`${p.kind}-${i}`} className="flex flex-col gap-2">
              <span className="text-text-12 font-medium text-text-secondary">
                {t(`access.why.kinds.${p.kind.replaceAll(" ", "")}`)}
              </span>
              <span className="text-text-13">{p.label}</span>
              {p.detail && p.kind !== "Policy" ? (
                <span className="text-text-12 text-text-secondary">{p.detail}</span>
              ) : null}
              {p.kind === "Policy" ? (
                <span className="text-text-12 text-text-secondary">
                  {t("access.why.policyHelp")}
                </span>
              ) : null}
              {p.validTo ? (
                <span className="text-text-12 text-text-tertiary">
                  {t("access.why.until", { when: new Date(p.validTo).toLocaleString() })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
