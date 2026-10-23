import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NotificationRegistryError,
  parseNotificationEmission,
} from "../../src/notifications/index.ts";
import {
  NOTIFICATION_KINDS_YAML_PATH,
  loadNotificationEmission,
  loadNotificationRegistry,
} from "../../src/notifications/load.ts";

/**
 * The notification counterpart of the settings guard (A65-001, RRR-125): every registered kind names where it is
 * sent, the migration function that calls private.notify with it and a test that observes the notification, or a
 * recorded reason nothing sends it yet. A kind the preference matrix offers but nothing creates, as shift.changed
 * and incident.reported once were, cannot be added.
 *
 * An emitter is checked at the definition the database runs, not at the file the registry names: the guard follows
 * the function to its last `create function` across every migration. A later migration that redefines it, on this
 * branch or on one merged later (orch-fix-settings' 1395 redefines the two approval emitters 1030 defines), passes
 * while it still sends the kind and fails the moment it stops, or drops the function, without either branch having
 * to know the other's file.
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrations = readdirSync(join(repoRoot, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const registry = loadNotificationRegistry();
const emission = loadNotificationEmission();

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function migration(name: string): string {
  return read(`supabase/migrations/${name}`);
}

/** The parameter list after `(` at `open`, and how many parameters it holds (commas inside parentheses or quotes do not count). */
function parameters(source: string, open: number): { list: string; count: number } {
  let depth = 0;
  let quoted = false;
  let count = 0;
  let any = false;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return { list: source.slice(open + 1, i), count: any ? count + 1 : 0 };
      depth--;
    } else if (c === "," && depth === 0) count++;
    if (c !== undefined && !/\s/.test(c)) any = true;
  }
  return { list: source.slice(open + 1), count: any ? count + 1 : 0 };
}

type Event =
  | { readonly kind: "create"; readonly arity: number; readonly body: string }
  | { readonly kind: "drop"; readonly arity: number | null };

/** Where one migration creates or drops `symbol`, in source order, with each create's `$$` body (not its signature). */
function events(source: string, symbol: string): Event[] {
  const name = symbol.replaceAll(".", "\\.");
  const pattern = new RegExp(
    `\\b(create(?:\\s+or\\s+replace)?\\s+function|drop\\s+function(?:\\s+if\\s+exists)?)\\s+${name}\\b\\s*(\\()?`,
    "gi",
  );
  return [...source.matchAll(pattern)].map((m): Event => {
    const at = m.index;
    const open = m[2] === undefined ? -1 : at + m[0].length - 1;
    const arity = open < 0 ? null : parameters(source, open).count;
    if (m[1]?.toLowerCase().startsWith("drop")) return { kind: "drop", arity };
    const opening = source.indexOf("$$", at);
    const closing = opening < 0 ? -1 : source.indexOf("$$", opening + 2);
    return {
      kind: "create",
      arity: arity ?? 0,
      body: opening < 0 ? "" : source.slice(opening, closing < 0 ? undefined : closing + 2),
    };
  });
}

/**
 * The definition of `symbol` the database runs once every migration in `files` has applied: its last
 * `create function`, with the migration that holds it, or the migration that drops it afterwards (a drop that names
 * another overload's parameters leaves it standing). Null when no migration defines it.
 */
function latestDefinition(
  symbol: string,
  files: readonly string[],
  source: (name: string) => string,
): { readonly file: string; readonly body: string; readonly droppedIn: string | null } | null {
  let latest: { file: string; body: string; arity: number; droppedIn: string | null } | null = null;
  for (const file of files) {
    for (const e of events(source(file), symbol)) {
      if (e.kind === "create") latest = { file, body: e.body, arity: e.arity, droppedIn: null };
      else if (latest !== null && (e.arity === null || e.arity === latest.arity))
        latest.droppedIn = file;
    }
  }
  return latest === null
    ? null
    : { file: latest.file, body: latest.body, droppedIn: latest.droppedIn };
}

/**
 * What is wrong with a migration emitter `file#symbol` for `kind`: the named migration must define the function,
 * and the function's latest definition across `files` must still exist, name the kind and call private.notify.
 * Empty when the emitter holds.
 */
