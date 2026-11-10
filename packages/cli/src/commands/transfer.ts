/**
 * Import and export.
 *
 *   xos export <resource> [--format ndjson|json|csv] [--out FILE] [--filter ...] [--fields] [--sort]
 *   xos export job create --data JSON | xos export job status <id>
 *   xos import <resource> --file FILE [--dry-run] [--stop-on-error] [--key-prefix P]
 *   xos import job create --data JSON
 *   xos import job dry-run <id> | commit <id> | status <id>
 *   xos import undo <batch-id>
 *
 * Row imports call `<resource>.create` with an Idempotency-Key derived from the file and the
 * row, so rerunning the same import after a failure never creates a row twice.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { OperationSpec } from "@ghxstship/xos-sdk";
import { OPERATIONS, XosApiError } from "@ghxstship/xos-sdk";
import { findOperation, parseData, parseFilters } from "../args.ts";
import type { Context } from "../context.ts";
import type { Row } from "../csv.ts";
import { formatCsv, parseRows } from "../csv.ts";
import { UsageError } from "../io.ts";
import { render } from "../output.ts";

type Format = "ndjson" | "json" | "csv";

function exportFormat(value: string | undefined): Format {
  const f = value ?? "ndjson";
  if (f !== "ndjson" && f !== "json" && f !== "csv")
    throw new UsageError(`--format takes ndjson, json or csv; got "${f}".`);
  return f;
}

export async function exportCommand(ctx: Context, argv: readonly string[]): Promise<number> {
  if (argv[0] === "job") return exportJob(ctx, argv.slice(1));
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      format: { type: "string" },
      out: { type: "string" },
      filter: { type: "string", multiple: true },
      fields: { type: "string" },
      sort: { type: "string" },
    },
  });
  const resource = positionals[0];
  if (!resource)
    throw new UsageError("Name the resource to export: `xos export projects --format csv`.");
  const spec = findOperation(resource, "list");
  const format = exportFormat(values.format);
  const query = {
    limit: 200,
    ...(values.filter?.length ? { filter: parseFilters(values.filter) } : {}),
    ...(values.fields ? { fields: values.fields } : {}),
    ...(values.sort ? { sort: values.sort } : {}),
  };
  const rows: Row[] = [];
  for await (const row of ctx.client().paginate<Row>(spec, { query })) rows.push(row);
  const text =
    format === "csv"
      ? formatCsv(
          rows,
          values.fields ? [...new Set(["id", ...values.fields.split(",")])] : undefined,
        )
      : format === "json"
        ? `${JSON.stringify(rows, null, 2)}\n`
        : rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  if (values.out) {
    writeFileSync(values.out, text);
    ctx.io.stderr(`Exported ${rows.length} ${spec.resource} row(s) to ${values.out}.\n`);
  } else {
    ctx.io.stdout(text);
  }
  return 0;
}

/**
 * The body of a server job comes from `--data`, validated by the API against the current
 * contract, so the CLI never pins a job shape the contract may correct (ADR 0023).
 */
async function jobBody(
  ctx: Context,
  argv: readonly string[],
  kind: "import" | "export",
): Promise<unknown> {
  const { values } = parseArgs({ args: [...argv], options: { data: { type: "string" } } });
  const body = await parseData(values.data, ctx.io);
  if (body === undefined) {
    const schema = kind === "import" ? "ImportJobCreate" : "ExportJobCreate";
    throw new UsageError(
      `\`xos ${kind} job create\` needs --data with a ${schema} body; run \`xos ops ${kind}-jobs\` for the operation.`,
    );
  }
  return body;
}

async function exportJob(ctx: Context, argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  const client = ctx.client();
  if (action === "create") {
    const body = await jobBody(ctx, rest, "export");
    render(
      ctx.io,
      ctx.format,
      (await client.request(OPERATIONS["exportJobs.create"], { body })).data,
    );
    return 0;
  }
  if (action === "status") {
    if (!rest[0]) throw new UsageError("Name the export job: `xos export job status <id>`.");
    render(ctx.io, ctx.format, (await client.exportJobs.get(rest[0])).data);
    return 0;
  }
  throw new UsageError("Use `xos export job create` or `xos export job status <id>`.");
}

