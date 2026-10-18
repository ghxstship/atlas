/**
 * Section 18, gate 20: no breaking change to the frozen v1 contract (ADR 0014) except the
 * corrections listed while v1 is a draft (ADR 0023).
 *
 * 1. The uncorrected frozen catalog still generates the document frozen at Wave 1 exit, operation
 *    for operation and component for component (`src/catalog/frozen-v1.digest.json`).
 * 2. The corrected catalog differs from the freeze only in operations and components that a
 *    correction lists.
 * 3. Every correction changes each resource and component it lists.
 * 4. Corrections exist only while `API_VERSION` is a draft, and each names the draft it entered.
 */
import { describe, expect, it } from "vitest";
import { z } from "@hono/zod-openapi";
import {
  API_VERSION,
  CORRECTIONS,
  buildOpenApiDocument,
  frozenCatalog,
  uncorrectedFrozenCatalog,
} from "../src/app.ts";
import { digestDocument, readBaseline } from "../src/catalog/baseline.ts";
import type { DocumentDigest } from "../src/catalog/baseline.ts";
import { editShape, removeVerbs } from "../src/catalog/correct.ts";
import { CONTRACT_CORRECTIONS } from "../src/catalog/corrections.ts";
import type { ResolvedCorrection } from "../src/catalog/corrections.ts";
import { applyCorrections } from "../src/catalog/corrections.ts";
import { MODULE_ADDITIONS } from "../src/catalog/modules/index.generated.ts";
import type { ResourceSpec } from "../src/catalog/types.ts";
import { MODULES } from "../src/catalog/types.ts";

const baseline = readBaseline();
const uncorrected = digestDocument(buildOpenApiDocument(uncorrectedFrozenCatalog));
const corrected = digestDocument(buildOpenApiDocument(frozenCatalog));

function idOf(schema: z.ZodType | undefined): string | undefined {
  if (schema === undefined) return undefined;
  const id = z.globalRegistry.get(schema)?.["id"];
  return typeof id === "string" ? id : undefined;
}

/** The components a resource generates: its shapes, its page and its action bodies and results. */
function componentsOf(spec: ResourceSpec): string[] {
  const def = spec.def;
  const names = [idOf(def.read), idOf(def.create), idOf(def.update), `${def.name}Page`];
  for (const a of spec.actions) {
    names.push(idOf(a.body));
    const response = idOf(a.response);
    names.push(response);
    if (a.paged === true) names.push(`${response ?? def.name}Page`);
  }
  return names.filter((n): n is string => n !== undefined).map((n) => `schemas/${n}`);
}

/** Which resources own each component, across the uncorrected and corrected catalogs. */
const componentOwners = new Map<string, Set<string>>();
for (const spec of [...uncorrectedFrozenCatalog, ...frozenCatalog]) {
  for (const c of componentsOf(spec)) {
    const owners = componentOwners.get(c) ?? new Set<string>();
    owners.add(spec.op);
    componentOwners.set(c, owners);
  }
}

function changedKeys(before: DocumentDigest, after: DocumentDigest): string[] {
  const keys: string[] = [];
  for (const [key, op] of Object.entries(before.operations)) {
    if (after.operations[key]?.sha256 !== op.sha256) keys.push(`${key} ${op.operationId}`);
  }
  for (const [key, op] of Object.entries(after.operations)) {
    if (before.operations[key] === undefined) keys.push(`${key} ${op.operationId}`);
  }
  for (const [key, hash] of Object.entries(before.components)) {
    if (after.components[key] !== hash) keys.push(key);
  }
  for (const key of Object.keys(after.components)) {
    if (before.components[key] === undefined) keys.push(key);
  }
  return keys;
}

/** The resources that own a changed operation (`METHOD /path op.verb`) or component. */
function ownersOf(key: string): string[] {
  if (key.startsWith("schemas/") || !key.includes(" "))
    return [...(componentOwners.get(key) ?? [])];
  const operationId = key.split(" ")[2] as string;
  return [operationId.split(".")[0] as string];
}

