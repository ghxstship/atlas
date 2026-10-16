"use client";

/**
 * The client boundary for @xos/ui. Its components use hooks and context, so server components
 * import them from here, never from "@xos/ui" directly.
 */
import type { ThemePreference } from "@xos/ui";
import { SegmentedControl, applyTheme } from "@xos/ui";
import { useEffect, useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme.ts";

export {
  AppShell,
  Breadcrumbs,
  Card,
  InlineAlert,
  Link,
  Sidebar,
  Tag,
  TemplateDocument,
  XOSProvider,
} from "@xos/ui";

type Preference = "system" | "light" | "dark";

/** In-memory copy, so the switch still works when storage is blocked. */
let current: Preference | null = null;
const listeners = new Set<() => void>();

function readPreference(): Preference {
  if (current) return current;
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    current = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch (error) {
    // Storage can be blocked (private windows, strict settings); follow the system theme then.
    console.warn("Theme preference unavailable", error);
    current = "system";
  }
  return current;
}

function writePreference(next: Preference): void {
  current = next;
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    console.warn("Theme preference not saved", error);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** System, Light or Dark; remembered in this browser and applied before paint by THEME_SCRIPT. */
export function ThemeSwitch({
  label,
  labels,
}: {
  label: string;
  labels: Readonly<Record<Preference, string>>;
}) {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  useEffect(() => applyTheme(preference as ThemePreference), [preference]);
  return (
    <SegmentedControl
      label={label}
      value={preference}
      options={(["system", "light", "dark"] as const).map((value) => ({
        value,
        label: labels[value],
      }))}
      onChange={(value) => writePreference(value as Preference)}
    />
  );
}
