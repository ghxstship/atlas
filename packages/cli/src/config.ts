/**
 * Profiles. An API key is bound to one organization (ADR 0007), so selecting an organization
 * means selecting the profile that holds its key. The file lives at
 * `$XOS_CONFIG_DIR/config.json`, else `$XDG_CONFIG_HOME/xos/config.json`, else
 * `~/.config/xos/config.json`, and is written with mode 0600.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./io.ts";

export interface Profile {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly personId: string | null;
  readonly organizationId: string | null;
}

export interface Config {
  readonly defaultProfile: string | null;
  readonly profiles: Readonly<Record<string, Profile>>;
}

const EMPTY: Config = { defaultProfile: null, profiles: {} };
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function configPath(env: Readonly<Record<string, string | undefined>>): string {
  if (env["XOS_CONFIG_DIR"]) return join(env["XOS_CONFIG_DIR"], "config.json");
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(base, "xos", "config.json");
}

export function readConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Config>;
  return { defaultProfile: parsed.defaultProfile ?? null, profiles: parsed.profiles ?? {} };
}

export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new UsageError(
      `Profile names use letters, digits, ".", "_" and "-", starting with a letter or digit; got "${name}".`,
    );
  }
}

export interface ResolvedCredentials {
  readonly profileName: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * Credentials for a command: `XOS_API_KEY` and `XOS_BASE_URL` override the profile, so CI can
 * run without a config file.
 */
export function resolveCredentials(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
  flags: { readonly profile?: string | undefined; readonly baseUrl?: string | undefined },
): ResolvedCredentials {
  const name = flags.profile ?? env["XOS_PROFILE"] ?? config.defaultProfile;
  const profile = name ? config.profiles[name] : undefined;
  if (flags.profile && !profile) {
    throw new UsageError(
      `No profile named "${flags.profile}". Run \`xos auth login --profile ${flags.profile}\` first.`,
    );
  }
  const apiKey = env["XOS_API_KEY"] ?? profile?.apiKey;
  const baseUrl = flags.baseUrl ?? env["XOS_BASE_URL"] ?? profile?.baseUrl;
  if (!apiKey || !baseUrl) {
    throw new UsageError(
      "Not signed in. Run `xos auth login`, or set XOS_API_KEY and XOS_BASE_URL.",
    );
  }
  return { profileName: profile ? (name as string) : null, baseUrl, apiKey };
}
