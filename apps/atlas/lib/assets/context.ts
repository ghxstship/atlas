import { listMembers, type DataError, type Result } from "@xos/data";
import {
  assetStateKey,
  listAssetConditions,
  listAssetProjects,
  listAssetTransitions,
  listAssetVenues,
  type AssetState,
} from "@xos/data/assets";
import { listEngagementOptions } from "@xos/data/project-people";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Shared reads for the assets pages: what the viewer may do and the pickers the forms offer. Row
 * level security still decides every read and write; these flags only hide controls a person
 * cannot use (Section 5, rule 1).
 */

export interface AssetCapabilities {
  readonly write: boolean;
  readonly custody: boolean;
  readonly maintenance: boolean;
  readonly damage: boolean;
  readonly writeOff: boolean;
}

export function assetCapabilities(ctx: OrgContext): AssetCapabilities {
  const has = (code: string) => ctx.capabilities.has(code);
  return {
    write: has("assets.asset.write"),
    custody: has("assets.custody.write"),
    maintenance: has("assets.maintenance.write"),
    damage: has("assets.damage.write"),
    writeOff: has("assets.write_off.approve"),
  };
}

export interface PickerOption {
  readonly value: string;
  readonly label: string;
}

/** An engagement a unit or lot quantity can go to, with its project for filtering (R1). */
export interface EngagementPickerOption extends PickerOption {
  readonly projectId: string;
}

export interface AssetPickers {
  readonly members: PickerOption[];
  readonly engagements: EngagementPickerOption[];
  readonly projects: PickerOption[];
  readonly venues: PickerOption[];
  readonly conditions: PickerOption[];
  readonly transitions: ReadonlyMap<AssetState, readonly AssetState[]>;
}

/** Throws on a failed read so the segment's error boundary shows the retry (Section 11.7). */
export function must<T>(result: Result<T>, what: string): T {
  if (result.ok) return result.data;
  throw new AssetLoadError(what, result.error);
}

export class AssetLoadError extends Error {
  constructor(
    what: string,
    readonly failure: DataError,
  ) {
    super(`Cannot load ${what}: ${JSON.stringify(failure)}`);
    this.name = "AssetLoadError";
  }
}

export async function loadPickers(ctx: OrgContext, unnamed: string): Promise<AssetPickers> {
  const db = ctx.viewer.db;
  const [members, engagements, projects, venues, conditions, transitions] = await Promise.all([
    listMembers(db, ctx.org.id),
    listEngagementOptions(db, { orgId: ctx.org.id }),
    listAssetProjects(db, ctx.org.id),
    listAssetVenues(db, ctx.org.id),
    listAssetConditions(db),
    listAssetTransitions(db),
  ]);
  return {
    members: must(members, "members").map((m) => ({
      value: m.membershipId,
      label: m.fullName ?? unnamed,
    })),
    engagements: must(engagements, "engagements").map((e) => ({
      value: e.engagementId,
      label: `${e.projectKey} ${e.personName ?? e.accountName ?? unnamed}`,
      projectId: e.projectId,
    })),
    projects: must(projects, "projects").map((p) => ({
      value: p.id,
      label: `${p.key} · ${p.name}`,
    })),
    venues: must(venues, "venues").map((v) => ({ value: v.id, label: v.name })),
    conditions: must(conditions, "conditions").map((c) => ({ value: c.id, label: c.label })),
    transitions: must(transitions, "transitions"),
  };
}

/** Catalog key of an asset state under `assets.states`. */
export function stateLabelKey(state: AssetState): string {
  return `assets.states.${assetStateKey(state)}`;
}
