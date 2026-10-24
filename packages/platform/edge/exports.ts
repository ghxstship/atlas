/**
 * The export.render worker for the Edge bundle (A102, RRR-146; migration 1680). The worker lives with
 * the report renderers in @xos/data (export-renders.ts, report-files.ts), so an export's PDF prints as a
 * report's does; this file re-exports it and adds the file copy from @xos/i18n. Only the reporting
 * namespace is read, and each locale's copy loads the first time a file asks for that locale (A85).
 */
import { defaultLocale, isLaunchLocale, type LaunchLocale } from "@xos/i18n/locales";
import type { ExportCopy } from "../../data/src/export-renders.ts";

export {
  EXPORT_FILES_BUCKET,
  EXPORT_RENDER_JOB,
  runExportRenders,
  supabaseExportFiles,
  supabaseExportRenderStore,
  type ExportCopy,
  type ExportRenderResult,
} from "../../data/src/export-renders.ts";

export { READ_REPLICA_ENV, readReplicaUrl } from "../../data/src/read-replica.ts";

type Tree = { readonly [key: string]: Tree | string };

/** The reporting namespace of each launch locale, loaded on first use; a Beta locale reads en-US (ADR 0053). */
const namespaces: Readonly<Record<LaunchLocale, () => Promise<Tree>>> = {
  "en-US": async () =>
    (await import("@xos/i18n/messages/en-US/reporting.json", { with: { type: "json" } })).default,
  "es-US": async () =>
    (await import("@xos/i18n/messages/es-US/reporting.json", { with: { type: "json" } })).default,
};

function lookup(tree: Tree, path: readonly string[]): string | null {
  let node: Tree | string | undefined = tree;
  for (const part of path) {
    if (typeof node !== "object" || node === null) return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

/** Fills the `{name}` slots of a catalog template with their values. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    values[name] === undefined ? all : String(values[name]),
  );
}

/** The watermark's time: date, time and zone name (dateStyle and timeStyle cannot name the zone). */
const STAMP: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/** A time zone Intl knows, else UTC: a stored setting from another runtime never breaks a file. */
function zone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The copy of an export file in a locale (en-US when unknown), with times in the requester's zone. */
export async function exportFileCopy(locale: string): Promise<ExportCopy> {
  const known = isLaunchLocale(locale) ? locale : defaultLocale;
  const messages = await namespaces[known]();
  const file = (key: string) => lookup(messages, ["exportFile", key]) ?? key;
  const number = new Intl.NumberFormat(known);
  const date = (at: Date, timeZone: string) =>
    new Intl.DateTimeFormat(known, { dateStyle: "medium", timeZone: zone(timeZone) }).format(at);
  const time = (at: Date, timeZone: string) =>
    new Intl.DateTimeFormat(known, { ...STAMP, timeZone: zone(timeZone) }).format(at);
  return {
    subtitle: ({ rows, at, timeZone }) =>
      fill(file("subtitle"), { rows: number.format(rows), date: date(at, timeZone) }),
    truncated: ({ limit }) => fill(file("truncated"), { limit: number.format(limit) }),
    watermark: ({ email, at, timeZone }) =>
      fill(file("watermark"), { email, time: time(at, timeZone) }),
  };
}
