import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../src/translation/check.ts";
import { loadMemory } from "../../src/translation/memory.ts";
import { normalizeWording, review, setLock, translate } from "../../src/translation/pipeline.ts";
import { reviewReport } from "../../src/translation/report.ts";
import { EN, FakeTransport, WORDS, fakeTranslate, makeRepo } from "./fixture.ts";

const ES_DONE = {
  save: "Guardar",
  cancel: "Cancelar",
  greeting: "Hola {name}",
  files: "{count, plural, one {# archivo de {org}} other {# archivos}}",
  gate: "Pasar la compuerta",
  vehicleGate: "Puerta de vehículos",
  baseline: "Línea base",
  terms: "Lee los <link>términos</link>",
  decided: "{title} fue {decision, select, approved {aprobado} other {rechazado}}",
  chart: "Leyenda",
  product: "Abre Atlas",
};

describe("translate", () => {
  it("fills every missing string of a new target, in source key order, and records the memory", async () => {
    const repo = makeRepo();
    const transport = new FakeTransport();
    const [result] = await translate(repo.context(transport));
    expect(result?.selected).toBe(Object.keys(EN).length);
    expect(result?.failures).toEqual([]);
    const es = repo.json("msgs/es-US/app.json");
    expect(Object.keys(es)).toEqual(Object.keys(EN));
    expect(es).toMatchObject({
      save: "Guardar",
      greeting: "Hola {name}",
      files: "{count, plural, one {# archivo de {org}} other {# archivos}}",
      gate: "Pasar la compuerta",
      terms: "Lee los <link>términos</link>",
      decided: "{title} fue {decision, select, approved {aprobado} other {rechazado}}",
      product: "Abre Atlas",
    });
    const memory = loadMemory(repo.root, repo.setup().config, "es-US");
    expect(memory.entries.get("app.save")).toMatchObject({ by: "google", locked: false });
    expect(runCheck(repo.setup()).errors).toEqual([]);
  });

  it("batches by glossary use and sends physical gates without the glossary", async () => {
    const repo = makeRepo();
    const transport = new FakeTransport();
    await translate(repo.context(transport));
    expect(transport.calls.every((c) => c.target === "es-US" && c.contents.length <= 3)).toBe(true);
    const withoutGlossary = transport.calls.filter((c) => !c.glossary).flatMap((c) => c.contents);
    expect(withoutGlossary).toEqual(["Vehicle gate"]);
  });

  it("answers reruns from the translation memory and re-translates only what changed", async () => {
    const repo = makeRepo();
    await translate(repo.context(new FakeTransport()));
    const rerun = new FakeTransport();
    const [again] = await translate(repo.context(rerun));
    expect(again?.selected).toBe(0);
    expect(rerun.calls).toEqual([]);

    repo.write("msgs/en-US/app.json", { ...EN, greeting: "Hello {name}, welcome", cancel: "Save" });
    expect(
      runCheck(repo.setup())
        .warnings.map((w) => w.id)
        .sort(),
    ).toEqual(["app.cancel", "app.greeting"]);
    const changed = new FakeTransport();
    const [third] = await translate(repo.context(changed));
    expect(third?.selected).toBe(2);
    expect(third?.cost.cached).toBe(1);
    expect(changed.segments).toEqual(['Hello <span translate="no" id="a1">{name}</span>, welcome']);
    expect(repo.json("msgs/es-US/app.json")).toMatchObject({
      cancel: "Guardar",
      greeting: "Hola {name}, welcome",
    });
    expect(runCheck(repo.setup()).warnings).toEqual([]);
  });

  it("never overwrites a locked string, and warns when its source changes", async () => {
    const repo = makeRepo({ "msgs/es-US/app.json": { ...ES_DONE, save: "Guardar cambios" } });
    await translate(repo.context(new FakeTransport()));
    expect(setLock(repo.setup(), "es-US", ["app.save", "app.nope"], true)).toEqual({
      changed: ["app.save"],
      unknown: ["app.nope"],
    });
    repo.write("msgs/en-US/app.json", { ...EN, save: "Save now" });
    const transport = new FakeTransport();
    const [result] = await translate(repo.context(transport));
    expect(result?.lockedStale).toEqual(["app.save"]);
    expect(transport.calls).toEqual([]);
    expect(repo.json("msgs/es-US/app.json")["save"]).toBe("Guardar cambios");
    expect(runCheck(repo.setup()).warnings).toEqual([
      expect.objectContaining({ id: "app.save", message: expect.stringContaining("locked") }),
    ]);
    expect(runCheck(repo.setup(), { strict: true }).errors).toHaveLength(1);
  });

  it("rejects output that breaks a glossary rule or loses a span, and falls back to en-US for a missing string", async () => {
    const repo = makeRepo();
    const transport = new FakeTransport((html) =>
      html.includes("gate")
        ? html.replace("Pass the gate", "Pasar la puerta")
        : fakeTranslate(html).replace(/<span translate="no" id="a1">\{name\}<\/span>/, ""),
    );
    const [result] = await translate(repo.context(transport));
    expect(result?.failures.map((f) => f.id).sort()).toEqual(["app.gate", "app.greeting"]);
    expect(result?.failures.find((f) => f.id === "app.gate")?.reason).toContain("project-gate");
    const es = repo.json("msgs/es-US/app.json");
    expect(es["gate"]).toBe("Pass the gate");
    expect(loadMemory(repo.root, repo.setup().config, "es-US").entries.get("app.gate")?.by).toBe(
      "fallback",
    );
    const retry = new FakeTransport();
    const [second] = await translate(repo.context(retry));
    expect(second?.selected).toBe(2);
  });

  it("prices a dry run from the masked characters and touches neither the network nor files", async () => {
    const repo = makeRepo({ "msgs/en-US/app.json": { save: "Save", greeting: "Hello {name}" } });
    const [result] = await translate(repo.context());
    // "Save" is 4 code points; 'Hello <span translate="no" id="a1">{name}</span>' is 48.
    expect(result?.dryRun).toBe(true);
    expect(result?.cost).toEqual({
      segments: 2,
      cached: 0,
      misses: 2,
      characters: 52,
      textCharacters: 16,
      estimate: 1.3,
    });
    expect(existsSync(join(repo.root, "msgs/es-US"))).toBe(false);
    expect(existsSync(join(repo.root, "memory/es-US.json"))).toBe(false);
  });

  it("translates markdown articles and drops keys the source no longer has", async () => {
    const repo = makeRepo({
      "help/en-US/intro.md":
        "---\ntitle: Intro\nsummary: Start here.\norder: 1\n---\n\n## First steps\n\nOpen Atlas.\n",
      "msgs/es-US/app.json": { ...ES_DONE, removed: "Sobra" },
    });
    await translate(repo.context(new FakeTransport()));
    expect(repo.read("help/es-US/intro.md")).toBe(
      "---\ntitle: Introducción\nsummary: Empieza aquí.\norder: 1\n---\n\n## Primeros pasos\n\nAbre Atlas.\n",
    );
    expect(repo.json("msgs/es-US/app.json")).not.toHaveProperty("removed");
  });
});