/** Changes from the freeze in `specs` that no correction in `corrections` lists. */
function unlistedChanges(
  specs: readonly ResourceSpec[],
  corrections: readonly ResolvedCorrection[],
): string[] {
  const listedResources = new Set(corrections.flatMap((c) => c.resources));
  const listedComponents = new Set(corrections.flatMap((c) => c.components ?? []));
  const after = specs === frozenCatalog ? corrected : digestDocument(buildOpenApiDocument(specs));
  return changedKeys(baseline, after).filter(
    (key) => !listedComponents.has(key) && !ownersOf(key).some((op) => listedResources.has(op)),
  );
}

/** Frozen operations and components that `specs`, uncorrected, no longer generate as frozen. */
function drift(specs: readonly ResourceSpec[]): string[] {
  const digest =
    specs === uncorrectedFrozenCatalog ? uncorrected : digestDocument(buildOpenApiDocument(specs));
  return [
    ...Object.entries(baseline.operations)
      .filter(([key, op]) => digest.operations[key]?.sha256 !== op.sha256)
      .map(([key, op]) => `${key} ${op.operationId}`),
    ...Object.entries(baseline.components)
      .filter(([key, hash]) => digest.components[key] !== hash)
      .map(([key]) => key),
  ];
}

/**
 * Components whose content changes between two single-resource documents. A shared component that
 * only appears or disappears there (a field that references it was added or removed) is unchanged
 * in the full document, which `unlistedChanges` checks.
 */
function componentDiff(before: DocumentDigest, after: DocumentDigest): string[] {
  return Object.entries(before.components)
    .filter(([k, hash]) => after.components[k] !== undefined && after.components[k] !== hash)
    .map(([k]) => k);
}

/**
 * Applies each correction in order to the resources it lists, each resource in a document of its
 * own, and reports what the step changes: resources it leaves unchanged, and components it changes
 * that are neither generated by the resource nor listed in `components`. A shared component counts
 * only when it also changed in the full document `full`: in a one-resource document the generator
 * may render a shared component from that resource's reference alone.
 */
function attribute(corrections: readonly ResolvedCorrection[], full: DocumentDigest = corrected) {
  const state = new Map(uncorrectedFrozenCatalog.map((s) => [s.op, s]));
  const inert: string[] = [];
  const unlisted: string[] = [];
  const fullChanges = new Set<string>(changedKeys(baseline, full));
  const changedComponents = new Set<string>(fullChanges);
  for (const c of corrections) {
    for (const op of c.resources) {
      const before = state.get(op) as ResourceSpec;
      const after = c.apply(before);
      state.set(op, after);
      const d0 = digestDocument(buildOpenApiDocument([before]));
      const d1 = digestDocument(buildOpenApiDocument([after]));
      const keys = changedKeys(d0, d1);
      if (keys.length === 0) inert.push(`${c.id}: ${op}`);
      const own = new Set([...componentsOf(before), ...componentsOf(after)]);
      for (const k of componentDiff(d0, d1)) {
        changedComponents.add(k);
        if (!own.has(k) && fullChanges.has(k) && !(c.components ?? []).includes(k)) {
          unlisted.push(`${c.id}: ${k}`);
        }
      }
    }
    for (const k of c.components ?? []) {
      if (!changedComponents.has(k)) inert.push(`${c.id}: ${k}`);
    }
  }
  return { inert, unlisted };
}

let attribution: ReturnType<typeof attribute> | undefined;
function attributed(): ReturnType<typeof attribute> {
  attribution ??= attribute(CORRECTIONS);
  return attribution;
}

