import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_PATH,
  EDGE_ENTRIES,
  EDGE_EXTERNALS,
  committedEdgeFiles,
  differences,
  edgeFunctions,
  functionGraph,
  readEdgeFile,
  renderEdgeFiles,
} from "../edge/build.ts";

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as {
  imports: Record<string, string>;
};
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};
const functions = edgeFunctions();
const graphs = new Map(functions.map((fn) => [fn, functionGraph(fn, readEdgeFile)] as const));
const graph = (fn: string) => {
  const found = graphs.get(fn);
  if (found === undefined) throw new Error(`No function ${fn}`);
  return found;
};

/**
 * The npm packages each function loads when it boots, and the ones it loads only when a request needs
 * them (A85, RRR-130). Stripe only where billing happens; Resend and React Email only where email is
 * sent, and lazily there. kiosk-punch and the other small functions load no package at all.
 */
const PACKAGES: Record<string, { boot: string[]; lazy: string[] }> = {
  "api-token": { boot: [], lazy: [] },
  "email-unsubscribe": { boot: [], lazy: [] },
  "inbound-email": { boot: ["zod"], lazy: [] },
  "kiosk-punch": { boot: [], lazy: [] },
  "notification-dispatch": {
    boot: ["intl-messageformat", "zod"],
    lazy: ["@react-email/components", "react/jsx-runtime", "resend"],
  },
  "report-run": { boot: ["@supabase/supabase-js", "zod"], lazy: ["exceljs", "pdfkit", "resend"] },
  "sms-webhook": { boot: ["intl-messageformat", "zod"], lazy: [] },
  "stripe-webhook": { boot: ["stripe"], lazy: [] },
  "upload-scan": { boot: ["@supabase/supabase-js"], lazy: [] },
  "webhook-dispatch": { boot: [], lazy: [] },
};

/**
 * Most vendored code (KB) each function may parse at boot. These are about 25 percent above the
 * build of 2026-10-20; before A85 every function parsed 1,640 KB. Raise one only after measuring
 * that function's cold start (infra/runbooks/production.md, Edge Functions).
 */
const BOOT_BUDGET_KB: Record<string, number> = {
  "api-token": 70,
  "email-unsubscribe": 64,
  "inbound-email": 64,
  "kiosk-punch": 64,
  "notification-dispatch": 160,
  "report-run": 128,
  "sms-webhook": 128,
  "stripe-webhook": 84,
  "upload-scan": 100,
  "webhook-dispatch": 70,
};

describe("Edge Function bundles", () => {
  it("are regenerated, never hand-edited (Section 3.15)", async () => {
    expect(differences(await renderEdgeFiles(), committedEdgeFiles())).toEqual([]);
  }, 120_000);

  it("have one entry per function that uses platform code, plus the shared core", () => {
    for (const entry of EDGE_ENTRIES) {
      if (entry !== "core") expect(functions, entry).toContain(entry);
    }
    for (const fn of functions) {
      const vendored = [...graph(fn).boot, ...graph(fn).lazy].filter((file) =>
        /^_vendor\/[^/]+\.js$/.test(file),
      );
      for (const file of vendored)
        expect([`_vendor/${fn}.js`, "_vendor/core.js"], fn).toContain(file);
    }
  });

  it("load only the npm packages each function needs, and the heavy ones on demand", () => {
    expect(Object.keys(PACKAGES).sort()).toEqual(functions);
    for (const fn of functions) {
      expect({ boot: graph(fn).bootPackages, lazy: graph(fn).lazyPackages }, fn).toEqual(
        PACKAGES[fn],
      );
    }
  });

  it("keep each function's boot code inside its budget", () => {
    expect(Object.keys(BOOT_BUDGET_KB).sort()).toEqual(functions);
    for (const fn of functions) {
      const bytes = graph(fn).boot.reduce(
        (sum, file) => sum + Buffer.byteLength(readEdgeFile(file) ?? ""),
        0,
      );
      expect(bytes / 1024, fn).toBeLessThanOrEqual(BOOT_BUDGET_KB[fn] ?? 0);
    }
  });

  it("never bundle a whole message catalog, only the namespaces the functions use", () => {
    for (const [path, text] of committedEdgeFiles()) {
      expect(text, path).not.toContain("i18n/src/catalogs.generated");
      for (const match of text.matchAll(/i18n\/messages\/[^/]+\/([A-Za-z]+)\.json/g)) {
        expect(["email", "reporting", "workflow"], path).toContain(match[1]);
      }
    }
  });

  it("map every external package to a pinned npm specifier in the catalog", () => {
    for (const name of EDGE_EXTERNALS) {
      expect(catalog.imports[name], name).toMatch(/^npm:(@[^@]+|[^@]+)@\d+\.\d+\.\d+(\/.*)?$/);
    }
  });

  it("pin the packages @xos/platform itself depends on to the same versions", () => {
    for (const name of ["stripe", "zod", "@supabase/supabase-js"]) {
      expect(catalog.imports[name]).toBe(`npm:${name}@${manifest.dependencies[name]}`);
    }
  });
});
