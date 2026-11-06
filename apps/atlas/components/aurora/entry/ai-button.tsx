"use client";

import type { AiFeature } from "@xos/data/ai";
import { Button } from "@xos/ui";
import { useState } from "react";
import { onDemand, useOnDemand, type OnDemand } from "@/components/shell/on-demand";
import { useAiFeature } from "@/components/aurora/ai-features";

export { onDemand };

/**
 * The button of an Aurora entry point (A95, finding A65-020). It renders nothing while the feature's
 * switch is off or the plan lacks Aurora, so the route ships only this button and the panel's code
 * loads the first time someone points at it or opens it (ADR 0027, route budget 200 KB).
 */
export function AiButton({
  feature,
  label,
  onOpen,
  onPreload,
  size = "sm",
  variant = "secondary",
}: {
  feature: AiFeature;
  label: string;
  onOpen: () => void;
  onPreload: () => void;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
}) {
  const on = useAiFeature(feature);
  if (!on) return null;
  return (
    <Button
      type="button"
      icon="Sparkles"
      size={size}
      variant={variant}
      data-ai-entry={feature}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onClick={onOpen}
    >
      {label}
    </Button>
  );
}

/**
 * Open state of an entry point's panel, and its module once the person first opens it. `session`
 * changes on every opening: the panel is keyed by it, so each opening starts from a clean state.
 */
export function useEntryPanel<T>(module: OnDemand<T>) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const loaded = useOnDemand(module, session > 0);
  return {
    open,
    setOpen,
    loaded,
    session,
    show: () => {
      setSession((s) => s + 1);
      setOpen(true);
    },
    preload: () => void module.load().catch(() => undefined),
  };
}
