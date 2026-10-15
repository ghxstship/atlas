"use client";

import { GateReadinessPanel, type GateReadinessPanelProps } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";

/** Gate readiness whose advance action opens the Gates tab, where the gate is passed with a reason. */
export function ReadinessPanel({
  href,
  ...props
}: Omit<GateReadinessPanelProps, "onAdvance" | "onCriterionAction"> & { href: string }) {
  const router = useRouter();
  return (
    <GateReadinessPanel
      {...props}
      onAdvance={() => router.push(href as Route)}
      onCriterionAction={() => router.push(href as Route)}
    />
  );
}
