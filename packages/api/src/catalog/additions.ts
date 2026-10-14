/**
 * Additive operations (Section 10.1 versioning: additive changes only within /v1).
 *
 * Each module declares operations beyond the frozen v1 catalog in its own file,
 * `src/catalog/modules/<module>.ts`, collected by the generated index next to it. A module may
 * add new resources and new actions on its own existing resources. It may never change or remove
 * an existing operation; `applyAdditions` refuses collisions and the contract tests compare every
 * frozen operation byte for byte (Section 18, gate 20).
 */
import type { CapabilityRule } from "./capabilities.ts";
import { RESOURCE_CAPABILITIES, canonRule } from "./capabilities.ts";
import type { ActionSpec, Module, ResourceSpec } from "./types.ts";

export interface ModuleAdditionsInput {
  /** New resources, each built with `resource()` and tagged with this module. */
  readonly resources?: readonly ResourceSpec[];
  /** New actions on existing resources of this module, keyed by the resource's `op`. */
  readonly actions?: Readonly<Record<string, readonly ActionSpec[]>>;
  /**
   * Capability rules keyed by `op` (see `catalog/capabilities.ts`): the full rule of a new
   * resource, or only `actions` capabilities for actions added to an existing resource.
   */
  readonly capabilities?: Readonly<Record<string, CapabilityRule>>;
}

export interface ModuleAdditions extends ModuleAdditionsInput {
  readonly module: Module;
}

export function defineAdditions<M extends Module>(
  module: M,
  additions: ModuleAdditionsInput = {},
): ModuleAdditions {
  return { module, ...additions };
}

function operationIds(spec: ResourceSpec): string[] {
  return [...spec.verbs, ...spec.actions.map((a) => a.verb)].map((v) => `${spec.op}.${v}`);
}

/**
 * The frozen catalog plus every module's additions. New resources come after the frozen ones,
 * in module order, so frozen operations keep their place in the document.
 */
export function applyAdditions(
  base: readonly ResourceSpec[],
  modules: readonly ModuleAdditions[],
): ResourceSpec[] {
  const specs = base.map((s) => ({ ...s }));
  const byOp = new Map(specs.map((s) => [s.op, s]));
  const paths = new Set(specs.map((s) => s.path));
  const ids = new Set(specs.flatMap(operationIds));
  const claim = (id: string, module: Module) => {
    if (ids.has(id))
      throw new Error(`${module} addition ${id} collides with an existing operation.`);
    ids.add(id);
  };
  const added: ResourceSpec[] = [];

  for (const m of modules) {
    for (const [op, actions] of Object.entries(m.actions ?? {})) {
      const target = byOp.get(op);
      if (target === undefined)
        throw new Error(`${m.module} adds actions to ${op}, which does not exist.`);
      if (target.module !== m.module) {
        throw new Error(`${m.module} adds actions to ${op}, which belongs to ${target.module}.`);
      }
      for (const a of actions) claim(`${op}.${a.verb}`, m.module);
      Object.assign(target, { actions: [...target.actions, ...actions] });
      const extra = m.capabilities?.[op];
      if (extra !== undefined) {
        const { actions: added, ...rest } = extra;
        if (Object.keys(rest).length > 0) {
          throw new Error(
            `${m.module} may only add action capabilities to ${op}, not change its rule.`,
          );
        }
        for (const verb of Object.keys(added ?? {})) {
          if (!actions.some((a) => a.verb === verb)) {
            throw new Error(
              `${m.module} sets a capability for ${op}.${verb}, which it does not add.`,
            );
          }
        }
        const current = target.capabilityRule ?? RESOURCE_CAPABILITIES[op] ?? canonRule(op) ?? {};
        Object.assign(target, {
          capabilityRule: { ...current, actions: { ...current.actions, ...added } },
        });
      }
    }
    for (const spec of m.resources ?? []) {
      if (spec.module !== m.module) {
        throw new Error(
          `${spec.op} is tagged ${spec.module} but declared in ${m.module}'s additions.`,
        );
      }
      if (byOp.has(spec.op))
        throw new Error(`${m.module} addition ${spec.op} names an existing resource.`);
      if (paths.has(spec.path))
        throw new Error(`${m.module} addition ${spec.path} reuses an existing path.`);
      for (const id of operationIds(spec)) claim(id, m.module);
      const rule = m.capabilities?.[spec.op];
      const withRule = rule === undefined ? spec : { ...spec, capabilityRule: rule };
      byOp.set(spec.op, withRule);
      paths.add(spec.path);
      added.push(withRule);
    }
    for (const op of Object.keys(m.capabilities ?? {})) {
      if (!(m.resources ?? []).some((s) => s.op === op) && !(op in (m.actions ?? {}))) {
        throw new Error(`${m.module} declares a capability rule for ${op}, which it does not add.`);
      }
    }
  }
  return [...specs, ...added];
}
