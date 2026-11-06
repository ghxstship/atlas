"use client";

import { useEffect } from "react";
import { type ActionState } from "@/app/[org]/finance/actions";
import { useQueryNav } from "./kit-use-query-nav";

/** After a successful recording: closes the sheet and carries a page-level notice in the query string. */
export function useAfterRecord(state: ActionState, changes: Readonly<Record<string, string | null>>) {
  const go = useQueryNav();
  useEffect(() => {
    if (state.ok) go(changes, true);
    // Runs once per completed submit; `at` changes on every submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.at]);
}
