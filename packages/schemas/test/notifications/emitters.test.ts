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
 *
 * Sending means calling private.notify, directly or through private functions that do, at their own latest
 * definitions: the expiry reminder job (1463) names each kind and passes it to private.remind_expiry, which calls
 * private.notify; private.notify_account and the other wrappers count the same way, by what they call, not by name.
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

const sources = new Map<string, string>();

function migration(name: string): string {
  let text = sources.get(name);
  if (text === undefined) {
    text = read(`supabase/migrations/${name}`);
    sources.set(name, text);
  }
  return text;
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

interface Definition {
  readonly file: string;
  readonly body: string;
  readonly droppedIn: string | null;
}

type Latest = { file: string; body: string; arity: number; droppedIn: string | null } | null;

/** `latest` after one migration's events for the function (a drop that names another overload's parameters leaves it standing). */
function fold(latest: Latest, file: string, found: readonly Event[]): Latest {
  let next = latest;
  for (const e of found) {
    if (e.kind === "create") next = { file, body: e.body, arity: e.arity, droppedIn: null };
    else if (next !== null && (e.arity === null || e.arity === next.arity))
      next = { ...next, droppedIn: file };
  }
  return next;
}

/**
 * The definition of `symbol` the database runs once every migration in `files` has applied: its last
 * `create function`, with the migration that holds it, or the migration that drops it afterwards. Null when no
 * migration defines it.
 */
function latestDefinition(
  symbol: string,
  files: readonly string[],
  source: (name: string) => string,
): Definition | null {
  let latest: Latest = null;
  for (const file of files) latest = fold(latest, file, events(source(file), symbol));
  return latest === null
    ? null
    : { file: latest.file, body: latest.body, droppedIn: latest.droppedIn };
}

/** The latest definition of every private function across `files`, in one pass over them. */
function privateDefinitions(
  files: readonly string[],
  source: (name: string) => string,
): ReadonlyMap<string, Definition> {
  const latest = new Map<string, Latest>();
  const named =
    /\b(?:create(?:\s+or\s+replace)?\s+function|drop\s+function(?:\s+if\s+exists)?)\s+(private\.\w+)/gi;
  for (const file of files) {
    const text = source(file);
    const symbols = new Set([...text.matchAll(named)].map((m) => (m[1] ?? "").toLowerCase()));
    for (const symbol of symbols)
      latest.set(symbol, fold(latest.get(symbol) ?? null, file, events(text, symbol)));
  }
  const defined = new Map<string, Definition>();
  for (const [symbol, d] of latest) if (d !== null && d.droppedIn === null) defined.set(symbol, d);
  return defined;
}

const definitionsOf = new WeakMap<(name: string) => string, ReadonlyMap<string, Definition>>();

/**
 * Whether `body` sends a notification: it calls private.notify, or calls a private function whose latest
 * definition does, however many calls down. A function a migration drops for good sends nothing; each function is
 * read once, so a cycle ends.
 */
function callsNotify(
  body: string,
  files: readonly string[],
  source: (name: string) => string,
): boolean {
  let defined = definitionsOf.get(source);
  if (defined === undefined) {
    defined = privateDefinitions(files, source);
    definitionsOf.set(source, defined);
  }
  const seen = new Set<string>();
  const queue = [body];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (/\bprivate\.notify\s*\(/i.test(next)) return true;
    for (const m of next.matchAll(/\bprivate\.(\w+)\s*\(/gi)) {
      const callee = `private.${(m[1] ?? "").toLowerCase()}`;
      const d = defined.get(callee);
      if (seen.has(callee) || d === undefined) continue;
      seen.add(callee);
      queue.push(d.body);
    }
  }
  return false;
}

/**
 * What is wrong with a migration emitter `file#symbol` for `kind`: the named migration must define the function,
 * and the function's latest definition across `files` must still exist, name the kind and call private.notify,
 * directly or through private functions that do (callsNotify). Empty when the emitter holds.
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
  if (!callsNotify(latest.body, files, source))
    issues.push(
      `${kind}: ${symbol} in ${where} does not call private.notify, directly or through a function`,
    );
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
      `approval.requested: ${symbol} in ${merged} (its latest definition) does not call private.notify, directly or through a function`,
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

  it("counts a call through private functions that send, at their latest definitions", () => {
    const [first, later] = ["0001_first.sql", "0002_later.sql"];
    const symbol = "private.send_expiry_reminders";
    const definition = (name: string, body: string) =>
      `create or replace function ${name}(p_kind text)\nreturns boolean\nlanguage plpgsql\nas $$\nbegin\n  ${body}\nend;\n$$;\n`;
    const job = definition(symbol, "perform private.remind_expiry('document.expiring');");
    const remind = (body: string) => definition("private.remind_expiry", body);
    const notifies = "perform private.notify(v_org, v_person, p_kind);";
    const issues = (texts: Record<string, string>) =>
      emitterIssues(
        "document.expiring",
        first,
        symbol,
        Object.keys(texts).sort(),
        (name) => texts[name] ?? "",
      );
    const silent = [
      `document.expiring: ${symbol} in ${first} does not call private.notify, directly or through a function`,
    ];

    // The job names the kind and hands it to a function that calls private.notify, or to one that calls such a
    // function, wherever it is defined.
    expect(issues({ [first]: job + remind(notifies) })).toEqual([]);
    expect(
      issues({
        [first]: job + remind("perform private.queue_reminder(p_kind);"),
        [later]: definition("private.queue_reminder", notifies),
      }),
    ).toEqual([]);

    // The function's latest definition stops calling private.notify, or a later migration drops it: nothing sends.
    expect(issues({ [first]: job + remind(notifies), [later]: remind("return true;") })).toEqual(
      silent,
    );
    expect(
      issues({
        [first]: job + remind(notifies),
        [later]: "drop function private.remind_expiry(text);\n",
      }),
    ).toEqual(silent);

    // What a function calls counts, not its name; and calls that loop back end.
    expect(
      issues({
        [first]:
          definition(symbol, "perform private.notify_later('document.expiring');") +
          definition("private.notify_later", "perform private.notify_later(p_kind);"),
      }),
    ).toEqual(silent);
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
