import { useEffect, useState } from "react";
import { useCompass } from "../runtime/CompassProvider";

/**
 * The capabilities on the chosen project that decide which B8 controls Compass offers (ADR 0147): Override at the
 * gate (credentials.credential.issue) and Call hold and All clear on Weather (safety.incident.dispatch). Read online
 * once per project for the session (app.my_capabilities_on_project, 0470) and kept for it, so a device that goes
 * offline later still offers them. Without an answer (offline from the start) they are not offered. The server checks
 * each queued call again.
 */
export const PROJECT_CAPABILITIES = [
  "credentials.credential.issue",
  "safety.incident.dispatch",
] as const;

const cache = new Map<string, ReadonlySet<string>>();

/** The cached answer for a project, or null before one was read. */
export function cachedProjectCapabilities(projectId: string | null): ReadonlySet<string> | null {
  return projectId ? (cache.get(projectId) ?? null) : null;
}

/** Stores an answer for the session; exported for tests. */
export function rememberProjectCapabilities(
  projectId: string,
  held: readonly string[],
): ReadonlySet<string> {
  const set = new Set(held.filter((c) => (PROJECT_CAPABILITIES as readonly string[]).includes(c)));
  cache.set(projectId, set);
  return set;
}

export function useProjectCapabilities(projectId: string | null): ReadonlySet<string> | null {
  const { client } = useCompass();
  const [held, setHeld] = useState<ReadonlySet<string> | null>(() =>
    cachedProjectCapabilities(projectId),
  );
  useEffect(() => {
    if (!projectId) {
      setHeld(null);
      return;
    }
    const known = cache.get(projectId);
    if (known) {
      setHeld(known);
      return;
    }
    let live = true;
    void client
      .rpc("my_capabilities_on_project", {
        p_project_id: projectId,
        p_capabilities: [...PROJECT_CAPABILITIES],
      })
      .then(({ data, error }) => {
        if (!live || error || !Array.isArray(data)) return;
        setHeld(rememberProjectCapabilities(projectId, data as string[]));
      });
    return () => {
      live = false;
    };
  }, [client, projectId]);
  return held;
}
