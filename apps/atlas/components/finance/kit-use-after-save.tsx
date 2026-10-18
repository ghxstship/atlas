"use client";

import { useEffect } from "react";
import { type ActionState } from "@/app/[org]/finance/actions";
import { useQueryNav } from "./kit-use-query-nav";

/** Closes the sheet and opens the new record's peek after a successful create. */
export function useAfterSave(state: ActionState, flag: string) {
  const go = useQueryNav();
  useEffect(() => {
    if (state.ok) go({ [flag]: null, ...(state.id ? { peek: state.id } : {}) }, true);
    // Runs once per completed submit; `at` changes on every submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.at]);
}