describe("review", () => {
  it("normalizes case, punctuation and whitespace before comparing", () => {
    expect(normalizeWording("¡Guardar  Cambios!")).toBe(normalizeWording("guardar cambios"));
    expect(normalizeWording("Guardar")).not.toBe(normalizeWording("Guardar cambios"));
  });

  it("applies Google's version, keeps locked strings and glossary terms, and reports only real differences", async () => {
    const repo = makeRepo({
      "msgs/es-US/app.json": {
        ...ES_DONE,
        save: "guardar.",
        cancel: "Anular",
        greeting: "Hola {nombre}",
        chart: "Leyenda del gráfico",
      },
    });
    setLock(repo.setup(), "es-US", ["app.chart"], true);
    const transport = new FakeTransport((html) =>
      fakeTranslate(html, { ...WORDS, Legend: "Leyenda" }),
    );
    const result = await review(repo.context(transport), "es-US", true);
    const byId = new Map(result.items.map((i) => [i.id, i]));
    expect(byId.has("app.save")).toBe(false);
    expect(byId.get("app.cancel")).toMatchObject({
      decision: "applied",
      current: "Anular",
      google: "Cancelar",
    });
    expect(byId.get("app.greeting")).toMatchObject({
      decision: "applied-current-broken",
      google: "Hola {name}",
    });
    expect(byId.get("app.baseline")).toMatchObject({
      decision: "kept-domain-term",
      current: "Línea base",
      google: "Base de referencia",
    });
    expect(byId.get("app.chart")).toMatchObject({ decision: "kept-locked" });
    const es = repo.json("msgs/es-US/app.json");
    expect(es).toMatchObject({
      save: "guardar.",
      cancel: "Cancelar",
      greeting: "Hola {name}",
      baseline: "Línea base",
      chart: "Leyenda del gráfico",
    });
    const memory = loadMemory(repo.root, repo.setup().config, "es-US");
    expect(memory.entries.get("app.cancel")?.by).toBe("google");
    expect(memory.entries.get("app.baseline")?.by).toBe("human");
    expect(memory.entries.get("app.chart")?.locked).toBe(true);

    const files = reviewReport(
      result,
      new Map([["app", 11]]),
      new Map([["app.cancel", ["apps/x/test/a.test.ts"]]]),
      { date: "2026-10-20", model: "m", glossary: "g" },
    );
    expect([...files.keys()].sort()).toEqual(["README.md", "app.md"]);
    expect(files.get("README.md")).toContain("| [app](app.md) | 11 | 4 | 2 | 2 |");
    expect(files.get("README.md")).toContain("`app.cancel`: apps/x/test/a.test.ts");
    expect(files.get("app.md")).toContain("- Current: `Anular`");

    const rerun = new FakeTransport();
    await review(repo.context(rerun), "es-US", false);
    expect(rerun.calls).toEqual([]);
  });

  it("writes nothing but the memory with --no-apply, and prices the full review in a dry run", async () => {
    const repo = makeRepo({ "msgs/es-US/app.json": { ...ES_DONE, cancel: "Anular" } });
    const dry = await review(repo.context(), "es-US", true);
    expect(dry.dryRun).toBe(true);
    expect(dry.cost.misses).toBeGreaterThan(0);
    const result = await review(repo.context(new FakeTransport()), "es-US", false);
    expect(result.items.find((i) => i.id === "app.cancel")?.decision).toBe("applied");
    expect(repo.json("msgs/es-US/app.json")["cancel"]).toBe("Anular");
    expect(loadMemory(repo.root, repo.setup().config, "es-US").entries.has("app.cancel")).toBe(
      false,
    );
  });

  it("compares markdown line by line", async () => {
    const repo = makeRepo({
      "msgs/es-US/app.json": ES_DONE,
      "help/en-US/intro.md":
        "---\ntitle: Intro\nsummary: Start here.\n---\n\nOpen Atlas.\n\nSave\n",
      "help/es-US/intro.md":
        "---\ntitle: Introducción\nsummary: Empieza aquí.\n---\n\nAbre Atlas.\n\nGuarda\n",
    });
    const result = await review(repo.context(new FakeTransport()), "es-US", true);
    expect(result.items.find((i) => i.id === "help/intro.md")).toMatchObject({
      decision: "applied",
      lines: [["Save", "Guarda", "Guardar"]],
    });
    expect(repo.read("help/es-US/intro.md")).toContain("\nGuardar\n");
  });
});
