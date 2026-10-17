/**
 * The forced update check (Section 5.1, journey 40): at launch Compass compares its native build with the
 * minimum the server advertises (api_public.client_minimum_version). Below it, a blocking screen sends the
 * person to update. Offline first: when the server cannot answer, the last advertised floor decides, and
 * with none known nothing blocks.
 */

/** MAJOR.MINOR.PATCH as numbers, or null for anything else. */
export function parseVersion(v: string): readonly [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, zero when equal, positive when newer; null when either is malformed. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export interface MinimumVersion {
  readonly minimumVersion: string;
  readonly updateUrl: string | null;
}

/**
 * True when this build must update before it runs. A malformed build or floor never blocks: a typo in
 * the floor must not lock every crew member out of their schedule.
 */
export function mustUpdate(current: string, floor: MinimumVersion | null): boolean {
  if (!floor) return false;
  const order = compareVersions(current, floor.minimumVersion);
  return order !== null && order < 0;
}

/** Reads a floor cached as JSON on the device; anything unreadable counts as none. */
export function parseCachedFloor(raw: string | null): MinimumVersion | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { minimumVersion?: unknown; updateUrl?: unknown };
    if (typeof value.minimumVersion !== "string" || !parseVersion(value.minimumVersion))
      return null;
    return {
      minimumVersion: value.minimumVersion,
      updateUrl: typeof value.updateUrl === "string" ? value.updateUrl : null,
    };
  } catch {
    return null;
  }
}
