import { describe, expect, it } from "vitest";
import { parseSpans } from "../../src/translation/html.ts";
import {
  PlanError,
  compareStructure,
  literalText,
  planIcu,
  tidy,
} from "../../src/translation/icu.ts";
import { compileProtector } from "../../src/translation/protect.ts";
import { fakeTranslate } from "./fixture.ts";

const EM_DASH = String.fromCharCode(0x2014);
const NBSP = String.fromCharCode(0xa0);
const protector = compileProtector({
  terms: [{ term: "Atlas" }, { term: "Legend", except: ["ui.chart.legend"] }],
  patterns: [{ name: "canon code", pattern: "\\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\\b" }],
});
const none = () => [];
const protect =
  (key = "k") =>
  (text: string) =>
    protector.ranges(text, key);
const roundTrip = (message: string, translate = (h: string) => h) => {
  const plan = planIcu(message, protect());
  return plan.assemble(plan.segments.map((s) => translate(s.html)));
};

describe("planIcu", () => {
  it("freezes simple arguments, numbers and dates and keeps the text around them in one segment", () => {
    const plan = planIcu("Shift {name} starts {when, date, short} with {n, number} people", none);
    expect(plan.segments).toEqual([
      {
        html: 'Shift <span translate="no" id="a1">{name}</span> starts <span translate="no" id="a2">{when, date, short}</span> with <span translate="no" id="a3">{n, number}</span> people',
        translatable: true,
      },
    ]);
  });

  it("translates each plural branch on its own and keeps # and nested arguments frozen", () => {
    const plan = planIcu("{count, plural, one {# file from {org}} other {# files}}", none);
    const html = plan.segments.map((s) => s.html);
    expect(html).toEqual([
      '<span translate="no" id="p2">#</span> file from <span translate="no" id="a3">{org}</span>',
      '<span translate="no" id="p4">#</span> files',
      '<span translate="no" id="c1">{count}</span>',
    ]);
    expect(plan.segments[2]?.translatable).toBe(false);
    expect(plan.assemble(html.map((h) => fakeTranslate(h)))).toBe(
      "{count, plural, one {# archivo de {org}} other {# archivos}}",
    );
  });

  it("reassembles select and selectordinal from the source syntax", () => {
    expect(
      roundTrip("{title} was {decision, select, approved {approved} other {rejected}}", (h) =>
        fakeTranslate(h),
      ),
    ).toBe("{title} fue {decision, select, approved {aprobado} other {rechazado}}");
    const ordinal =
      "{n, selectordinal, one {#st place} two {#nd place} few {#rd place} other {#th place}}";
    expect(roundTrip(ordinal)).toBe(ordinal);
  });

  it("translates the children of rich text tags in place", () => {
    const plan = planIcu("Read the <link>terms</link> and <b>{name}</b>", none);
    expect(plan.segments[0]?.html).toBe(
      'Read the <span id="t1">terms</span> and <span id="t2"><span translate="no" id="a3">{name}</span></span>',
    );
    expect(plan.assemble([fakeTranslate(plan.segments[0]?.html ?? "")])).toBe(
      "Lee los <link>términos</link> and <b>{name}</b>",
    );
  });

  it("freezes protected words and canon codes, honoring a term's exceptions", () => {
    expect(planIcu("Open Atlas for NWL-12", protect()).segments[0]?.html).toBe(
      'Open <span translate="no" id="d1">Atlas</span> for <span translate="no" id="d2">NWL-12</span>',
    );
    expect(planIcu("Legend", protect("ui.chart.legend")).segments[0]?.translatable).toBe(true);
    expect(planIcu("Legend", protect("shell.plans.legend")).segments[0]?.translatable).toBe(false);
  });

  it("round-trips messages unchanged when the transport returns its input", () => {
    for (const message of [
      "Hello {name}",
      "{a}{b}",
      "It's {name}'s turn, isn't it?",
      "Use '{braces}' literally",
      "{count, plural, offset:1 =0 {nobody} one {# person and {name}} other {# people}}",
      "{role, select, lead {<b>{name}</b> leads} other {}}",
      "Press ? for help",
    ]) {
      expect(roundTrip(message), message).toBe(message);
    }
  });

  it("survives a transport that reorders spans, adds spaces and encodes entities", () => {
    const out = roundTrip("{name} uploaded {count, number} files", (h) =>
      h
        .replace(
          /^(<span[^>]*>\{name\}<\/span>) uploaded (<span[^>]*>\{count, number\}<\/span>) files$/,
          "Se subieron  $2 archivos  de $1 .",
        )
        .replace(/archivos/, "archivos&#39;"),
    );
    expect(out).toBe("Se subieron {count, number} archivos' de {name}.");
    expect(compareStructure("{name} uploaded {count, number} files", out, "es-US")).toEqual([]);
  });

  it("refuses a translation that drops, invents or repeats a frozen span", () => {
    const plan = planIcu("Hello {name}", none);
    expect(() => plan.assemble(["Hola"])).toThrow(PlanError);
    expect(() =>
      plan.assemble(['Hola <span id="zz">x</span><span translate="no" id="a1">{name}</span>']),
    ).toThrow(PlanError);
    expect(() => plan.assemble(['<span id="a1">a</span><span id="a1">b</span>'])).toThrow(
      PlanError,
    );
    expect(() => plan.assemble(["<b>Hola</b>"])).toThrow(PlanError);
  });

  it("escapes ICU syntax characters that appear in translated text", () => {
    const plan = planIcu("Price {amount}", none);
    const out = plan.assemble(['Precio {fijo} <span translate="no" id="a1">{amount}</span>']);
    expect(out).toBe("Precio '{fijo}' {amount}");
    expect(compareStructure("Price {amount}", out, "es-US")).toEqual([]);
    const apostrophe = planIcu("Hi {name}", none).assemble([
      'l\'<span translate="no" id="a1">{name}</span>',
    ]);
    expect(compareStructure("Hi {name}", apostrophe, "es-US")).toEqual([]);
  });

  it("keeps a capital first letter when the source has one", () => {
    expect(roundTrip("Save", () => "guardar")).toBe("Guardar");
  });
});

