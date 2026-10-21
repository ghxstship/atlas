"use client";

import { Kbd } from "@xos/ui";
import { useTranslations } from "next-intl";
import type { ShellKeys } from "@/lib/shell/shell-keys";

/**
 * The shell's key handler (key-dispatch.ts) and the G hint, in the module the shell frame loads once
 * it has hydrated (ADR 0027).
 */
export { installShellKeys, type KeyHandlers, type KeyState } from "./key-dispatch";

/**
 * The hint while a sequence waits: the keys that can follow and where each goes. It never takes
 * focus. Screen readers hear one sentence; the full list is the shortcut sheet in Help.
 */
export function GoHint({ keys, prefix }: { readonly keys: ShellKeys; readonly prefix: string }) {
  const t = useTranslations("shell.keys");
  const next = Object.entries(keys.go).flatMap(([id, target]) => {
    if (!keys.global[id]?.startsWith(`${prefix} `)) return [];
    const shown = (keys.display[id] ?? "").split(" ");
    return [{ id, key: shown[shown.length - 1] ?? "", label: target.label }];
  });
  return (
    <div className="pointer-events-none fixed inset-x-16 bottom-24 z-popover flex justify-center max-md:bottom-[calc(var(--ui-bottom-bar)+var(--space-16))]">
      <div
        role="status"
        data-go-hint=""
        className="max-w-layout-form rounded-card border border-border-subtle bg-bg-raised px-12 py-8 text-text-12 shadow-menu"
      >
        <p className="m-0 mb-6 font-medium text-text-primary">{t("goHint", { key: prefix })}</p>
        <ul
          aria-hidden="true"
          className="m-0 flex list-none flex-wrap gap-x-12 gap-y-4 p-0 text-text-secondary"
        >
          {next.map((n) => (
            <li key={n.id} className="inline-flex items-center gap-4">
              <Kbd>{n.key}</Kbd>
              {n.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
