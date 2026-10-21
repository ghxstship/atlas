"use client";

import { createContext, useContext } from "react";
import type { ShellKeys } from "@/lib/shell/shell-keys";

const NONE: ShellKeys = {
  platform: "other",
  global: {},
  scoped: {},
  fields: [],
  go: {},
  display: {},
};

/**
 * The person's keyboard shortcuts (lib/shell/shell-keys.ts), provided by the shell frame to the parts
 * of a page that answer keys or show them: the Inbox list, the shortcut sheet in Help.
 */
export const ShellKeysContext = createContext<ShellKeys>(NONE);

export function useShellKeys(): ShellKeys {
  return useContext(ShellKeysContext);
}