describe("tidy", () => {
  it("replaces em dashes and non-breaking spaces and closes gaps Google leaves at spans", () => {
    expect(tidy(`Compuerta 3 ${EM_DASH} aprobada`)).toBe("Compuerta 3, aprobada");
    expect(tidy(`a${NBSP}b  c`)).toBe("a b c");
    expect(tidy(" .")).toBe(".");
    expect(tidy("Pulsa ? para ayuda")).toBe("Pulsa ? para ayuda");
    expect(tidy("usa .50 a .99")).toBe("usa .50 a .99");
  });
});

describe("compareStructure", () => {
  it("accepts a faithful translation and Spanish plural categories", () => {
    expect(
      compareStructure(
        "{n, plural, one {# day} other {# days}}",
        "{n, plural, one {# día} many {# de días} other {# días}}",
        "es-US",
      ),
    ).toEqual([]);
    expect(
      compareStructure(
        "{n, plural, one {# day} other {# days}}",
        "{n, plural, one {un día} other {# días}}",
        "es-US",
      ),
    ).toEqual([]);
  });

  it("reports changed arguments, select keys, plural shape and tags", () => {
    expect(compareStructure("Hi {name}", "Hola {nombre}", "es-US")).toEqual([
      "{name} is missing",
      "{nombre} is not in the source",
    ]);
    expect(compareStructure("{d, date, short}", "{d, date, long}", "es-US")).toEqual([
      "{d} changed type or style",
    ]);
    expect(
      compareStructure(
        "{x, select, a {A} other {B}}",
        "{x, select, a {A} b {C} other {B}}",
        "es-US",
      ),
    ).toEqual(["select {x} has different keys"]);
    expect(
      compareStructure("{n, plural, =0 {none} other {#}}", "{n, plural, other {#}}", "es-US"),
    ).toEqual(["plural {n} changed its kind, offset or exact keys"]);
    expect(
      compareStructure(
        "{n, plural, one {#} other {#}}",
        "{n, plural, one {#} few {#} other {#}}",
        "es-US",
      ),
    ).toEqual(["plural {n} has categories few that es-US does not use"]);
    expect(() =>
      compareStructure("{n, plural, one {#} other {#}}", "{n, plural, one {#}}", "es-US"),
    ).toThrow("MISSING_OTHER_CLAUSE");
    expect(compareStructure("Read <link>terms</link>", "Lee términos", "es-US")).toEqual([
      "tags differ: <link> and <>",
    ]);
    expect(() => compareStructure("Hi", "{broken", "es-US")).toThrow();
  });
});

describe("literalText and parseSpans", () => {
  it("reads only the literal text of a message", () => {
    expect(literalText("{gate} needs {n, plural, one {# gate} other {# gates}} <b>now</b>")).toBe(
      "needs gate gates now",
    );
  });

  it("parses nested spans and decodes entities", () => {
    expect(
      parseSpans('a &amp; <span id="t1">b <span translate="no" id="a2">{x}</span></span>&#39;'),
    ).toEqual([
      { kind: "text", text: "a & " },
      {
        kind: "span",
        id: "t1",
        children: [
          { kind: "text", text: "b " },
          { kind: "span", id: "a2", children: [{ kind: "text", text: "{x}" }] },
        ],
      },
      { kind: "text", text: "'" },
    ]);
  });
});
