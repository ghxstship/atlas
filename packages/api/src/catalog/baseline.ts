/**
 * The frozen v1 baseline (ADR 0014): one SHA-256 digest per operation and per component of the
 * document as frozen at Wave 1 exit (commit 5d269b9, 1,307 operations). `frozen-v1.digest.json`
 * is cut once from that document and never regenerated while v1 is a draft. The Section 18 gate 20
 * test compares the uncorrected frozen catalog with it, then allows only the differences that
 * `catalog/corrections` lists (ADR 0023).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DocumentDigest {
  /** `METHOD /path` to its operationId and the digest of the operation object. */
  readonly operations: Readonly<
    Record<string, { readonly operationId: string; readonly sha256: string }>
  >;
  /** `kind/Name` (for example `schemas/Project`) to the digest of the component. */
  readonly components: Readonly<Record<string, string>>;
}

export const BASELINE_FILE = fileURLToPath(new URL("./frozen-v1.digest.json", import.meta.url));

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface OpenApiLike {
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: Record<string, Record<string, unknown>>;
}

/** The digest of every operation and component of an OpenAPI document. */
export function digestDocument(document: unknown): DocumentDigest {
  const doc = JSON.parse(JSON.stringify(document)) as OpenApiLike;
  const operations: Record<string, { operationId: string; sha256: string }> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as { operationId?: string } | undefined;
      if (op === undefined) continue;
      operations[`${method.toUpperCase()} ${path}`] = {
        operationId: String(op.operationId),
        sha256: sha256(op),
      };
    }
  }
  const components: Record<string, string> = {};
  for (const [kind, entries] of Object.entries(doc.components)) {
    for (const [name, value] of Object.entries(entries))
      components[`${kind}/${name}`] = sha256(value);
  }
  return { operations, components };
}

export function readBaseline(): DocumentDigest {
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as DocumentDigest;
}
