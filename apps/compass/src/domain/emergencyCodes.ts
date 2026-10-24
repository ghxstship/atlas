/**
 * Emergency codes in Reference (WP18, migration 1612, decision D15). Each org holds an editable copy of every canon
 * code: it relabels, redescribes and reorders its copy, while the code word and the swatch stay canon's, because
 * crisis alerts and protocols name the code word. Atlas lists the org's copies, or the canon codes while the org holds
 * none (packages/data listEmergencyCodes); Compass follows the same rule. A person the org engages without a
 * membership never receives the org's copies (row level security and the member-only scope rule), so they always see
 * the canon codes, and the screen says so.
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
  /**
   * A swatch name such as ecode-red, or null while the canon codes are not on the device. Never a stand-in color:
   * grey is Code Grey's own swatch.
   */
  readonly swatch: string | null;
  readonly sortOrder: number;
}

export interface EmergencyCodeList {
  readonly codes: EmergencyCode[];
  /** True when these are the canon codes because the device holds none of the org's own. */
  readonly standard: boolean;
}

/** The theme color of a swatch (ecode-red is the token ecodeRed), or null for a name that is not a swatch. */
export function swatchToken(swatch: string | null): string | null {
  const [, hue = ""] = /^ecode-([a-z]+)$/.exec(swatch ?? "") ?? [];
  return hue ? `ecode${hue.charAt(0).toUpperCase()}${hue.slice(1)}` : null;
}

/** The code word as it is said on the radio: CODE_RED is CODE RED. */
export function spokenCode(code: string): string {
  return code.replace(/_/g, " ");
}

/** Whether the card must write the code word itself, because the label does not already say it. */
export function needsCodeWord(code: string, label: string): boolean {
  const said = (s: string) =>
    s
      .replace(/[_\s]+/g, " ")
      .trim()
      .toLowerCase();
  return said(code) !== said(label);
}

/**
 * The canon rows an earlier build cached in the local emergency_codes table, with no org: the REST downloader stored
 * xpms.emergency_code whole with the code word as id, and the sync rule stored code AS id. Until this build downloads
 * canon_emergency_codes, they are the standard list an offline launch can show.
 */
function cachedCanon(rows: readonly OrgEmergencyCodeRow[]): CanonEmergencyCodeRow[] {
  return rows.flatMap((raw) => {
    const r = raw as unknown as Readonly<Record<string, unknown>>;
    if (typeof r["org_id"] === "string" && r["org_id"] !== "") return [];
    const id = typeof r["code"] === "string" ? r["code"] : r["id"];
    if (typeof id !== "string" || typeof r["label"] !== "string") return [];
    return [
      {
        id,
        label: r["label"],
        emergency: typeof r["emergency"] === "string" ? r["emergency"] : "",
        swatch: typeof r["swatch"] === "string" ? r["swatch"] : "",
        sort_order: Number(r["sort_order"] ?? 0),
      },
    ];
  });
}

function byOrder(a: EmergencyCode, b: EmergencyCode): number {
  return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);
}

/**
 * The codes Reference lists for the active org: its own copies in their numeric order, each with its canon swatch,
 * or the canon codes when it holds none. Rows without an org are canon rows an earlier build stored in the same table:
 * never the org's codes, but the standard list until the canon table is on the device.
 */
export function emergencyCodesFor(
  own: readonly OrgEmergencyCodeRow[],
  canon: readonly CanonEmergencyCodeRow[],
): EmergencyCodeList {
  const mine = own.filter((r) => typeof r.org_id === "string" && r.org_id !== "");
  // Before this build has downloaded the canon codes, the ones an earlier build cached stand in for them.
  const standard = canon.length > 0 ? canon : cachedCanon(own);
  if (mine.length === 0)
    return {
      standard: true,
      codes: standard
        .map((c) => ({
          key: c.id,
          code: c.id,
          label: c.label,
          emergency: c.emergency,
          swatch: c.swatch || null,
          sortOrder: c.sort_order,
        }))
        .sort(byOrder),
    };
  const swatches = new Map(standard.map((c) => [c.id, c.swatch]));
  return {
    standard: false,
    codes: mine
      .map((r) => ({
        key: r.id,
        code: r.code,
        label: r.label,
        emergency: r.emergency,
        swatch: swatches.get(r.code) ?? null,
        sortOrder: r.sort_order,
      }))
      .sort(byOrder),
  };
}
