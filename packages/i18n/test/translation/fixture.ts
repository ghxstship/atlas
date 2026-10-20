/**
 * A throwaway repository for pipeline tests (removed when the test finishes), and a fake transport that "translates" without any
 * network: text outside frozen spans goes through a word list, and every call is recorded.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { loadSetup, type Setup } from "../../src/translation/config.ts";
import type { Context } from "../../src/translation/pipeline.ts";
import type { TranslateBatch, Transport } from "../../src/translation/transport.ts";

export const WORDS: Readonly<Record<string, string>> = {
  Save: "Guardar",
  Cancel: "Cancelar",
  Hello: "Hola",
  file: "archivo",
  files: "archivos",
  from: "de",
  "Pass the": "Pasar la",
  gate: "compuerta",
  "Open the": "Abrir la",
  "Open ": "Abre ",
  door: "puerta",
  "Vehicle gate": "Puerta de vehículos",
  Baseline: "Base de referencia",
  "Read the": "Lee los",
  terms: "términos",
  Welcome: "Bienvenida",
  Intro: "Introducción",
  "Start here.": "Empieza aquí.",
  "Use the": "Usa el",
  CLI: "CLI",
  "First steps": "Primeros pasos",
  "Open Atlas": "Abre Atlas",
  Run: "Ejecuta",
  approved: "aprobado",
  rejected: "rechazado",
  was: "fue",
};

/** Translates the text runs of a segment outside `translate="no"` spans with WORDS. */
export function fakeTranslate(
  html: string,
  words: Readonly<Record<string, string>> = WORDS,
): string {
  const parts = html.split(/(<[^>]+>)/);
  const stack: boolean[] = [];
  const keys = Object.keys(words).sort((a, b) => b.length - a.length);
  return parts
    .map((part) => {
      if (part.startsWith("</")) {
        stack.pop();
        return part;
      }
      if (part.startsWith("<")) {
        stack.push(part.includes('translate="no"'));
        return part;
      }
      if (stack.includes(true)) return part;
      let out = part;
      keys.forEach((k, i) => {
        out = out.split(k).join(`@@${i}@@`);
      });
      return out.replace(/@@(\d+)@@/g, (_, i: string) => words[keys[Number(i)] ?? ""] ?? "");
    })
    .join("");
}

export class FakeTransport implements Transport {
  readonly calls: TranslateBatch[] = [];
  private readonly translateOne: (html: string, batch: TranslateBatch) => string;
  constructor(
    translateOne: (html: string, batch: TranslateBatch) => string = (h) => fakeTranslate(h),
  ) {
    this.translateOne = translateOne;
  }
  async translate(batch: TranslateBatch): Promise<string[]> {
    this.calls.push(batch);
    return batch.contents.map((c) => this.translateOne(c, batch));
  }
  get segments(): string[] {
    return this.calls.flatMap((c) => [...c.contents]);
  }
}

export const CONFIG = {
  source: { locale: "en-US", google: "en" },
  targets: [{ locale: "es-US", google: "es-US" }],
  google: {
    location: "us-central1",
    model: "general/translation-llm",
    glossaryPrefix: "xos-glossary",
    contextualGlossary: true,
    batch: { maxSegments: 3, maxCodePoints: 5000, concurrency: 2 },
  },
  pricing: {
    currency: "USD",
    inputPerMillion: 10000,
    outputPerMillion: 10000,
    outputRatio: 1.5,
    checked: "test",
  },
  surfaces: [
    { id: "catalogs", kind: "catalog", path: "msgs/{locale}" },
    { id: "help", kind: "markdown", path: "help/{locale}", frontMatter: ["title", "summary"] },
  ],
  memoryDir: "memory",
  review: { locale: "es-US", reportDir: "report" },
  check: { stale: "warning" },
};

export const TERMS = {
  doNotTranslate: {
    terms: [{ term: "Atlas" }, { term: "Compass" }, { term: "Legend", except: ["app.chart"] }],
    patterns: [
      { name: "canon code", pattern: "\\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\\b" },
      { name: "URL", pattern: "https?://[^\\s<>\"'{}]*[^\\s<>\"'{}.,;:!?)\\]]" },
      { name: "email address", pattern: "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+", check: false },
    ],
  },
  rules: [
    {
      id: "project-gate",
      description: "A project gate is a compuerta.",
      source: { pattern: "\\bgates?\\b", flags: "i" },
      except: ["@physical-gate"],
      targets: {
        "es-US": {
          require: { pattern: "compuerta", flags: "i" },
          forbid: [{ pattern: "\\bpuertas?\\b", flags: "i" }],
        },
      },
    },
    {
      id: "physical-gate",
      description: "A physical gate.",
      keys: ["app.vehicleGate"],
      googleGlossary: false,
      targets: { "es-US": { forbid: [{ pattern: "compuerta", flags: "i" }] } },
    },
  ],
};

export const GLOSSARY =
  "en,es-US,description\ngate,compuerta,A project gate\nBaseline,Línea base,\nAtlas,Atlas,Product name\n";

export const EN = {
  save: "Save",
  cancel: "Cancel",
  greeting: "Hello {name}",
  files: "{count, plural, one {# file from {org}} other {# files}}",
  gate: "Pass the gate",
  vehicleGate: "Vehicle gate",
  baseline: "Baseline",
  terms: "Read the <link>terms</link>",
  decided: "{title} was {decision, select, approved {approved} other {rejected}}",
  chart: "Legend",
  product: "Open Atlas",
};

export interface Repo {
  readonly root: string;
  write(path: string, content: string | object): void;
  read(path: string): string;
  json(path: string): Record<string, unknown>;
  setup(): Setup;
  context(transport?: Transport): Context;
}

export function makeRepo(files: Record<string, string | object> = {}): Repo {
  const root = mkdtempSync(join(tmpdir(), "xos-i18n-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string | object) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  };
  write("packages/i18n/translation/config.json", CONFIG);
  write("packages/i18n/translation/terms.json", TERMS);
  write("packages/i18n/translation/glossary.csv", GLOSSARY);
  write("msgs/en-US/app.json", EN);
  for (const [path, content] of Object.entries(files)) write(path, content);
  const repo: Repo = {
    root,
    write,
    read: (path) => readFileSync(join(root, path), "utf8"),
    json: (path) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>,
    setup: () => loadSetup(root),
    context: (transport) => ({
      setup: loadSetup(root),
      log: () => undefined,
      format: async (text) => text,
      ...(transport ? { transport } : {}),
    }),
  };
  return repo;
}
