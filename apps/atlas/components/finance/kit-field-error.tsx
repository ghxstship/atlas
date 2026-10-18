"use client";

import { type ActionState } from "@/app/[org]/finance/actions";
import { type Translate } from "./kit.types";

/** The catalog message for a field error, or the empty string. */
export function fieldError(t: Translate, state: ActionState, field: string): string {
  const key = state.fieldErrors?.[field];
  return key ? t(`errors.fields.${key}`) : "";
}