describe("gate 20: the frozen v1 contract", () => {
  it("still generates the document frozen at Wave 1 exit before corrections", () => {
    expect(Object.keys(baseline.operations)).toHaveLength(1307);
    expect(drift(uncorrectedFrozenCatalog), "frozen sources changed outside a correction").toEqual(
      [],
    );
  });

  it("fails when a frozen source changes or loses an operation", () => {
    const loosen = editShape({ nullable: ["counterparty_type"] });
    const edited = uncorrectedFrozenCatalog.map((s) => (s.op === "vendors" ? loosen(s) : s));
    expect(drift(edited)).toContain("schemas/Vendor");
    const removed = uncorrectedFrozenCatalog.map((s) =>
      s.op === "vendors" ? removeVerbs("delete")(s) : s,
    );
    expect(drift(removed)).toContain("DELETE /vendors/{id} vendors.delete");
  });

  it("changes a frozen operation or component only where a correction lists it", () => {
    expect(
      unlistedChanges(frozenCatalog, CORRECTIONS),
      "changes that no correction in src/catalog lists",
    ).toEqual([]);
    expect(attributed().unlisted, "components changed but not listed").toEqual([]);
    // Rebuilds the document once per correction; CI runners under coverage take several times longer.
  }, 180_000);

  it("fails on a correction that changes a shared component it does not list", () => {
    const polluting: ResolvedCorrection = {
      id: "sample-shared-component",
      since: "1.0.0-draft.2",
      module: "Vendors",
      resources: ["vendors"],
      change: "Wraps a shared component in nullable, which rewrites the component itself.",
      reason: "A sample correction that changes a component outside its resource.",
      apply: (spec) => ({
        ...spec,
        def: {
          ...spec.def,
          read: z
            .object({
              ...(spec.def.read.shape as Record<string, z.ZodType>),
              counterparty_type: (spec.def.read.shape as Record<string, z.ZodType>)[
                "counterparty_type"
              ]?.nullable() as z.ZodType,
            })
            .meta(z.globalRegistry.get(spec.def.read) ?? {}),
        },
      }),
    };
    const full = digestDocument(
      buildOpenApiDocument(applyCorrections(uncorrectedFrozenCatalog, [polluting])),
    );
    expect(attribute([polluting], full).unlisted).toContain(
      "sample-shared-component: schemas/CounterpartyType",
    );
  });

  it("lists only corrections that change what they name", () => {
    expect(attributed().inert, "corrections that change nothing they list").toEqual([]);
  });
});

describe("contract corrections (ADR 0023)", () => {
  const draft = /^1\.0\.0-draft\.(\d+)$/;

  it("exist only while v1 is a draft, each dated by the draft it entered", () => {
    const current = draft.exec(API_VERSION);
    if (current === null) {
      // Released: the baseline is re-cut from the released document and the list starts empty.
      expect(CORRECTIONS).toEqual([]);
      return;
    }
    for (const c of CORRECTIONS) {
      const since = draft.exec(c.since);
      expect(since, c.id).not.toBeNull();
      expect(Number(since?.[1]), c.id).toBeLessThanOrEqual(Number(current[1]));
    }
  });

  it("are well formed: unique ids, a change and a reason, owned by one module", () => {
    const ids = CORRECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CORRECTIONS) {
      expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.change.length, c.id).toBeGreaterThan(20);
      expect(c.reason.length, c.id).toBeGreaterThan(40);
      expect(c.reason, c.id).toMatch(/\.$/);
      expect(c.resources.length, c.id).toBeGreaterThan(0);
      expect(MODULES).toContain(c.module);
      for (const component of c.components ?? []) expect(component).toMatch(/^schemas\/[A-Z]/);
    }
    for (const c of CONTRACT_CORRECTIONS) expect(c.contractWide, c.id).toBe(true);
    for (const m of MODULE_ADDITIONS) {
      for (const c of m.corrections) {
        expect(c.module, c.id).toBe(m.module);
        expect(c.contractWide, c.id).toBeUndefined();
      }
    }
  });

  it("apply in order: contract-wide entries, then modules in catalog order", () => {
    const expected = [
      ...CONTRACT_CORRECTIONS.map((c) => c.id),
      ...MODULE_ADDITIONS.flatMap((m) => m.corrections.map((c) => c.id)),
    ];
    expect(CORRECTIONS.map((c) => c.id)).toEqual(expected);
  });
});
