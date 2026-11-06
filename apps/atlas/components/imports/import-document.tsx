"use client";

import { createAuroraClient, type AuroraSuggestion } from "@xos/ai/client";
import { Button, InlineAlert, Input } from "@xos/ui";
import { useMemo, useState } from "react";
import { usePlatformT } from "@/components/platform/kit";

interface Row {
  readonly id: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly sku: string;
}

const MAX_BYTES = 10 * 1024 * 1024;

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function valueOf(s: AuroraSuggestion, path: string): string {
  const field = s.proposed_fields.find((f) => f.field_path === path);
  if (!field || field.refusal !== null || field.proposed_value === null) return "";
  return String(field.proposed_value);
}

/** Tab-separated rows the paste path reads; a tab or line end inside a cell becomes a space. */
export function rowsToPaste(rows: readonly Omit<Row, "id">[]): string {
  const clean = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim();
  return [
    "description\tquantity\tunit_basis\tvendor_sku",
    ...rows.map((r) => [r.description, r.quantity, r.unit, r.sku].map(clean).join("\t")),
  ].join("\n");
}

/**
 * Document as an import's source (B11, G-106): Aurora reads the file the person picks into proposed lines, with an
 * unstated quantity left empty rather than guessed. The person corrects them and continues to the paste path, so the
 * worker never reads a PDF and nothing is written until they confirm. The suggestions close when the pasted import is
 * created. Loaded the first time someone picks Document, only while extraction is on.
 */
export function ImportDocument({
  onContinue,
}: {
  onContinue: (text: string, suggestionIds: readonly string[]) => void;
}) {
  const t = usePlatformT();
  const client = useMemo(() => createAuroraClient({ baseUrl: "/api/v1" }), []);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const change = (id: string, patch: Partial<Row>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const read = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem(t("imports.document.tooLarge"));
      return;
    }
    setProblem(null);
    setRunning(true);
    const result = await client.extract({
      kind: "material_list",
      media_type: "application/pdf",
      content_base64: await toBase64(file),
      file_name: file.name,
    });
    if (!result.ok || result.data.outcome !== "answer") {
      setRunning(false);
      setProblem(t("imports.document.failed"));
      return;
    }
    const loaded = await Promise.all(
      result.data.suggestions.map((s) => client.suggestion(s.suggestion_id)),
    );
    setRunning(false);
    setRows(
      loaded.flatMap((r) =>
        r.ok
          ? [
              {
                id: r.data.id,
                description: valueOf(r.data, "description"),
                quantity: valueOf(r.data, "quantity"),
                unit: valueOf(r.data, "unit_basis"),
                sku: valueOf(r.data, "vendor_sku"),
              },
            ]
          : [],
      ),
    );
  };
  const missing = rows.some((r) => r.quantity.trim() === "" || r.description.trim() === "");
  return (
    <div className="flex flex-col gap-12">
      <p className="m-0 text-text-13 text-text-secondary">{t("imports.document.intro")}</p>
      <Input
        id="import-document-file"
        type="file"
        accept="application/pdf"
        label={t("imports.document.file")}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <div>
        <Button variant="secondary" loading={running} disabled={!file} onClick={() => void read()}>
          {t("imports.document.read")}
        </Button>
      </div>
      <div aria-live="polite">
        {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}
      </div>
      {rows.length > 0 ? (
        <>
          <p className="m-0 text-text-13">{t("imports.document.review", { count: rows.length })}</p>
          {rows.map((r, i) => (
            <fieldset key={r.id} className="m-0 flex flex-wrap gap-8 border-0 p-0">
              <legend className="sr-only">{t("imports.document.row", { n: i + 1 })}</legend>
              <Input
                id={`doc-desc-${r.id}`}
                label={t("imports.document.description")}
                value={r.description}
                onChange={(e) => change(r.id, { description: e.target.value })}
              />
              <Input
                id={`doc-qty-${r.id}`}
                inputMode="decimal"
                label={t("imports.document.quantity")}
                value={r.quantity}
                {...(r.quantity === "" ? { help: t("imports.document.noQuantity") } : {})}
                onChange={(e) => change(r.id, { quantity: e.target.value })}
              />
              <Input
                id={`doc-unit-${r.id}`}
                label={t("imports.document.unit")}
                value={r.unit}
                onChange={(e) => change(r.id, { unit: e.target.value })}
              />
              <Input
                id={`doc-sku-${r.id}`}
                label={t("imports.document.sku")}
                value={r.sku}
                onChange={(e) => change(r.id, { sku: e.target.value })}
              />
            </fieldset>
          ))}
          <div>
            <Button
              variant="secondary"
              disabled={missing}
              onClick={() => onContinue(rowsToPaste(rows), rows.map((r) => r.id))}
            >
              {t("imports.document.continue")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
