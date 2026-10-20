/**
 * Compass store release preflight (RRR-113). Runs before every store command in package.json and refuses
 * while a value that needs an Apple, Google or Expo account is still an owner value (an `OWNER_` token) in
 * eas.json or store/store.config.json. It reads only files in the repository; it never signs in anywhere.
 *
 *   node --experimental-strip-types scripts/store-preflight.ts ios|android|metadata
 *
 * ios       the TestFlight submission (eas.json submit.production.ios)
 * android   the Play internal track submission (eas.json submit.production.android)
 * metadata  the App Store listing pushed with `eas metadata:push` (store/store.config.json)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TARGETS = ["ios", "android", "metadata"] as const;
export type Target = (typeof TARGETS)[number];

/** How every value that waits on the owner's accounts is spelled in the repository. */
export const OWNER_VALUE = /\bOWNER_[A-Z0-9_]+\b/;
const OWNER_VALUES = new RegExp(OWNER_VALUE.source, "g");

const ASC_APP_ID = /^\d{1,30}$/;
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;

export interface PreflightInput {
  readonly easJson: unknown;
  readonly storeConfig: unknown;
  readonly appVersion: string;
  /** Whether a path from eas.json, relative to apps/compass, names an existing file. */
  readonly fileExists: (path: string) => boolean;
}

type Json = Record<string, unknown>;

function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node !== null && typeof node === "object" ? (node as Json)[key] : undefined),
    value,
  );
}

/** Every owner value left in a JSON document, as `path: TOKEN`. */
export function ownerValues(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(OWNER_VALUES)].map((m) => `${path || "(root)"}: ${m[0]}`);
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => ownerValues(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Json).flatMap(([k, v]) =>
      ownerValues(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

/** What blocks the store command for a target; empty when it may run. */
export function preflightProblems(target: Target, input: PreflightInput): string[] {
  const problems: string[] = [];
  if (target === "ios") {
    const ios = at(input.easJson, "submit", "production", "ios");
    problems.push(...ownerValues(ios, "eas.json submit.production.ios"));
    const ascAppId = at(ios, "ascAppId");
    if (typeof ascAppId !== "string" || !ASC_APP_ID.test(ascAppId)) {
      problems.push(
        "eas.json submit.production.ios.ascAppId must be the numeric Apple ID of the App Store Connect app",
      );
    }
    const teamId = at(ios, "appleTeamId");
    if (teamId !== undefined && (typeof teamId !== "string" || !APPLE_TEAM_ID.test(teamId))) {
      problems.push(
        "eas.json submit.production.ios.appleTeamId must be the 10-character Apple team id, or be removed",
      );
    }
  }
  if (target === "android") {
    const android = at(input.easJson, "submit", "production", "android");
    problems.push(...ownerValues(android, "eas.json submit.production.android"));
    const keyPath = at(android, "serviceAccountKeyPath");
    // Without a path, EAS uses the Google service account key uploaded with `eas credentials`.
    if (typeof keyPath === "string" && !OWNER_VALUE.test(keyPath) && !input.fileExists(keyPath)) {
      problems.push(`the Google service account key ${keyPath} does not exist`);
    }
    if (at(android, "track") !== "internal") {
      problems.push(
        "eas.json submit.production.android.track must stay internal; promoting is an owner stop point",
      );
    }
  }
  if (target === "metadata") {
    problems.push(...ownerValues(input.storeConfig, "store/store.config.json"));
    const version = at(input.storeConfig, "apple", "version");
    if (version !== input.appVersion) {
      problems.push(
        `store/store.config.json apple.version (${String(version)}) must equal app.json expo.version (${input.appVersion})`,
      );
    }
    if (at(input.storeConfig, "apple", "release", "automaticRelease") !== false) {
      problems.push(
        "store/store.config.json apple.release.automaticRelease must stay false; releasing is an owner stop point",
      );
    }
  }
  return problems;
}

function main(argv: readonly string[]): number {
  const target = argv[2] as Target | undefined;
  if (!target || !(TARGETS as readonly string[]).includes(target)) {
    console.error(`Usage: store-preflight.ts ${TARGETS.join("|")}`);
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8")) as unknown;
  const problems = preflightProblems(target, {
    easJson: read("eas.json"),
    storeConfig: read("store/store.config.json"),
    appVersion: String(at(read("app.json"), "expo", "version")),
    fileExists: (path) => existsSync(isAbsolute(path) ? path : resolve(root, path)),
  });
  if (problems.length === 0) {
    console.log(`Compass ${target} preflight passed.`);
    return 0;
  }
  console.error(
    `Compass ${target} preflight failed; fill these in first (apps/compass/store/README.md):`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