function emitterIssues(
  kind: string,
  file: string,
  symbol: string,
  files: readonly string[],
  source: (name: string) => string,
): string[] {
  if (!files.includes(file)) return [`${kind}: supabase/migrations/${file} does not exist`];
  if (!events(source(file), symbol).some((e) => e.kind === "create"))
    return [`${kind}: ${file} does not define ${symbol}`];
  const latest = latestDefinition(symbol, files, source);
  if (latest === null) return [`${kind}: no migration defines ${symbol}`];
  const where = latest.file === file ? file : `${latest.file} (its latest definition)`;
  if (latest.droppedIn !== null)
    return [`${kind}: ${symbol} is dropped in ${latest.droppedIn} and nothing defines it again`];
  const issues: string[] = [];
  if (!latest.body.includes(`'${kind}'`))
    issues.push(`${kind}: ${symbol} in ${where} does not name the kind`);
  // private.notify itself or one of its private.notify_* wrappers (notify_account, notify_invoice_party).
  if (!/\bprivate\.notify\w*\s*\(/.test(latest.body))
    issues.push(`${kind}: ${symbol} in ${where} does not call private.notify`);
  return issues;
}

describe("every notification kind is sent or says why not", () => {
  it("covers every registered kind", () => {
    expect([...emission.keys()]).toEqual(registry.kinds.map((k) => k.kind));
  });

  for (const [kind, e] of emission) {
    if (e.status !== "emitted") continue;
    it(`${kind} is sent by its emitters and observed by their tests`, () => {
      for (const { emitter, test } of e.by) {
        const [file = "", symbol] = emitter.split("#");
        expect(existsSync(join(repoRoot, file)), `${kind}: ${file} exists`).toBe(true);
        const source = read(file);
        expect(
          source.includes(`'${kind}'`) || source.includes(`"${kind}"`),
          `${kind}: ${file}`,
        ).toBe(true);
        if (symbol !== undefined && file.startsWith("supabase/migrations/")) {
          const name = file.slice("supabase/migrations/".length);
          expect(emitterIssues(kind, name, symbol, migrations, migration)).toEqual([]);
        } else if (symbol !== undefined) {
          expect(source.includes(symbol), `${kind}: ${file} defines ${symbol}`).toBe(true);
        }
        expect(existsSync(join(repoRoot, test)), `${kind}: ${test} exists`).toBe(true);
        expect(read(test).includes(kind), `${kind}: ${test} observes the kind`).toBe(true);
      }
    });
  }

  it("follows an emitter to its latest definition, wherever a merge puts it", () => {
    // Synthetic migrations, so the case holds whatever the repository's own migrations redefine.
    const [first, merged, later] = ["0001_first.sql", "0002_merged_branch.sql", "0003_later.sql"];
    const symbol = "private.notify_step_approvers";
    const definitionWith = (body: string) =>
      `create or replace function ${symbol}(p_instance app.approval_instances)\nreturns void\nlanguage plpgsql\nas $$\nbegin\n  ${body}\nend;\n$$;\n`;
    const sends = definitionWith(
      "perform private.notify(p_instance.org_id, v_person, 'approval.requested');",
    );
    const files = (texts: Record<string, string>) => ({
      names: Object.keys(texts).sort(),
      source: (name: string) => texts[name] ?? "",
    });
    const issues = (named: string, texts: Record<string, string>) => {
      const { names, source } = files(texts);
      return emitterIssues("approval.requested", named, symbol, names, source);
    };

    // A merged branch redefines the emitter and still sends the kind: the entry at the first file holds, and so
    // does one pointed at the redefinition.
    const kept = { [first]: sends, [merged]: sends };
    expect(issues(first, kept)).toEqual([]);
    expect(issues(merged, kept)).toEqual([]);
    expect(latestDefinition(symbol, files(kept).names, files(kept).source)?.file).toBe(merged);

    // The redefinition stops sending it: the guard fails at the definition the database runs.
    expect(issues(first, { [first]: sends, [merged]: definitionWith("return;") })).toEqual([
      `approval.requested: ${symbol} in ${merged} (its latest definition) does not name the kind`,
      `approval.requested: ${symbol} in ${merged} (its latest definition) does not call private.notify`,
    ]);

    // A later drop of the same signature removes it; a drop of another overload leaves it standing.
    expect(
      issues(first, {
        [first]: sends,
        [later]: `drop function ${symbol}(app.approval_instances);\n`,
      }),
    ).toEqual([
      `approval.requested: ${symbol} is dropped in ${later} and nothing defines it again`,
    ]);
    expect(
      issues(first, { [first]: sends, [later]: `drop function ${symbol}(uuid, smallint);\n` }),
    ).toEqual([]);
    expect(
      issues(first, {
        [first]: sends,
        [merged]: `drop function ${symbol}(app.approval_instances);\n${sends}`,
      }),
    ).toEqual([]);

    // The named file must define the function, and a longer name is a different function.
    expect(issues(first, { [first]: sends.replace(symbol, `${symbol}_v2`) })).toEqual([
      `approval.requested: ${first} does not define ${symbol}`,
    ]);
    expect(issues(later, kept)).toEqual([
      `approval.requested: supabase/migrations/${later} does not exist`,
    ]);
  });

  it("defers only the kinds that wait on a recorded decision", () => {
    const deferred = [...emission]
      .filter(([, e]) => e.status === "deferred")
      .map(([kind]) => kind)
      .sort();
    // Deferring a kind is a decision: name it here with its reason in notification-kinds.yaml.
    expect(deferred).toEqual([
      "account.security_changed",
      "export.ready",
      "import.finished",
      "report.delivered",
    ]);
  });

  it("sends every kind that bypasses quiet hours (ADR 0033 decision 35)", () => {
    for (const k of registry.kinds.filter((d) => d.quietHoursBypass !== null)) {
      expect(emission.get(k.kind)?.status, k.kind).toBe("emitted");
    }
  });

  it("refuses a kind that names no emitter, or both an emitter and a deferral", () => {
    const yaml = readFileSync(NOTIFICATION_KINDS_YAML_PATH, "utf8");
    const bare = yaml.replace(
      "    emitted_by:\n      - emitter: supabase/migrations/0580_comments.sql#private.after_comment_mention\n        test: supabase/tests/0580_comments.test.sql\n",
      "",
    );
    expect(() => parseNotificationEmission(bare)).toThrow(/kind mention\.created names no emitter/);
    const both = yaml.replace(
      "  - kind: mention.created\n",
      '  - kind: mention.created\n    deferred:\n      reason: "Nothing sends mentions until comments ship."\n      decision: "RRR-0, a made-up work package"\n',
    );
    let error: unknown;
    try {
      parseNotificationEmission(both);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotificationRegistryError);
    expect((error as NotificationRegistryError).issues).toContain(
      "kind mention.created is both emitted and deferred; keep one",
    );
  });
});
