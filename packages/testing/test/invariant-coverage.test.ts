import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Section 18 gate 4: pgTAP covers every Section 7.5 invariant and every state machine transition, allowed and refused.
 * Both halves are checked from the source text, so a suite that loses its assertion fails here before review.
 *
 * Invariants: migration 1220 registers each invariant in private.invariants with a stable code (inv_NN_slug). An
 * assertion covers an invariant by starting its description with the code ('inv_10_closed_production: ...'). Every
 * registered code must start at least one description under supabase/tests. An invariant that cannot be tested yet is
 * listed in `untestable` with the finding that records why, and the finding file must exist.
 *
 * Transitions: every lifecycle in private.lifecycle_transition_rules (plus the machines that keep their own rules,
 * listed in `ownRules`) needs a refused move asserted by its code (`<lifecycle>_transition_not_allowed`, or
 * `<lifecycle>_state_conflict` for RPCs whose moves are fixed and refuse a stale state instead) inside a throws_
 * assertion, and an allowed move: a statement outside any throws_ assertion that calls a function moving that
 * lifecycle (found from the migrations: the functions whose body calls private.transition_lifecycle with its name).
 */
const root = fileURLToPath(new URL("../../../supabase/", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = (dir: string) =>
  readdirSync(`${root}${dir}`)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".psql"))
    .sort()
    .map((f) => readFileSync(`${root}${dir}/${f}`, "utf8"));

const migrations = read("migrations");
const tests = read("tests").join("\n");
/** Test statements, split at the semicolon that ends a line. */
const statements = tests.split(/;\s*\n/);

/** Invariants that have no test yet, each with the finding that says why. Empty means full coverage. */
const untestable: Record<string, string> = {};

