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
 * sent, the migration function that calls private.notify with it at its latest definition and a test that
 * observes the notification, or a recorded reason nothing sends it yet. A kind the preference matrix offers but
 * nothing creates, as shift.changed and incident.reported once were, cannot be added.
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

/** Where `symbol` is defined in a migration: its last `create function` up to the end of its body. */
function definition(source: string, symbol: string): string | null {
  const name = symbol.replaceAll(".", "\\.");
  const starts = [
    ...source.matchAll(new RegExp(`create (or replace )?function ${name}\\s*\\(`, "gi")),
  ];
  const at = starts.at(-1)?.index;
  if (at === undefined) return null;
  const end = source.indexOf("\n$$;", at);
  return source.slice(at, end < 0 ? undefined : end);
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
          const body = definition(source, symbol);
          expect(body, `${kind}: ${file} defines ${symbol}`).not.toBeNull();
          expect(body?.includes(`'${kind}'`), `${kind}: ${symbol} names the kind`).toBe(true);
          expect(body?.includes("private.notify"), `${kind}: ${symbol} calls private.notify`).toBe(
            true,
          );
          // A later migration that redefines the function must take over the reference, with the kind.
          const name = file.slice("supabase/migrations/".length);
          const later = migrations.filter(
            (m) => m > name && definition(read(`supabase/migrations/${m}`), symbol) !== null,
          );
          expect(later, `${kind}: ${symbol} is redefined after ${name}`).toEqual([]);
        } else if (symbol !== undefined) {
          expect(source.includes(symbol), `${kind}: ${file} defines ${symbol}`).toBe(true);
        }
        expect(existsSync(join(repoRoot, test)), `${kind}: ${test} exists`).toBe(true);
        expect(read(test).includes(kind), `${kind}: ${test} observes the kind`).toBe(true);
      }
    });
  }

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
      '  - kind: mention.created\n    deferred:\n      reason: "Nothing sends mentions until comments ship."\n      decision: "RRR-0 placeholder"\n',
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