/** Deterministic key for one row of one file: the same row always replays, never duplicates. */
export function rowIdempotencyKey(prefix: string, file: string, index: number, row: Row): string {
  const digest = createHash("sha256")
    .update(`${prefix}\n${file}\n${index}\n${JSON.stringify(row)}`)
    .digest("hex");
  return `xos-import-${digest.slice(0, 48)}`;
}

export async function importCommand(ctx: Context, argv: readonly string[]): Promise<number> {
  if (argv[0] === "job") return importJob(ctx, argv.slice(1));
  if (argv[0] === "undo") {
    if (!argv[1]) throw new UsageError("Name the import batch: `xos import undo <batch-id>`.");
    render(ctx.io, ctx.format, (await ctx.client().importBatches.undo(argv[1])).data);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "stop-on-error": { type: "boolean", default: false },
      "key-prefix": { type: "string", default: "" },
    },
  });
  const resource = positionals[0];
  if (!resource || !values.file)
    throw new UsageError("Usage: `xos import <resource> --file rows.csv|rows.ndjson|rows.json`.");
  const spec: OperationSpec = findOperation(resource, "create");
  let rows: Row[];
  try {
    rows = parseRows(readFileSync(values.file, "utf8"), values.file);
  } catch (error) {
    throw new UsageError(`Could not read ${values.file}: ${(error as Error).message}`);
  }
  if (values["dry-run"]) {
    ctx.io.stderr(
      `Dry run: ${rows.length} row(s) would be sent to ${spec.id}; nothing was written.\n`,
    );
    render(ctx.io, ctx.format, rows);
    return 0;
  }
  const client = ctx.client();
  const file = basename(values.file);
  const results: { row: number; status: string; id: unknown; detail: string }[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const response = await client.request<Row>(
        spec,
        { body: row },
        {
          idempotencyKey: rowIdempotencyKey(values["key-prefix"], file, index, row),
        },
      );
      const replayed = response.headers.get("Idempotent-Replayed") === "true";
      results.push({
        row: index + 1,
        status: replayed ? "already imported" : "created",
        id: response.data["id"] ?? null,
        detail: "",
      });
    } catch (error) {
      if (!(error instanceof XosApiError)) throw error;
      const pointers = (error.problem.errors ?? [])
        .map((e) => `${e.pointer} ${e.detail}`)
        .join("; ");
      const detail =
        error.problem.reason ?? (pointers || error.problem.detail || error.problem.title);
      results.push({ row: index + 1, status: `failed ${error.status}`, id: null, detail });
      if (values["stop-on-error"]) break;
    }
  }
  const failed = results.filter((r) => r.status.startsWith("failed")).length;
  render(ctx.io, ctx.format, results, "row,status,id,detail");
  ctx.io.stderr(
    `${results.length - failed} of ${rows.length} row(s) imported into ${spec.resource}` +
      (failed
        ? `; ${failed} failed. Fix those rows and rerun: imported rows are not created twice.\n`
        : ".\n"),
  );
  return failed ? 1 : 0;
}

async function importJob(ctx: Context, argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  const client = ctx.client();
  switch (action) {
    case "create": {
      const body = await jobBody(ctx, rest, "import");
      const job = await client.request(OPERATIONS["importJobs.create"], { body });
      render(ctx.io, ctx.format, job.data);
      return 0;
    }
    case "dry-run":
    case "commit":
    case "status": {
      const id = rest[0];
      if (!id) throw new UsageError(`Name the import job: \`xos import job ${action} <id>\`.`);
      const result =
        action === "status"
          ? await client.importJobs.get(id)
          : action === "commit"
            ? await client.importJobs.commit(id)
            : await client.importJobs.dryRun(id);
      render(ctx.io, ctx.format, result.data);
      return 0;
    }
    default:
      throw new UsageError(
        "Use `xos import job create`, `dry-run <id>`, `commit <id>` or `status <id>`.",
      );
  }
}