const registry = migrations
  .flatMap((sql) => {
    const insert = /insert into private\.invariants[\s\S]*?;\s*$/m.exec(sql);
    return insert ? [...insert[0].matchAll(/\(\s*'(inv_\d{2}_[a-z0-9_]+)'\s*,\s*(\d+)/g)] : [];
  })
  .map((m) => ({ code: m[1] as string, number: Number(m[2]) }));

describe("Section 7.5 invariant traceability (gate 4)", () => {
  it("reads the 24 invariants from the registry", () => {
    expect(registry.map((r) => r.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });

  it("names every invariant at the start of a pgTAP assertion description", () => {
    const unnamed = registry
      .map((r) => r.code)
      .filter((code) => !(code in untestable) && !tests.includes(`'${code}: `))
      .sort();
    expect(unnamed, "invariant codes no pgTAP assertion names").toEqual([]);
  });

  it("records a finding for every invariant without a test", () => {
    const missing = Object.entries(untestable)
      .filter(([, finding]) => !existsSync(`${repo}legal/qa/findings/${finding}.md`))
      .map(([code]) => code);
    expect(missing).toEqual([]);
  });

  it("names no code the registry does not hold", () => {
    const known = new Set(registry.map((r) => r.code));
    const named = new Set(
      [...tests.matchAll(/'(inv_\d{2}_[a-z0-9_]+): /g)].map((m) => m[1] as string),
    );
    expect([...named].filter((c) => !known.has(c)).sort()).toEqual([]);
  });
});

/** State machines that keep their own rule table instead of private.lifecycle_transition_rules. */
const ownRules: Record<string, { refused: string[]; movers: string[] }> = {
  subscription: {
    refused: ["subscription_transition_not_allowed"],
    movers: ["private.transition_subscription"],
  },
  // The phase ledger (app.project_phase_transitions) moves only through app.pass_gate (invariant 9).
  project_phase: { refused: ["gate_criteria_unmet"], movers: ["app.pass_gate"] },
};

const lifecycles = new Set(
  migrations.flatMap((sql) =>
    [...sql.matchAll(/insert into private\.lifecycle_transition_rules[^;]*;/g)].flatMap((m) =>
      [...m[0].matchAll(/\(\s*'([a-z_]+)'\s*,\s*'[^']+'\s*,\s*'[^']+'\s*\)/g)].map(
        (t) => t[1] as string,
      ),
    ),
  ),
);

/** Function bodies by name; a later definition of the same function replaces an earlier one. */
const bodies = new Map<string, string>();
for (const sql of migrations) {
  const heads = [...sql.matchAll(/create (?:or replace )?function\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi)];
  heads.forEach((head, i) => {
    bodies.set(head[1] as string, sql.slice(head.index, heads[i + 1]?.index ?? sql.length));
  });
}
// A function moves a lifecycle when its body calls private.transition_lifecycle with the lifecycle's name, or calls
// another function that moves it (app.post_journal_entry through private.post_journal, for example).
const movers: Record<string, Set<string>> = {};
for (const [fn, body] of bodies) {
  for (const m of body.matchAll(/transition_lifecycle\(\s*'([a-z_]+)'/g)) {
    (movers[m[1] as string] ??= new Set()).add(fn);
  }
}
for (let grew = true; grew;) {
  grew = false;
  for (const set of Object.values(movers)) {
    for (const [fn, body] of bodies) {
      if (set.has(fn)) continue;
      if ([...set].some((mover) => body.includes(`${mover}(`))) {
        set.add(fn);
        grew = true;
      }
    }
  }
}

const machines = [
  ...[...lifecycles].map((name) => ({
    name,
    refused: [`${name}_transition_not_allowed`, `${name}_state_conflict`],
    movers: [...(movers[name] ?? [])],
  })),
  ...Object.entries(ownRules).map(([name, m]) => ({ name, ...m })),
].sort((a, b) => a.name.localeCompare(b.name));

const calls = (fn: string) => new RegExp(`${fn.replace(".", "\\.")}\\(`);

describe("state machine transition coverage (gate 4)", () => {
  it("finds the lifecycles the migrations declare", () => {
    expect(lifecycles.size).toBeGreaterThanOrEqual(49);
  });

  it("finds a function that moves every lifecycle", () => {
    expect(machines.filter((m) => m.movers.length === 0).map((m) => m.name)).toEqual([]);
  });

  it("asserts a refused move of every state machine by its code", () => {
    const unrefused = machines
      .filter(
        (m) =>
          !statements.some(
            (s) => s.includes("throws_") && m.refused.some((code) => s.includes(code)),
          ),
      )
      .map((m) => m.name);
    expect(unrefused, "state machines with no refused move asserted by code").toEqual([]);
  });

  it("names the refusal of every move the rules do not hold (finding A54-003)", () => {
    // A refused move asserted with a null message passes on any XR001, so an earlier guard can refuse first while
    // the description claims the rule. Each such assertion names the refusal it expects.
    const held = new Set(
      migrations.flatMap((sql) =>
        [...sql.matchAll(/insert into private\.lifecycle_transition_rules[^;]*;/g)].flatMap((m) =>
          [...m[0].matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map(
            (t) => `${t[1] as string}:${t[2] as string}>${t[3] as string}`,
          ),
        ),
      ),
    );
    const move =
      /app\.transition_([a-z_]+)\((?:\(select [^)]*\)|[^,()]+),\s*'([^']+)',\s*'([^']+)'/;
    const vague = statements
      .filter((s) => /throws_(ok|like)\(/.test(s) && /'XR001',\s*null/.test(s))
      .map((s) => ({ s, m: move.exec(s) }))
      .filter(({ m }) => m !== null && lifecycles.has(m[1] as string))
      .filter(({ m }) => !held.has(`${m?.[1]}:${m?.[2]}>${m?.[3]}`))
      .map(({ m }) => `${m?.[1]} ${m?.[2]} to ${m?.[3]}`);
    expect(vague, "refused moves asserted without the refusal they expect").toEqual([]);
  });

  it("exercises an allowed move of every state machine", () => {
    const unmoved = machines
      .filter(
        (m) =>
          !statements.some(
            (s) => !s.includes("throws_") && m.movers.some((fn) => calls(fn).test(s)),
          ),
      )
      .map((m) => m.name);
    expect(unmoved, "state machines no suite moves along an allowed transition").toEqual([]);
  });
});
