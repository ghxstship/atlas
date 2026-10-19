import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentTranslator, formatter } from "../../src/documents/format.ts";
import { buildDocumentModel, documentFileName } from "../../src/documents/generate.ts";
import {
  DOCUMENT_KINDS,
  isDocumentKind,
  isPaper,
  type DocumentKind,
} from "../../src/documents/model.ts";
import {
  DESCRIBE,
  TEMPLATES,
  keyOf,
  templateFor,
  type TemplateRegistry,
  type TemplateVersion,
} from "../../src/documents/templates.ts";
import { BRAND, FIXTURES, NOW } from "./fixtures.ts";

const messages = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/${locale}/documents.json`, import.meta.url),
      "utf8",
    ),
  );
/** Intl separates the currency code with a no-break space. */
const sp = (s: string | undefined) => (s ?? "").replace(/\u00a0/g, " ");

const EN = messages("en-US");
const ES = messages("es-US");

const build = <K extends DocumentKind>(kind: K, locale = "en-US", registry?: TemplateRegistry) =>
  buildDocumentModel(kind, FIXTURES[kind], {
    locale,
    messages: locale === "en-US" ? EN : ES,
    brand: BRAND,
    recordUrl: "https://atlas.example.test/r",
    now: NOW,
    ...(registry ? { registry } : {}),
  });

/** Every string a model shows the reader, flattened. */
function strings(model: ReturnType<typeof build>): string[] {
  const out = [
    model.title,
    ...Object.values(model.facts.labels).filter((v) => typeof v === "string"),
  ];
  out.push(model.facts.labels.page(1, 2));
  for (const b of model.blocks) {
    if (b.kind === "heading" || b.kind === "paragraph") out.push(b.text);
    if (b.kind === "fields") out.push(b.caption, ...b.fields.flatMap((f) => [f.label, f.value]));
    if (b.kind === "table") {
      out.push(b.caption, b.empty, ...b.columns.map((c) => c.label));
      out.push(...b.rows.flat(), ...(b.footer ?? []).flat());
    }
  }
  return out;
}

const version = (n: number, effectiveFrom: string): TemplateVersion<"purchase-order"> => ({
  version: n,
  effectiveFrom,
  build: () => ({ title: `v${n}`, blocks: [] }),
});

describe("template versions", () => {
  const versions = [
    version(2, "2026-06-01T00:00:00Z"),
    version(1, "2026-01-01T00:00:00Z"),
    version(3, "2027-01-01T00:00:00Z"),
  ];

  it("picks the version in force when the record was issued", () => {
    expect(templateFor(versions, "2026-03-01T00:00:00Z").version).toBe(1);
    expect(templateFor(versions, "2026-06-01T00:00:00Z").version).toBe(2);
    expect(templateFor(versions, "2026-12-31T23:59:59Z").version).toBe(2);
    expect(templateFor(versions, "2027-02-01T00:00:00Z").version).toBe(3);
  });

  it("uses the first version for a record issued before any template", () => {
    expect(templateFor(versions, "2020-01-01T00:00:00Z").version).toBe(1);
  });

  it("uses the latest version when the issue time is unreadable", () => {
    expect(templateFor(versions, "not a date").version).toBe(3);
  });

  it("refuses a kind with no versions", () => {
    expect(() => templateFor([], "2026-01-01T00:00:00Z")).toThrow(/at least one/);
  });

  it("re-renders an old record with the version it was issued with", () => {
    const registry = {
      ...TEMPLATES,
      "purchase-order": [version(1, "2026-01-01T00:00:00Z"), version(2, "2026-10-01T00:00:00Z")],
    } as TemplateRegistry;
    // The fixture order was created 2026-09-02, before version 2 took effect.
    const old = build("purchase-order", "en-US", registry);
    expect(old.facts.templateVersion).toBe(1);
    expect(old.title).toBe("v1");
    const fresh = buildDocumentModel(
      "purchase-order",
      {
        ...FIXTURES["purchase-order"],
        order: { ...FIXTURES["purchase-order"].order, createdAt: "2026-10-10T00:00:00Z" },
      },
      { locale: "en-US", messages: EN, brand: BRAND, recordUrl: "u", now: NOW, registry },
    );
    expect(fresh.facts.templateVersion).toBe(2);
  });

  it("ships at least version 1 of every Section 11.9 document", () => {
    expect(DOCUMENT_KINDS).toHaveLength(12);
    for (const kind of DOCUMENT_KINDS) {
      expect(TEMPLATES[kind].map((v) => v.version)).toContain(1);
      const numbers = TEMPLATES[kind].map((v) => v.version);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });
});

describe("every template", () => {
  it.each(
    DOCUMENT_KINDS.flatMap(
      (k) =>
        [
          [k, "en-US"],
          [k, "es-US"],
        ] as const,
    ),
  )("%s in %s resolves every catalog key and shows the record facts", (kind, locale) => {
    const model = build(kind, locale);
    expect(model.lang).toBe(locale);
    expect(model.kind).toBe(kind);
    expect(model.facts.recordKey.length).toBeGreaterThan(0);
    expect(model.facts.templateVersion).toBe(1);
    expect(model.facts.generatedAtIso).toBe(NOW.toISOString());
    expect(model.facts.labels.qrAlt).toContain(model.facts.recordKey);
    for (const s of strings(model)) {
      expect(s, `${kind} ${locale}`).not.toMatch(
        /^(common|facts|purchaseOrder|invoice|changeOrder|daySheet|callSheet|runOfShow|beo|credentialBadge|inspectionReport|incidentReport|finalCostReport|agreementCertificate)\./,
      );
    }
  });
});

describe("data mapping", () => {
  it("names each record and its issue time from the record", () => {
    const d = (kind: DocumentKind) => DESCRIBE[kind](FIXTURES[kind] as never, NOW);
    expect(d("purchase-order")).toEqual({
      recordKey: "NWF26-PO12",
      issuedAt: "2026-09-02T14:00:00Z",
    });
    expect(d("invoice")).toEqual({ recordKey: "INV-2026-0042", issuedAt: "2026-10-01T00:00:00Z" });
    expect(d("change-order").recordKey).toBe("NWF26-CO3");
    expect(d("day-sheet")).toEqual({
      recordKey: "NWF26-DS-2026-10-24",
      issuedAt: "2026-10-23T20:00:00Z",
    });
    expect(d("call-sheet").issuedAt).toBe("2026-10-22T19:00:00Z");
    expect(d("run-of-show").issuedAt).toBe("2026-10-24T00:00:00Z");
    expect(d("beo").issuedAt).toBe("2026-10-20T15:00:00Z");
    expect(d("credential-badge").recordKey).toBe("NWF26-AAA-0042");
    expect(d("inspection-report").issuedAt).toBe("2026-10-23T16:00:00Z");
    expect(d("incident-report").recordKey).toBe("NWF26-4");
    expect(d("final-cost-report")).toEqual({ recordKey: "NWF26-FCR", issuedAt: NOW.toISOString() });
    expect(d("agreement-certificate").issuedAt).toBe("2026-09-20T18:12:00Z");
  });

  it("falls back for unnumbered invoices and drafts", () => {
    const inv = FIXTURES.invoice;
    const unnumbered = DESCRIBE.invoice(
      { ...inv, invoice: { ...inv.invoice, number: null, issuedOn: null } },
      NOW,
    );
    expect(unnumbered).toEqual({
      recordKey: "NWF26-INV-20000000",
      issuedAt: inv.invoice.createdAt,
    });
    const agreement = FIXTURES["agreement-certificate"];
    expect(DESCRIBE["agreement-certificate"]({ ...agreement, project: null }, NOW).recordKey).toBe(
      "AGR-AGR-b0000000",
    );
  });

  it("keeps money NULL-aware: an unpriced total reads Unpriced, never zero", () => {
    const model = build("purchase-order");
    const lines = model.blocks.find((b) => b.kind === "table");
    expect(lines?.kind).toBe("table");
    if (lines?.kind !== "table") return;
    expect(lines.rows).toHaveLength(40);
    expect(lines.rows[3]?.[3]).toBe("Unpriced");
    expect(sp(lines.rows[0]?.[4])).toBe("USD 2,500.00");
    expect(lines.footer?.[0]?.[4]).toBe("Unpriced");
    expect(sp(lines.footer?.[1]?.[4])).toBe("USD 500.00");
    expect(strings(model).some((s) => s.startsWith("Unpriced lines: 1."))).toBe(true);
  });

  it("formats money and dates in the caller's language", () => {
    const model = build("invoice", "es-US");
    expect(model.title).toBe("Factura INV-2026-0042");
    const s = strings(model);
    expect(s).toContain("Facturado a");
    expect(s).toContain("Contoso Events");
    expect(s.some((x) => x.includes("12,840.00") || x.includes("12.840,00"))).toBe(true);
    expect(s).toContain("Saldo pendiente");
  });

  it("maps inspection results through the canon codes", () => {
    const table = build("inspection-report").blocks.find((b) => b.kind === "table");
    if (table?.kind !== "table") throw new Error("no table");
    expect(table.rows.map((r) => r[3])).toEqual(["Passed", "Failed", "No result yet"]);
    expect(table.rows[1]?.[4]).toBe("Replace the frayed sling.");
    expect(table.rows[0]?.[2]).toBe("Yes");
  });

  it("shows the no-baseline answer instead of zeros on the final cost report", () => {
    const d = FIXTURES["final-cost-report"];
    const model = buildDocumentModel(
      "final-cost-report",
      { ...d, report: { ...d.report, hasBaseline: false } },
      { locale: "en-US", messages: EN, brand: BRAND, recordUrl: "u", now: NOW },
    );
    expect(model.blocks.some((b) => b.kind === "table")).toBe(false);
    expect(strings(model).some((s) => s.includes("no gate 3 baseline"))).toBe(true);
  });

  it("orders the agreement ledger oldest first and keeps the signed text", () => {
    const model = build("agreement-certificate");
    const ledger = model.blocks.find((b) => b.kind === "table");
    if (ledger?.kind !== "table") throw new Error("no ledger");
    expect(ledger.rows.map((r) => r[1])).toEqual(["Proposed to Sent", "Sent to Signed"]);
    expect(model.blocks.at(-1)).toEqual({
      kind: "paragraph",
      text: FIXTURES["agreement-certificate"].agreement.body,
    });
  });

  it("reports call sheet gaps and cue progress", () => {
    const calls = build("call-sheet").blocks.find((b) => b.kind === "table");
    if (calls?.kind !== "table") throw new Error("no calls");
    expect(calls.rows[1]?.[2]).toBe("None");
    expect(calls.rows[1]?.[3]).toBe("Not filled");
    expect(strings(build("run-of-show"))).toContain("1 of 3 cues called");
    expect(strings(build("day-sheet"))).not.toContain("Draft, not published");
    expect(strings(build("call-sheet"))).toContain("Draft, not published");
  });
});

describe("helpers", () => {
  it("recognizes kinds and papers", () => {
    expect(isDocumentKind("beo")).toBe(true);
    expect(isDocumentKind("memo")).toBe(false);
    expect(isPaper("a4")).toBe(true);
    expect(isPaper("legal")).toBe(false);
  });

  it("builds catalog key segments and safe file names", () => {
    expect(keyOf("Offer Letter")).toBe("OfferLetter");
    expect(keyOf("INSP_PASSED")).toBe("INSPPASSED");
    expect(documentFileName("purchase-order", "NWF26 PO/12", "a4")).toBe(
      "purchase-order-NWF26-PO-12-a4.pdf",
    );
    expect(documentFileName("beo", "***", "letter")).toBe("beo-document-letter.pdf");
  });

  it("translates with arguments and returns missing keys as is", () => {
    const t = documentTranslator({ a: { b: "Hi {name}, {other}" } });
    expect(t("a.b", { name: "Ana" })).toBe("Hi Ana, {other}");
    expect(t("a.missing")).toBe("a.missing");
    expect(documentTranslator(null)("x")).toBe("x");
  });

  it("formats durations, empty values and unknown zones", () => {
    const t = documentTranslator(EN);
    const f = formatter("en-US", "Not/AZone", t);
    expect(f.timeZone).toBe("UTC");
    expect(f.duration(5400)).toBe("1:30:00");
    expect(f.duration(65)).toBe("1:05");
    expect(f.duration(null)).toBe("None");
    expect(f.day(null)).toBe("None");
    expect(f.day("garbage")).toBe("garbage");
    expect(f.dateTime("garbage")).toBe("garbage");
    expect(f.time(null)).toBe("None");
    expect(f.time("garbage")).toBe("garbage");
    expect(sp(f.money(150, "JPY"))).toBe("JPY 150");
    expect(f.money(150, "ZZ")).toBe("1.50 ZZ");
  });
});
