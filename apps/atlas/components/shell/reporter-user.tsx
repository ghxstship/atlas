"use client";

import { setReporterUser } from "@xos/infra/observability/browser";
import { useEffect } from "react";

/**
 * Names the signed-in person on browser error reports (ADR 0025) by their person id, never their
 * email, and clears it when the shell unmounts, such as on sign-out.
 */
export function ReporterUser({ personId }: { personId: string | null }) {
  useEffect(() => {
    setReporterUser(personId ?? undefined);
    return () => setReporterUser(undefined);
  }, [personId]);
  return null;
}
