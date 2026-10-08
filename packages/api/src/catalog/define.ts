/**
 * Helpers that keep the catalog declarative: one call per resource, one call per action.
 */
import { z } from "@hono/zod-openapi";
import type { ResourceDefinition } from "@xos/schemas";
import type { ActionSpec, Module, OrderSpec, ResourceSpec, Verb } from "./types.ts";

export interface ResourceOptions {
  readonly verbs?: readonly Verb[];
  readonly actions?: readonly ActionSpec[];
  readonly order?: OrderSpec;
  readonly op?: string;
  readonly label?: string;
  readonly keyParam?: string;
}

export function camelFromPath(path: string): string {
  const words = path
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("{"))
    .flatMap((s) => s.split("-"));
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

export function labelFromName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

function defaultVerbs(def: ResourceDefinition): readonly Verb[] {
  switch (def.base) {
    case "canon":
      return ["list", "get"];
    case "view":
      return ["list"];
    default:
      return ["list", "get", "create", "update", "delete"];
  }
}

function defaultOrder(def: ResourceDefinition): OrderSpec {
  if (def.base === "canon") return { by: [def.key], numeric: false };
  if (def.base === "view") return { by: Object.keys(def.read.shape).slice(0, 1), numeric: false };
  return { by: ["created_at"], numeric: false };
}

export function resource(
  module: Module,
  path: string,
  def: ResourceDefinition,
  options: ResourceOptions = {},
): ResourceSpec {
  return {
    module,
    path,
    def,
    op: options.op ?? camelFromPath(path),
    label: options.label ?? labelFromName(def.name),
    verbs: options.verbs ?? defaultVerbs(def),
    actions: options.actions ?? [],
    order: options.order ?? defaultOrder(def),
    keyParam: options.keyParam ?? (def.key === "" ? "id" : def.key),
  };
}

/** A coded list that always returns in numeric code order (Section 3.6). */
export function numericOrder(
  by: readonly string[],
  examples: readonly Readonly<Record<string, string | number>>[],
): OrderSpec {
  return { by, numeric: true, examples };
}

interface ActionInput {
  readonly summary: string;
  readonly description: string;
  readonly body?: z.ZodType;
  readonly query?: z.ZodObject;
  readonly response?: z.ZodType;
  readonly status?: 200 | 201 | 202;
  readonly paged?: boolean;
  readonly segment?: string;
}

function kebab(verb: string): string {
  return verb.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** A POST on one item, such as `/purchase-orders/{id}/approve`. */
export function itemAction(verb: string, input: ActionInput): ActionSpec {
  return { verb, segment: input.segment ?? kebab(verb), scope: "item", method: "post", ...input };
}

/** A POST on the collection, such as `/posting-lines/exports`. */
export function collectionAction(verb: string, input: ActionInput): ActionSpec {
  return {
    verb,
    segment: input.segment ?? kebab(verb),
    scope: "collection",
    method: "post",
    ...input,
  };
}

/** A GET query on the collection, such as a report or a resolver. */
export function collectionQuery(verb: string, input: ActionInput): ActionSpec {
  return {
    verb,
    segment: input.segment ?? kebab(verb),
    scope: "collection",
    method: "get",
    ...input,
  };
}

/** A GET query on one item, such as `/budgets/{id}/summary`. */
export function itemQuery(verb: string, input: ActionInput): ActionSpec {
  return { verb, segment: input.segment ?? kebab(verb), scope: "item", method: "get", ...input };
}

/** Request body of a lifecycle transition with compare-and-set on the expected state. */
export function transitionBody(id: string, state: z.ZodType, example: [string, string]) {
  return z
    .object({
      expected_state: state.meta({
        description: "The state the caller believes the row is in (compare-and-set).",
        example: example[0],
      }),
      to_state: state.meta({ description: "Target state.", example: example[1] }),
      reason: z.string().min(1).optional().meta({
        description: "Reason, required by some transitions.",
        example: "Client approved the revised scope.",
      }),
    })
    .meta({ id, description: "Request to move a lifecycle to another state." });
}

const titleState = z.string().regex(/^[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*$/);

/** The standard state transition action for a lifecycle typed as a state label. */
export function transition(
  lifecycle: string,
  example: [string, string],
  state: z.ZodType = titleState,
): ActionSpec {
  const id = `${lifecycle.replace(/ /g, "")}TransitionRequest`;
  return itemAction("transition", {
    segment: "transitions",
    summary: `Transition the ${lifecycle.toLowerCase()} state`,
    description: `Moves the ${lifecycle.toLowerCase()} lifecycle to another state through its transition RPC, which writes the transition ledger. Uses compare-and-set on \`expected_state\`; a disallowed transition returns a 422 refusal.`,
    body: transitionBody(id, state, example),
  });
}
