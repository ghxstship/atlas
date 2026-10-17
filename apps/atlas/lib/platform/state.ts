import type { DataError } from "@xos/data";

/**
 * Outcomes of A36's server actions (partner console, import wizard, custom objects, View as role,
 * org cancellation and Inbox). Forms show catalog copy under `platform.refusals` and
 * `platform.errors`, never a raw database message.
 */
export interface PlatformActionState {
  readonly ok?: boolean;
  /** Id of the row the action created or changed, or a value the form shows once (an invite link). */
  readonly id?: string;
  readonly value?: string;
  readonly rule?: string;
  readonly error?: "input" | "notFound" | "conflict" | "invalid" | "unexpected";
  readonly at?: number;
}

export const INITIAL_PLATFORM_STATE: PlatformActionState = {};

export function fromDataError(error: DataError): PlatformActionState {
  const at = Date.now();
  switch (error.kind) {
    case "refusal":
      return { rule: error.rule, at };
    case "not-found":
      return { error: "notFound", at };
    case "conflict":
      return { error: "conflict", at };
    case "invalid":
      return { error: "invalid", at };
    case "unexpected":
      console.error("platform action failed", error);
      return { error: "unexpected", at };
  }
}

export const inputError = (): PlatformActionState => ({ error: "input", at: Date.now() });
export const done = (id?: string, value?: string): PlatformActionState => ({
  ok: true,
  ...(id ? { id } : {}),
  ...(value ? { value } : {}),
  at: Date.now(),
});

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}
