/**
 * Emergency codes in Reference (WP18, migration 1612, decision D15). Each org holds an editable copy of every canon
 * code: it relabels, redescribes and reorders its copy, while the code word and the swatch stay canon's, because
 * crisis alerts and protocols name the code word. An org that holds no copies shows the canon codes, as Atlas does
 * (packages/data listEmergencyCodes).
 */

/** The org's copy of a canon code (local table emergency_codes), live rows only. */
export interface OrgEmergencyCodeRow {
  readonly id: string;
  readonly org_id: string;
  readonly code: string;
  readonly label: string;
  readonly emergency: string;
  readonly sort_order: number;
}

/** A canon code (local table canon_emergency_codes), keyed by its code word. */
export interface CanonEmergencyCodeRow {
  readonly id: string;
  readonly label: string;
  readonly emergency: string;
  readonly swatch: string;
  readonly sort_order: number;
}

export interface EmergencyCode {
  /** The org's row id, or the code word when the canon code is shown. */
  readonly key: string;
  readonly code: string;
  readonly label: string;
  readonly emergency: string;
  /** A swatch name such as ecode-red; the color only helps recognition, the code word is always written. */
  readonly swatch: string;
  readonly sortOrder: number;
}

/** The swatch of a code canon no longer lists. */
export const FALLBACK_SWATCH = "ecode-grey";

/** The theme color of a swatch: ecode-red is the token ecodeRed. */
export function swatchToken(swatch: string): string {
  const [, hue = ""] = /^ecode-([a-z]+)$/.exec(swatch) ?? [];
  return hue ? `ecode${hue.charAt(0).toUpperCase()}${hue.slice(1)}` : "ecodeGrey";
}

function byOrder(a: EmergencyCode, b: EmergencyCode): number {
  return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);
}

/**
 * The codes Reference lists for the active org: its own copies in their numeric order, each with its canon swatch,
 * or the canon codes when it holds none (an org that has not adopted the Standard Library, or a person who reads
 * Compass through an engagement rather than a membership).
 */
export function emergencyCodesFor(
  own: readonly OrgEmergencyCodeRow[],
  canon: readonly CanonEmergencyCodeRow[],
): EmergencyCode[] {
  if (own.length === 0)
    return canon
      .map((c) => ({
        key: c.id,
        code: c.id,
        label: c.label,
        emergency: c.emergency,
        swatch: c.swatch,
        sortOrder: c.sort_order,
      }))
      .sort(byOrder);
  const swatches = new Map(canon.map((c) => [c.id, c.swatch]));
  return own
    .map((r) => ({
      key: r.id,
      code: r.code,
      label: r.label,
      emergency: r.emergency,
      swatch: swatches.get(r.code) ?? FALLBACK_SWATCH,
      sortOrder: r.sort_order,
    }))
    .sort(byOrder);
}
