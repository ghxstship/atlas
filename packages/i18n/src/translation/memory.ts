/**
 * The translation memory, one committed file per target locale (translation/memory/<locale>.json).
 *
 * - `entries`: for every translated key or file, who produced the current target, the hash of the
 *   en-US source it was produced from, and whether a person locked it. Written as
 *   "<by> <source hash>" or "<by> <source hash> locked", where <by> is google, human or fallback
 *   (fallback: the en-US text was copied because translation failed; the next run retries it).
 * - `segments`: Google's output for every masked segment, keyed "<engine>:<segment hash>". The
 *   engine version covers the model and the glossary version, and the file is per target locale, so
 *   the cache is keyed by source text, target locale and glossary version. A run calls the API only
 *   for segments missing here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PipelineConfig } from "./config.ts";

export type Producer = "google" | "human" | "fallback";

export interface Entry {
  readonly by: Producer;
  readonly source: string;
  readonly locked: boolean;
}

export interface Memory {
  readonly locale: string;
  readonly entries: Map<string, Entry>;
  readonly segments: Map<string, string>;
}

export type Status = "missing" | "stale" | "unreviewed" | "current" | "locked" | "locked-stale";

const COMMENT =
  "Written by the @xos/i18n translation pipeline (ADR 0037). entries: key or surface/file -> '<google|human|fallback> <en-US source hash>[ locked]'. segments: '<engine>:<segment hash>' -> Google's output. Lock a string with `pnpm --filter @xos/i18n translate:lock <key>`.";

export function encodeEntry(entry: Entry): string {
  return `${entry.by} ${entry.source}${entry.locked ? " locked" : ""}`;
}

export function decodeEntry(value: string): Entry {
  const [by = "", source = "", flag] = value.split(" ");
  if (
    (by !== "google" && by !== "human" && by !== "fallback") ||
    !/^[0-9a-f]{16}$/.test(source) ||
    (flag !== undefined && flag !== "locked")
  ) {
    throw new Error(`Bad translation memory entry "${value}".`);
  }
  return { by, source, locked: flag === "locked" };
}

export function memoryPath(root: string, config: PipelineConfig, locale: string): string {
  return join(root, config.memoryDir, `${locale}.json`);
}

export function emptyMemory(locale: string): Memory {
  return { locale, entries: new Map(), segments: new Map() };
}

export function loadMemory(root: string, config: PipelineConfig, locale: string): Memory {
  const file = memoryPath(root, config, locale);
  if (!existsSync(file)) return emptyMemory(locale);
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    locale?: string;
    entries?: Record<string, string>;
    segments?: Record<string, string>;
  };
  if (raw.locale !== locale)
    throw new Error(`${file} is for ${raw.locale ?? "no locale"}, not ${locale}.`);
  return {
    locale,
    entries: new Map(Object.entries(raw.entries ?? {}).map(([k, v]) => [k, decodeEntry(v)])),
    segments: new Map(Object.entries(raw.segments ?? {})),
  };
}

const sorted = <V>(map: ReadonlyMap<string, V>, encode: (v: V) => string) =>
  Object.fromEntries([...map.keys()].sort().map((k) => [k, encode(map.get(k) as V)]));

export function serializeMemory(memory: Memory): string {
  const body = {
    $comment: COMMENT,
    locale: memory.locale,
    entries: sorted(memory.entries, encodeEntry),
    segments: sorted(memory.segments, (v) => v),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function saveMemory(root: string, config: PipelineConfig, memory: Memory): string {
  const file = memoryPath(root, config, memory.locale);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeMemory(memory));
  return file;
}

export function statusOf(
  sourceHash: string,
  target: string | undefined,
  entry: Entry | undefined,
): Status {
  if (target === undefined || target === "") return "missing";
  if (!entry) return "unreviewed";
  if (entry.by === "fallback") return "stale";
  if (entry.locked) return entry.source === sourceHash ? "locked" : "locked-stale";
  return entry.source === sourceHash ? "current" : "stale";
}
