/**
 * Corrections to the frozen v1 contract (ADR 0023, amending ADR 0014).
 *
 * The v1 catalog was frozen in Wave 1 before most of the schema existed. While v1 is a draft
 * (`API_VERSION` 1.0.0-draft.N), a frozen operation or component may be corrected to match the
 * implemented schema, and only through a correction entry. Once 1.0.0 is released no entry may be
 * added: changes within `/v1` are additive only again (Section 10.1).
 *
 * Contract-wide corrections live in this file. A module's corrections live in its own module file,
 * `src/catalog/modules/<module>.ts`, next to its additive operations, so parallel branches never
 * edit one shared list (ADR 0021). `CORRECTIONS` in `src/app.ts` is the full, resolved list.
 *
 * Each entry names the resources (and any extra components) it changes, says what changes and why,
 * and carries the edit that makes the change. The Section 18 gate 20 test
 * (`test/corrections.test.ts`) fails on any change to a frozen operation or component that no entry
 * lists, and on an entry that changes nothing it lists.
 */
import { fields } from "@xos/schemas";
import { editShape, orNull } from "./correct.ts";
import type { Module, ResourceSpec } from "./types.ts";

/** The draft that introduced a correction. Released versions never take corrections. */
export type DraftVersion = `1.0.0-draft.${number}`;

/** A rule that selects resources, for a contract-wide correction. */
export interface ResourceSelector {
  /** The rule in words, for the machine-readable list and the ADR. */
  readonly where: string;
  readonly select: (spec: ResourceSpec) => boolean;
}

/** A correction as a module declares it; `defineAdditions` stamps the module. */
export interface CorrectionInput {
  /** Stable kebab-case identifier, unique across the contract. */
  readonly id: string;
  /** The `API_VERSION` draft in which the correction first appears. */
  readonly since: DraftVersion;
  /**
   * Resources (`op`) whose operations and generated components (read shape, create and update
   * bodies, page, action bodies) the correction changes. Removed operations count as changed.
   */
  readonly resources: readonly string[] | ResourceSelector;
  /** Other components the correction changes or adds, as `schemas/Name`. */
  readonly components?: readonly string[];
  /** What changes, in one or two sentences. */
  readonly change: string;
  /** Why: the schema fact that makes the frozen shape wrong, naming the table, view or migration. */
  readonly reason: string;
  /** The edit, applied to each selected resource in catalog order. */
  readonly apply: (spec: ResourceSpec) => ResourceSpec;
}

export interface Correction extends CorrectionInput {
  /** The module whose agent owns the corrected resources. */
  readonly module: Module;
  /** A correction that applies across modules (contract-wide rules in this file only). */
  readonly contractWide?: true;
}

/** A correction whose resources are resolved to a list of `op` names. */
export interface ResolvedCorrection extends Correction {
  readonly resources: readonly string[];
  /** The selection rule in words, for a contract-wide correction. */
  readonly where?: string;
}

/** Contract-wide corrections, applied before the module corrections. */
export const CONTRACT_CORRECTIONS: readonly Correction[] = [
  {
    id: "audit-columns-nullable",
    since: "1.0.0-draft.2",
    module: "Platform",
    contractWide: true,
    resources: {
      where: "every tenant resource (ADR 0002 audit columns)",
      select: (spec) => spec.def.base === "tenant",
    },
    change:
      "`created_by` and `updated_by` become nullable in every tenant read shape; null means a seed, platform or system process wrote the row.",
    reason:
      "The audit columns of every app table are nullable and stamped by `t90_stamp_audit_columns` (0200) from the session person, which seed, platform and system writes do not have.",
    apply: editShape({
      add: {
        created_by: {
          schema: orNull(
            fields.uuid(
              "Identifier of the person who created the row; null when a seed, platform or system process created it.",
            ),
          ),
        },
        updated_by: {
          schema: orNull(
            fields.uuid(
              "Identifier of the person who last updated the row; null when a seed, platform or system process updated it.",
            ),
          ),
        },
      },
    }),
  },
];

/**
 * Resolves selectors to resource lists and checks every entry: unique ids, resources that exist in
 * the frozen catalog, and module corrections that only touch their own module's resources.
 */
export function resolveCorrections(
  specs: readonly ResourceSpec[],
  corrections: readonly Correction[],
): ResolvedCorrection[] {
  const byOp = new Map(specs.map((s) => [s.op, s]));
  const ids = new Set<string>();
  return corrections.map((c) => {
    if (ids.has(c.id)) throw new Error(`Correction ${c.id} is listed twice.`);
    ids.add(c.id);
    const selector = Array.isArray(c.resources) ? undefined : (c.resources as ResourceSelector);
    const resources =
      selector === undefined
        ? (c.resources as readonly string[])
        : specs.filter(selector.select).map((s) => s.op);
    for (const op of resources) {
      const spec = byOp.get(op);
      if (spec === undefined) {
        throw new Error(`Correction ${c.id} names ${op}, which is not a frozen resource.`);
      }
      if (c.contractWide !== true && spec.module !== c.module) {
        throw new Error(
          `Correction ${c.id} (${c.module}) names ${op}, which belongs to ${spec.module}.`,
        );
      }
    }
    return { ...c, resources, ...(selector === undefined ? {} : { where: selector.where }) };
  });
}

/** The frozen catalog with every correction applied, in list order. */
export function applyCorrections(
  specs: readonly ResourceSpec[],
  corrections: readonly ResolvedCorrection[],
): ResourceSpec[] {
  return specs.map((spec) =>
    corrections.reduce((s, c) => (c.resources.includes(spec.op) ? c.apply(s) : s), spec),
  );
}
